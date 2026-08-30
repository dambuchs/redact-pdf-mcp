/**
 * Streamable-HTTP entry point — the hosted remote server.
 *
 * Deliberately stateless: no sessions, no stored keys, nothing kept between
 * requests. Each request carries its own API key and gets its own short-lived
 * server instance, so one caller's credentials can never leak into another
 * caller's tool call, and the process can be scaled or restarted freely.
 *
 * Built on node:http rather than a framework — the whole job is "parse a JSON
 * body, hand it to the transport", and a dependency-free server is one less
 * thing for a security reviewer to audit.
 *
 * The handler is exported separately from `listen()` so it can be tested
 * without binding a port.
 */

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { pathToFileURL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { DEFAULT_BASE_URL, RedactPdfClient } from './client.js';
import { createServer, VERSION } from './server.js';
import { MAX_PDF_BYTES } from './types.js';

/**
 * Inbound body cap.
 *
 * Sized from the largest legal payload rather than a round number: a 50 MB PDF
 * sent as `file_base64` inflates by 4/3 to ~67 MB, plus JSON-RPC envelope. A
 * 64 MB cap would have rejected the exact maximum the docs advertise — and
 * reported it as a JSON parse error.
 */
export const MAX_BODY_BYTES = Math.ceil((MAX_PDF_BYTES * 4) / 3) + 2 * 1024 * 1024;

/**
 * Cap applied until a key is presented.
 *
 * The keyless allowlist forced the body to be read BEFORE the auth check (the
 * decision depends on which method was called), which handed anonymous callers
 * the full 68 MB budget — N concurrent connections is then a trivial OOM. Every
 * keyless method (initialize, tools/list, ping, try_demo) has a body well under
 * a kilobyte, so an unauthenticated request never legitimately needs more.
 */
export const MAX_ANONYMOUS_BODY_BYTES = 64 * 1024;

/**
 * Ceiling on concurrently-processing requests.
 *
 * Each in-flight request holds several copies of the document while it is
 * decoded and uploaded — measured at ~131 MB resident for a 30 MB PDF, so six
 * concurrent calls reached 784 MB and roughly five at the advertised 50 MB
 * maximum would exhaust a 1 GB container. The per-request body cap bounds one
 * connection; nothing bounded how many at once. Beyond this we shed load with a
 * 503 rather than fall over.
 */
export const DEFAULT_MAX_IN_FLIGHT = 16;

/**
 * Parse a positive-integer env var, falling back loudly rather than to NaN.
 *
 * `parseInt('')` and `parseInt('unlimited')` are both NaN — so an orchestrator
 * exporting the variable empty, or an operator writing "unlimited", silently
 * replaced the configured value with NaN. For the concurrency cap that removed
 * the only admission control; for the timeouts it is worse, because
 * `setTimeout(fn, NaN)` fires after ~1 ms (verified): a typo'd
 * REDACT_PDF_BODY_TIMEOUT_MS destroys every request's socket a millisecond
 * into the body read — a total outage while /health (which has no body) still
 * answers ok — and a typo'd shutdown grace exits ~1 ms after SIGTERM, killing
 * exactly the in-flight work the drain exists to protect. Fail to the
 * default, and say so.
 */
export function parsePositiveIntEnv(
  name: string,
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    process.stderr.write(
      `[redact-pdf-mcp-http] ${name}="${raw}" is not a positive integer; using ${fallback}.\n`,
    );
    return fallback;
  }
  return parsed;
}

export function parseMaxInFlight(raw: string | undefined): number {
  return parsePositiveIntEnv('REDACT_PDF_MAX_IN_FLIGHT', raw, DEFAULT_MAX_IN_FLIGHT);
}

export const MAX_IN_FLIGHT = parseMaxInFlight(process.env.REDACT_PDF_MAX_IN_FLIGHT);

const DEFAULT_MCP_PATH = '/mcp';

