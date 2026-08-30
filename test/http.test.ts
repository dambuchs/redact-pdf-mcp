/**
 * The hosted server's request handling — its auth gate is the only thing
 * standing between the internet and a caller's API key, so it needs coverage.
 * Exercised through a real socket on an ephemeral port.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiKeyFrom, createHttpHandler, isKeylessRequest, MAX_BODY_BYTES, parseMaxInFlight, parsePositiveIntEnv, DEFAULT_MAX_IN_FLIGHT } from '../src/http.js';
import { MAX_PDF_BYTES } from '../src/types.js';

let server: Server;
let base: string;

beforeAll(async () => {
  // A small cap keeps the oversized-body test from shovelling 70 MB through a socket.
  server = createServer(createHttpHandler({ baseUrl: 'https://api.invalid', maxBodyBytes: 4096 }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const rpc = (method: string, params?: unknown, id = 1) =>
  JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

/** `response.json()` is `unknown`; these tests assert on known JSON-RPC shapes. */
type JsonBody = { service?: string; error?: { message?: string; code?: number } };
const readJson = async (response: Response): Promise<JsonBody> =>
  (await response.json()) as JsonBody;

const post = (body: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body,
  });

describe('parsePositiveIntEnv', () => {
  // The stake: parseInt('') and parseInt('junk') are NaN, and setTimeout(fn, NaN)
  // fires after ~1 ms — so an unparsed timeout env var destroys every request's
  // socket a millisecond into the body read while /health still answers ok.
  // Every timeout knob must come through this parser, never a bare parseInt.

  const quietly = <T>(run: () => T): T => {
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      return run();
    } finally {
      process.stderr.write = original;
    }
  };

  it('returns the parsed value for a plain positive integer', () => {
    expect(parsePositiveIntEnv('X', '45000', 30_000)).toBe(45_000);
  });

  it('falls back on undefined without warning', () => {
    expect(parsePositiveIntEnv('X', undefined, 30_000)).toBe(30_000);
  });

  it('falls back on an empty or whitespace-only value — the orchestrator-exports-it-empty case', () => {
    expect(parsePositiveIntEnv('X', '', 30_000)).toBe(30_000);
    expect(parsePositiveIntEnv('X', '   ', 30_000)).toBe(30_000);
  });

  it('falls back on a non-numeric value instead of yielding NaN', () => {
    expect(quietly(() => parsePositiveIntEnv('X', 'unlimited', 30_000))).toBe(30_000);
    expect(Number.isNaN(quietly(() => parsePositiveIntEnv('X', 'abc', 30_000)))).toBe(false);
  });

  it('falls back on zero and negatives — a 0ms body deadline is the same outage as NaN', () => {
    expect(quietly(() => parsePositiveIntEnv('X', '0', 30_000))).toBe(30_000);
    expect(quietly(() => parsePositiveIntEnv('X', '-5', 30_000))).toBe(30_000);
  });

  it('warns on stderr with the variable name, so the operator can find the typo', () => {
    const lines: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      parsePositiveIntEnv('REDACT_PDF_BODY_TIMEOUT_MS', 'oops', 30_000);
    } finally {
      process.stderr.write = original;
    }
    expect(lines.join('')).toContain('REDACT_PDF_BODY_TIMEOUT_MS="oops"');
  });

  it('parseMaxInFlight is the same parser with the concurrency default', () => {
    expect(parseMaxInFlight(undefined)).toBe(DEFAULT_MAX_IN_FLIGHT);
    expect(parseMaxInFlight('4')).toBe(4);
    expect(quietly(() => parseMaxInFlight('unlimited'))).toBe(DEFAULT_MAX_IN_FLIGHT);
  });
});

describe('apiKeyFrom', () => {
  const req = (headers: Record<string, string | string[]>) => ({ headers }) as never;

  it('reads X-API-Key', () => {
    expect(apiKeyFrom(req({ 'x-api-key': 'abc' }))).toBe('abc');
  });

  it('reads a bearer token, case-insensitively', () => {
    expect(apiKeyFrom(req({ authorization: 'Bearer abc' }))).toBe('abc');
    expect(apiKeyFrom(req({ authorization: 'bearer abc' }))).toBe('abc');
  });

  it('ignores a non-bearer authorization scheme', () => {
    expect(apiKeyFrom(req({ authorization: 'Basic abc' }))).toBeUndefined();
  });

  it('handles a repeated header arriving as an array', () => {
    expect(apiKeyFrom(req({ 'x-api-key': ['abc', 'def'] }))).toBe('abc');
  });

  it('treats a whitespace-only key as absent', () => {
    expect(apiKeyFrom(req({ 'x-api-key': '   ' }))).toBeUndefined();
  });
});

