/**
 * Operational behaviour: load shedding, shutdown posture, and the log line an
 * operator needs. None of this was covered before — a total upstream outage
 * produced zero log lines and every failure returned HTTP 200.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as netConnect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { RedactPdfClient } from '../src/client.js';
import { createHttpHandler } from '../src/http.js';
import { createServer as createMcpServer } from '../src/server.js';
import { logToolCall, setLogSink } from '../src/observability.js';
import { fetchMock, jsonResponse } from './helpers.js';

const servers: Server[] = [];

afterEach(async () => {
  setLogSink((line) => process.stderr.write(line));
  await Promise.all(
    servers.splice(0).map((s) => {
      // closeAllConnections first: close() alone waits for in-flight requests,
      // and these tests deliberately leave some hanging. (That wait is exactly
      // the production shutdown problem this file's server-side fix addresses.)
      s.closeAllConnections();
      return new Promise<void>((r) => s.close(() => r()));
    }),
  );
});

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function listen(handler: Handler): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('load shedding', () => {
  it('sheds excess concurrent requests with 503 instead of accepting them all', async () => {
    // Each in-flight request holds several copies of the document; without a
    // cap, a handful of max-size uploads exhausts a small container.
    const upstream = await listen(() => {
      /* never responds, so requests stay in flight */
    });
    const base = await listen(createHttpHandler({ baseUrl: upstream, maxInFlight: 2 }));

    const call = () =>
      fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'X-API-Key': 'k',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'get_account_status', arguments: {} },
        }),
      }).then((r) => r.status);

    const statuses = await Promise.all(Array.from({ length: 6 }, call));
    expect(statuses.filter((s) => s === 503).length).toBeGreaterThan(0);
  });

  it('reports in-flight count on /health so saturation is visible', async () => {
    const base = await listen(createHttpHandler({ baseUrl: 'https://api.invalid', maxInFlight: 2 }));
    const body = (await (await fetch(`${base}/health`)).json()) as { in_flight?: number };
    expect(body.in_flight).toBe(0);
  });
});

describe('stalled connections cannot exhaust the slot pool', () => {
  it('reclaims a slot from a client that sends headers and then goes silent', async () => {
    // The concurrency cap made this fatal: a silent socket's body iterator never
    // settles, so the slot was held indefinitely — and neither Node's
    // requestTimeout nor res.on('close') released it. A handful of idle
    // connections permanently exhausted the server.
    const upstream = await listen(() => {});
    const base = await listen(
      createHttpHandler({ baseUrl: upstream, maxInFlight: 2, bodyTimeoutMs: 300 }),
    );
    const port = Number(new URL(base).port);

    const sockets = Array.from({ length: 2 }, () => {
      const socket = netConnect(port, '127.0.0.1', () => {
        socket.write(
          'POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n' +
            'X-API-Key: k\r\nContent-Length: 5000000\r\n\r\n{',
        );
        // Deliberately send nothing further and hold the socket open.
      });
      socket.on('error', () => {});
      return socket;
    });

    const health = async () =>
      (await (await fetch(`${base}/health`)).json()) as { in_flight: number };

    await new Promise((r) => setTimeout(r, 150));
    expect((await health()).in_flight).toBe(2);

    await new Promise((r) => setTimeout(r, 600));
    expect((await health()).in_flight).toBe(0);

    for (const socket of sockets) socket.destroy();
  });
});

describe('observability', () => {
  it('emits one structured line per tool call, with the upstream request id', async () => {
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));

    const fetchImpl = fetchMock(
      async () =>
        new Response(
          JSON.stringify({ error: 'down', code: 'internal_error', request_id: 'req_xyz' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    const mcp = new Client({ name: 't', version: '1' });
    const server = createMcpServer({
      mode: 'stdio',
      client: new RedactPdfClient({
        apiKey: 'sk_secret_value',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep: async () => {},
        maxAttempts: 1,
      }),
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), mcp.connect(a)]);
    await mcp.callTool({ name: 'get_account_status', arguments: {} });

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry.tool).toBe('get_account_status');
    expect(entry.outcome).toBe('error');
    expect(entry.httpStatus).toBe(503);
    expect(entry.requestId).toBe('req_xyz');
    // Never the credential.
    expect(lines[0]).not.toContain('sk_secret_value');
  });

  it('logs successful calls too, so silence means no traffic rather than no errors', async () => {
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));

    const fetchImpl = fetchMock(async () => jsonResponse({ user_id: 'u', email: 'a@b.c' }));
    const mcp = new Client({ name: 't', version: '1' });
    const server = createMcpServer({
      mode: 'stdio',
      client: new RedactPdfClient({
        apiKey: 'k',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep: async () => {},
      }),
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), mcp.connect(a)]);
    await mcp.callTool({ name: 'get_account_status', arguments: {} });

    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry.outcome).toBe('ok');
  });

  it('never lets a logging failure break a tool call', () => {
    setLogSink(() => {
      throw new Error('disk full');
    });
    expect(() => logToolCall({ tool: 't', outcome: 'ok', durationMs: 1 })).not.toThrow();
  });
});