/**
 * Methods that must work without an API key.
 *
 * A client has to be able to complete the handshake and see the tool list
 * before it can know a key is needed, and `try_demo` is keyless by design — it
 * is the zero-configuration proof that the server works. Gating these behind a
 * key made the server look broken rather than unconfigured, and contradicted
 * both the README and the tool's own description.
 */
const KEYLESS_METHODS = new Set(['initialize', 'notifications/initialized', 'tools/list', 'ping']);
const KEYLESS_TOOLS = new Set(['try_demo']);

export interface HttpHandlerOptions {
  baseUrl?: string;
  mcpPath?: string;
  /** Inbound body cap. Lower it behind a proxy that already limits request size. */
  maxBodyBytes?: number;
  /** Concurrently-processing requests before the server sheds load with a 503. */
  maxInFlight?: number;
  /** How long a client may take to finish sending its body before it is dropped. */
  bodyTimeoutMs?: number;
}

/** Accept the MCP-conventional bearer token, or the API's own header name. */
export function apiKeyFrom(req: IncomingMessage): string | undefined {
  const header = req.headers['x-api-key'];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  if (fromHeader?.trim()) return fromHeader.trim();

  const auth = req.headers.authorization;
  if (auth?.toLowerCase().startsWith('bearer ')) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }
  return undefined;
}

/**
 * Whether this JSON-RPC payload can be served without a key.
 *
 * Batches are only keyless when every member is — one keyed call in a batch
 * makes the whole batch keyed.
 */
export function isKeylessRequest(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  if (messages.length === 0) return false;
  return messages.every((message) => {
    if (typeof message !== 'object' || message === null) return false;
    const { method, params } = message as { method?: unknown; params?: { name?: unknown } };
    if (typeof method !== 'string') return false;
    if (KEYLESS_METHODS.has(method)) return true;
    // typeof, not String(): {name: ['try_demo']} would coerce to a match here
    // while the SDK's schema rejects it downstream — the gate and the dispatcher
    // must agree on what counts as the tool name.
    if (method === 'tools/call') {
      return typeof params?.name === 'string' && KEYLESS_TOOLS.has(params.name);
    }
    return false;
  });
}

class BodyTooLargeError extends Error {}
class BodyTimeoutError extends Error {}

/**
 * How long a client may take to finish sending its body.
 *
 * A connection that sends headers promising a body and then goes silent holds
 * its concurrency slot indefinitely: the async iterator never settles, and
 * neither Node's `requestTimeout` nor a `res.on('close')` handler brings it
 * back (measured — three idle sockets held their slots for the whole
 * observation). The only reliable remedy is to destroy the request ourselves.
 */
export const BODY_READ_TIMEOUT_MS = parsePositiveIntEnv(
  'REDACT_PDF_BODY_TIMEOUT_MS',
  process.env.REDACT_PDF_BODY_TIMEOUT_MS,
  30_000,
);

async function readJsonBody(
  req: IncomingMessage,
  maxBodyBytes: number,
  bodyTimeoutMs: number,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    req.destroy(new BodyTimeoutError());
  }, bodyTimeoutMs);

  try {
    for await (const chunk of req) {
      const buffer = chunk as Buffer;
      total += buffer.byteLength;
      if (total > maxBodyBytes) throw new BodyTooLargeError();
      chunks.push(buffer);
    }
  } catch (error) {
    if (timedOut) throw new BodyTimeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (total === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

/** JSON-RPC-shaped error, so an MCP client surfaces it instead of choking. */
function sendRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null }, headers);
}

