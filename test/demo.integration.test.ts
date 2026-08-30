/**
 * Integration test against the LIVE keyless demo endpoint.
 *
 * No API key, no upload, no cost — so it is safe to run in CI and safe to run
 * from a contributor's laptop. It is the contract test for the one thing a new
 * user hits first: `try_demo` must work with zero configuration.
 *
 * Run with: npm run test:integration
 * It is excluded from `npm test` so the unit suite stays offline and fast.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { RedactPdfClient } from '../src/client.js';
import { createServer } from '../src/server.js';
import { payload } from './helpers.js';

const TIMEOUT = 30_000;

describe('live keyless demo', () => {
  it(
    'returns a real redaction result with no API key configured',
    async () => {
      const client = new RedactPdfClient(); // deliberately no key
      const demo = await client.demo();

      expect(demo.status).toBe('ok');
      expect(demo.detected_pii.length).toBeGreaterThan(0);
      expect(demo.detected_pii.every((entry) => entry.masked)).toBe(true);
      expect(demo.redacted_pdf_path).toContain('sample.pdf');
    },
    TIMEOUT,
  );

  it(
    'serves a real PDF at the advertised sample path',
    async () => {
      const client = new RedactPdfClient();
      const demo = await client.demo();

      const response = await fetch(`${client.baseUrl}${demo.redacted_pdf_path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/pdf');

      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
    },
    TIMEOUT,
  );

  it(
    'exposes try_demo end-to-end through MCP with zero configuration',
    async () => {
      const server = createServer({ mode: 'stdio', client: new RedactPdfClient() });
      const mcpClient = new Client({ name: 'integration', version: '1.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

      const result = await mcpClient.callTool({ name: 'try_demo', arguments: {} });
      const out = payload(result);

      expect(result.isError).toBeFalsy();
      expect(out.status).toBe('ok');
      expect(out.api_key_configured).toBe(false);
      expect(Array.isArray(out.detected_and_removed)).toBe(true);

      await mcpClient.close();
      await server.close();
    },
    TIMEOUT,
  );

  it(
    'rejects an unauthenticated call to a key-protected endpoint with actionable guidance',
    async () => {
      const client = new RedactPdfClient({ apiKey: 'sk_definitely_not_a_real_key', maxAttempts: 1 });
      const error = await client.me().then(
        () => null,
        (e: unknown) => e as { code?: string; message?: string },
      );

      expect(error?.code).toBe('unauthorized');
      expect(error?.message).toContain('redact-pdf.ai');
    },
    TIMEOUT,
  );
});
