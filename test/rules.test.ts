/**
 * The redaction-rules pipeline: tool argument -> wire format -> what the API parses.
 *
 * This is the highest-consequence path in the package. The API expects the rule
 * fields on the multipart endpoint as JSON-encoded STRINGS (`'["Person"]'`),
 * and parses them with a helper that returns None for anything else — so
 * sending them as repeated form fields, the natural-looking alternative, makes
 * every job silently fall back to account defaults and redact a different set
 * than the user asked for. Nothing about that failure is visible at runtime,
 * so it has to be pinned here.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { RedactPdfClient } from '../src/client.js';
import { createServer } from '../src/server.js';
import { callAt, fetchMock, jsonResponse } from './helpers.js';
import type { InputFile } from '../src/types.js';

const file: InputFile = {
  filename: 'contract.pdf',
  contentType: 'application/pdf',
  bytes: new Uint8Array([1, 2, 3]),
};

function jobResponse() {
  return jsonResponse({
    job_id: 'job-1',
    status: 'analyzing',
    retention: 'ephemeral',
    created_at: '2026-08-22T00:00:00Z',
    documents: [
      { id: 'doc-1', file_name: 'contract.pdf', status: 'uploaded', page_count: 0, error_message: null },
    ],
  });
}

/** Re-parse the multipart body the client actually put on the wire. */
async function sentForm(init: RequestInit): Promise<FormData> {
  const body = init.body;
  if (!(body instanceof FormData)) {
    throw new Error(`Expected a multipart body, got ${Object.prototype.toString.call(body)}`);
  }
  // Round-trip through a real Request so we assert on the encoded form, not the
  // FormData object the client happens to hold.
  return new Request('https://example.invalid', { method: 'POST', body }).formData();
}

describe('rule encoding on the multipart endpoint', () => {
  it('sends every rule field as a JSON-encoded string, the only form the API parses', async () => {
    const fetchImpl = fetchMock(async () => jobResponse());
    const client = new RedactPdfClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
    });

    await client.createJob([file], {
      pii_categories: ['Person', 'Email'],
      pii_included_terms: ['Project Nimbus'],
      pii_excluded_terms: ['Acme Corp'],
      retention: 'studio',
    });

    const form = await sentForm(callAt(fetchImpl, 0)[1]);
    expect(form.get('pii_categories')).toBe('["Person","Email"]');
    expect(form.get('pii_included_terms')).toBe('["Project Nimbus"]');
    expect(form.get('pii_excluded_terms')).toBe('["Acme Corp"]');
    expect(form.get('retention')).toBe('studio');
    expect(form.get('files')).toBeInstanceOf(File);
  });

  it('defaults retention to ephemeral, so originals are not retained by accident', async () => {
    const fetchImpl = fetchMock(async () => jobResponse());
    const client = new RedactPdfClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
    });
    await client.createJob([file]);

    const form = await sentForm(callAt(fetchImpl, 0)[1]);
    expect(form.get('retention')).toBe('ephemeral');
  });

  it('omits rule fields entirely when not given, so account defaults apply', async () => {
    const fetchImpl = fetchMock(async () => jobResponse());
    const client = new RedactPdfClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
    });
    await client.createJob([file]);

    const form = await sentForm(callAt(fetchImpl, 0)[1]);
    expect(form.get('pii_categories')).toBeNull();
    expect(form.get('pii_included_terms')).toBeNull();
  });
});

describe('empty rules never reach the wire', () => {
  const makeClient = (fetchImpl: unknown) =>
    new RedactPdfClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as typeof fetch,
      sleep: async () => {},
    });

  it.each([
    ['an empty list', [] as string[]],
    ['a whitespace-only entry', ['   ']],
    ['a non-string entry', [null as unknown as string]],
  ])(
    'refuses pii_categories given as %s rather than silently redacting nothing',
    async (_label, categories) => {
      // The API cleans these to `[]`, which the worker reads as a deliberate
      // "redact nothing" — the job then reports `redacted` over an untouched
      // document. Silently dropping the key would instead fall back to account
      // defaults, which is a guess about what the caller wanted.
      const fetchImpl = fetchMock(async () => jobResponse());
      await expect(makeClient(fetchImpl).createJob([file], { pii_categories: categories })).rejects.toThrow(
        /no usable category/,
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['pii_included_terms', 'pii_included_terms'],
    ['pii_excluded_terms', 'pii_excluded_terms'],
  ])('drops an empty %s, which only narrows an existing rule set', async (_label, key) => {
    const fetchImpl = fetchMock(async () => jobResponse());
    await makeClient(fetchImpl).createJob([file], { [key]: ['  ', ''] } as never);

    const form = await sentForm(callAt(fetchImpl, 0)[1]);
    expect(form.get(key)).toBeNull();
  });

  it('drops empty rule arrays on the direct-upload path as well', async () => {
    const big = {
      filename: 'big.pdf',
      contentType: 'application/pdf',
      bytes: new Uint8Array(9 * 1024 * 1024),
    };
    const fetchImpl = fetchMock()
      .mockResolvedValueOnce(jsonResponse({ job_id: 'j', uploads: [] }))
      .mockResolvedValueOnce(jsonResponse({ job_id: 'j', status: 'analyzing', documents: [] }));

    await makeClient(fetchImpl).createJob([big], { pii_excluded_terms: [] });

    const body = JSON.parse(String(callAt(fetchImpl, 0)[1].body)) as Record<string, unknown>;
    expect(body.pii_excluded_terms).toBeUndefined();
  });

  it('keeps the usable entries when only some are blank', async () => {
    const fetchImpl = fetchMock(async () => jobResponse());
    await makeClient(fetchImpl).createJob([file], { pii_included_terms: ['Project Nimbus', '  '] });

    const form = await sentForm(callAt(fetchImpl, 0)[1]);
    expect(form.get('pii_included_terms')).toBe('["Project Nimbus"]');
  });
});