async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  baseUrl: string,
  maxBodyBytes: number,
  bodyTimeoutMs: number,
): Promise<void> {
  // Read the body first — whether a key is required depends on the method — but
  // only extend the large budget to a caller who actually presented one.
  const apiKey = apiKeyFrom(req);
  const budget = apiKey ? maxBodyBytes : Math.min(MAX_ANONYMOUS_BODY_BYTES, maxBodyBytes);

  let body: unknown;
  try {
    body = await readJsonBody(req, budget, bodyTimeoutMs);
  } catch (error) {
    if (error instanceof BodyTimeoutError) {
      // The socket is already destroyed; there is nothing to write back.
      return;
    }
    if (error instanceof BodyTooLargeError) {
      sendRpcError(
        res,
        413,
        -32001,
        apiKey
          ? `Request body exceeds ${Math.floor(budget / 1024 / 1024)} MB. A PDF sent as file_base64 grows by about a third, so the practical document limit over base64 is ~${Math.floor(MAX_PDF_BYTES / 1024 / 1024)} MB. Send file_url instead for large documents.`
          : `Request body exceeds ${Math.floor(budget / 1024)} KB. Unauthenticated requests are limited to the handshake and try_demo; send an API key to upload a document.`,
      );
      req.destroy();
      return;
    }
    sendRpcError(res, 400, -32700, 'Invalid JSON body');
    return;
  }

  if (!apiKey && !isKeylessRequest(body)) {
    sendRpcError(
      res,
      401,
      -32001,
      'Missing API key. Send it as "X-API-Key: <key>" or "Authorization: Bearer <key>". Get a key at https://www.redact-pdf.ai/sign-up — the try_demo tool works without one.',
      { 'WWW-Authenticate': 'Bearer realm="redact-pdf", error="invalid_token"' },
    );
    return;
  }

  const client = new RedactPdfClient({ apiKey, baseUrl });
  const server = createServer({ mode: 'http', client });
  // sessionIdGenerator: undefined => stateless. Nothing to resume, nothing to leak.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

/** The request handler, separated from the listener so it can be tested. */
export function createHttpHandler(
  options: HttpHandlerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  const baseUrl = options.baseUrl ?? process.env.REDACT_PDF_BASE_URL?.trim() ?? DEFAULT_BASE_URL;
  const mcpPath = options.mcpPath ?? process.env.REDACT_PDF_MCP_PATH?.trim() ?? DEFAULT_MCP_PATH;
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const maxInFlight = options.maxInFlight ?? MAX_IN_FLIGHT;
  const bodyTimeoutMs = options.bodyTimeoutMs ?? BODY_READ_TIMEOUT_MS;
  let inFlight = 0;
  let draining = false;

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    // Only the pathname is ever used, so the base is a fixed placeholder rather
    // than the Host header. Interpolating that header was a remote kill switch:
    // it is attacker-controlled, `new URL` throws on a malformed authority, and
    // the throw happens synchronously in the request listener where nothing
    // catches it. One unauthenticated `Host: a b` — to /health, before any auth
    // — printed a stack trace and exit(1), taking every in-flight redaction
    // with it. A malformed target is a 400, never a crash.
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      sendJson(res, 400, { error: 'Malformed request target.' });
      return;
    }

    if (pathname === '/health') {
      // 503 while draining so the load balancer stops sending new work BEFORE
      // the listener closes; previously /health kept answering "ok" and then
      // connections were refused outright, giving no drain window at all.
      const saturated = inFlight >= maxInFlight;
      sendJson(res, draining || saturated ? 503 : 200, {
        status: draining ? 'draining' : saturated ? 'saturated' : 'ok',
        service: 'redact-pdf-mcp',
        version: VERSION,
        in_flight: inFlight,
        max_in_flight: maxInFlight,
      });
      return;
    }

    if (pathname !== mcpPath) {
      sendJson(res, 404, { error: `Not found. The MCP endpoint is ${mcpPath}.` });
      return;
    }

    // Stateless mode has no standalone SSE stream and no session to delete.
    if (req.method !== 'POST') {
      sendRpcError(res, 405, -32000, 'This server is stateless; use POST for MCP requests.', {
        Allow: 'POST',
      });
      return;
    }

    if (inFlight >= maxInFlight) {
      sendRpcError(
        res,
        503,
        -32000,
        `Server is at capacity (${maxInFlight} concurrent requests). Retry shortly.`,
        { 'Retry-After': '2' },
      );
      return;
    }

    // Release the slot on whichever comes first: the handler settling, or the
    // connection closing. Relying on the handler alone strands the slot forever
    // when a client sends headers and then goes silent — the body iterator
    // never settles, and not even Node's requestTimeout brings it back, so a
    // handful of idle sockets permanently exhausts the pool. The connection
    // closing is the one event that always arrives.
    inFlight += 1;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      inFlight -= 1;
    };
    res.on('close', release);

    handleMcp(req, res, baseUrl, maxBodyBytes, bodyTimeoutMs)
      .catch((error: unknown) => {
        process.stderr.write(
          `[redact-pdf-mcp-http] request failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
        );
        if (!res.headersSent) sendRpcError(res, 500, -32603, 'Internal server error');
        else res.end();
      })
      .finally(release);
  };

  // Exposed so the listener can flip health to 503 before it stops accepting.
  (handler as { startDraining?: () => void }).startDraining = () => {
    draining = true;
  };
  return handler;
}

export function startHttpServer(port: number, options: HttpHandlerOptions = {}): Server {
  const handler = createHttpHandler(options);
  const server = createHttpServer(handler);

  // Node's defaults (300s request, 60s headers) are far too generous for a
  // slot-limited server: a connection that sends headers and then goes silent
  // holds a concurrency slot for the whole window. Measured: three silent
  // sockets held their slots indefinitely across the observation. Evict them
  // quickly — a legitimate client sends its body immediately.
  server.requestTimeout = parsePositiveIntEnv(
    'REDACT_PDF_REQUEST_TIMEOUT_MS',
    process.env.REDACT_PDF_REQUEST_TIMEOUT_MS,
    30_000,
  );
  server.headersTimeout = parsePositiveIntEnv(
    'REDACT_PDF_HEADERS_TIMEOUT_MS',
    process.env.REDACT_PDF_HEADERS_TIMEOUT_MS,
    15_000,
  );

  (server as Server & { startDraining?: () => void }).startDraining = (
    handler as unknown as { startDraining: () => void }
  ).startDraining;
  // Without this an EADDRINUSE on restart is an unhandled 'error' event: a raw
  // stack trace and exit(1), rather than a diagnosable message.
  server.on('error', (error: NodeJS.ErrnoException) => {
    process.stderr.write(
      error.code === 'EADDRINUSE'
        ? `[redact-pdf-mcp-http] port ${port} is already in use.\n`
        : `[redact-pdf-mcp-http] server error: ${error.message}\n`,
    );
    process.exit(1);
  });
  server.listen(port, () => {
    const mcpPath = options.mcpPath ?? process.env.REDACT_PDF_MCP_PATH?.trim() ?? DEFAULT_MCP_PATH;
    process.stderr.write(
      `[redact-pdf-mcp-http] v${VERSION} listening on :${port}${mcpPath} (stateless; per-request API key)\n`,
    );
  });
  return server;
}

// Only bind a port when run as a binary — importing this module must be free of
// side effects so it can be tested.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const httpServer = startHttpServer(Number.parseInt(process.env.PORT ?? '8080', 10));

  /**
   * Drain, then exit — with a deadline.
   *
   * `close()` alone waits for every in-flight request, and a redaction can hold
   * one for the whole poll budget (up to 900s). Measured: still polling 32s
   * after SIGTERM. Orchestrators SIGKILL at ~30s by default, so an unbounded
   * wait means every deploy kills paid work rather than draining it. Flip
   * health to 503 first so the load balancer stops sending new work, then give
   * existing work a bounded grace period.
   */
  const graceMs = parsePositiveIntEnv(
    'REDACT_PDF_SHUTDOWN_GRACE_MS',
    process.env.REDACT_PDF_SHUTDOWN_GRACE_MS,
    15_000,
  );
  let shuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      (httpServer as Server & { startDraining?: () => void }).startDraining?.();
      process.stderr.write(`[redact-pdf-mcp-http] ${signal} received; draining for up to ${graceMs}ms\n`);
      httpServer.close(() => process.exit(0));
      setTimeout(() => {
        process.stderr.write('[redact-pdf-mcp-http] grace period expired; exiting\n');
        process.exit(0);
      }, graceMs).unref();
    });
  }
}