describe('isKeylessRequest', () => {
  it('allows the handshake and tool listing', () => {
    expect(isKeylessRequest({ method: 'initialize' })).toBe(true);
    expect(isKeylessRequest({ method: 'tools/list' })).toBe(true);
  });

  it('allows try_demo but no other tool', () => {
    expect(isKeylessRequest({ method: 'tools/call', params: { name: 'try_demo' } })).toBe(true);
    expect(isKeylessRequest({ method: 'tools/call', params: { name: 'redact_pdf' } })).toBe(false);
    expect(isKeylessRequest({ method: 'tools/call', params: {} })).toBe(false);
  });

  it('requires a key if ANY member of a batch needs one', () => {
    expect(
      isKeylessRequest([
        { method: 'tools/call', params: { name: 'try_demo' } },
        { method: 'tools/call', params: { name: 'redact_pdf' } },
      ]),
    ).toBe(false);
  });

  it('fails closed on a well-formed method outside the allowlist', () => {
    // The default branch is the auth gate: anything not explicitly keyless needs
    // a key, including methods the SDK may add later.
    expect(isKeylessRequest({ method: 'resources/list' })).toBe(false);
    expect(isKeylessRequest({ method: 'completion/complete' })).toBe(false);
    expect(isKeylessRequest({ method: 'prompts/list' })).toBe(false);
  });

  it('does not accept a non-string tool name that coerces to a keyless one', () => {
    expect(isKeylessRequest({ method: 'tools/call', params: { name: ['try_demo'] } })).toBe(false);
  });

  it('rejects malformed payloads rather than defaulting to keyless', () => {
    expect(isKeylessRequest(undefined)).toBe(false);
    expect(isKeylessRequest([])).toBe(false);
    expect(isKeylessRequest({ method: 42 })).toBe(false);
  });
});

describe('routing', () => {
  it('serves /health without a key', async () => {
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    expect((await readJson(response)).service).toBe('redact-pdf-mcp');
  });

  it('404s an unknown path and names the real endpoint', async () => {
    const response = await fetch(`${base}/nope`, { method: 'POST' });
    expect(response.status).toBe(404);
    expect(JSON.stringify(await readJson(response))).toContain('/mcp');
  });

  it('405s a GET, since a stateless server has no SSE stream to open', async () => {
    const response = await fetch(`${base}/mcp`);
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });
});

describe('authentication gate', () => {
  it('rejects a keyed tool call with 401 and a WWW-Authenticate challenge', async () => {
    const response = await post(rpc('tools/call', { name: 'redact_pdf', arguments: {} }));
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toMatch(/Bearer/);
    const body = await readJson(response);
    expect(body.error?.message).toMatch(/sign-up/);
  });

  it('lets the handshake through without a key, so clients can discover the server', async () => {
    const response = await post(
      rpc('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      }),
    );
    expect(response.status).toBe(200);
  });

  it('lets tools/list through without a key', async () => {
    const response = await post(rpc('tools/list'));
    expect(response.status).toBe(200);
  });

  it('accepts a bearer token for a keyed call', async () => {
    const response = await post(rpc('tools/list'), { Authorization: 'Bearer test-key' });
    expect(response.status).toBe(200);
  });
});

describe('body limits', () => {
  it('allows enough room for the documented maximum PDF sent as base64', () => {
    // A 50 MB PDF inflates by 4/3 under base64; a 64 MB cap would have made the
    // documented limit unusable, and reported it as a JSON parse error.
    expect(MAX_BODY_BYTES).toBeGreaterThan((MAX_PDF_BYTES * 4) / 3);
  });

  it('rejects an oversized body as too large, not as malformed JSON', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'redact_pdf', arguments: { file_base64: 'a'.repeat(8192) } },
    });
    const response = await post(body, { 'X-API-Key': 'k' });
    expect(response.status).toBe(413);
    expect((await readJson(response)).error?.message).toMatch(/file_url/);
  });

  it('reports invalid JSON as a parse error', async () => {
    const response = await post('{not json', { 'X-API-Key': 'k' });
    expect(response.status).toBe(400);
    expect((await readJson(response)).error?.code).toBe(-32700);
  });
});