describe('rules from tool arguments', () => {
  beforeEach(() => {
    process.env.REDACT_PDF_ENABLE_URL_INPUT = '1';
  });
  afterEach(() => {
    delete process.env.REDACT_PDF_ENABLE_URL_INPUT;
  });

  async function connect(fetchImpl: typeof fetch) {
    const mcp = new Client({ name: 'test', version: '1.0.0' });
    const server = createServer({
      mode: 'http',
      client: new RedactPdfClient({ apiKey: 'k', fetchImpl, sleep: async () => {} }),
      fetchImpl,
      resolveHost: async () => ['93.184.216.34'],
      pollOptions: { sleep: async () => {}, initialDelayMs: 1 },
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), mcp.connect(a)]);
    return mcp;
  }

  it('carries tool arguments through to the wire unchanged', async () => {
    const fetchImpl = fetchMock()
      .mockResolvedValueOnce(new Response(Buffer.from('%PDF-1.4'), { status: 200 }))
      .mockResolvedValueOnce(jobResponse());

    const mcp = await connect(fetchImpl as unknown as typeof fetch);
    await mcp.callTool({
      name: 'redact_pdf',
      arguments: {
        file_url: 'https://example.com/contract.pdf',
        pii_categories: ['IBAN', 'CreditCard'],
        pii_excluded_terms: ['Acme Corp'],
        retention: 'studio',
      },
    });

    const form = await sentForm(callAt(fetchImpl, 1)[1]);
    expect(form.get('pii_categories')).toBe('["IBAN","CreditCard"]');
    expect(form.get('pii_excluded_terms')).toBe('["Acme Corp"]');
    expect(form.get('retention')).toBe('studio');
  });

  it('REFUSES an empty pii_categories list instead of returning an unredacted file', async () => {
    // The API stores [] as a deliberate "redact nothing" preference and the
    // worker honours it: the job would complete as `redacted` with every piece
    // of PII intact, and the tool would report success. This must never reach
    // the wire.
    const fetchImpl = fetchMock();
    const mcp = await connect(fetchImpl as unknown as typeof fetch);

    const result = await mcp.callTool({
      name: 'redact_pdf',
      arguments: { file_url: 'https://example.com/a.pdf', pii_categories: [] },
    });

    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('drops an empty included/excluded term list rather than forwarding it', async () => {
    const fetchImpl = fetchMock()
      .mockResolvedValueOnce(new Response(Buffer.from('%PDF-1.4'), { status: 200 }))
      .mockResolvedValueOnce(jobResponse());

    const mcp = await connect(fetchImpl as unknown as typeof fetch);
    await mcp.callTool({
      name: 'redact_pdf',
      arguments: { file_url: 'https://example.com/a.pdf', pii_included_terms: [] },
    });

    const form = await sentForm(callAt(fetchImpl, 1)[1]);
    expect(form.get('pii_included_terms')).toBeNull();
  });

  it('rejects a category the API does not know', async () => {
    const fetchImpl = fetchMock();
    const mcp = await connect(fetchImpl as unknown as typeof fetch);
    const result = await mcp.callTool({
      name: 'redact_pdf',
      arguments: { file_url: 'https://example.com/a.pdf', pii_categories: ['SocialSecurity'] },
    });
    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a timeout beyond the documented maximum', async () => {
    const fetchImpl = fetchMock();
    const mcp = await connect(fetchImpl as unknown as typeof fetch);
    // Schema violations come back as a protocol-level error, not a tool result.
    const result = await mcp.callTool({
      name: 'redact_pdf_and_wait',
      arguments: { file_url: 'https://example.com/a.pdf', timeout_seconds: 5000 },
    });
    const text = JSON.stringify(result);
    expect(result.isError).toBe(true);
    expect(text).toMatch(/900/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
