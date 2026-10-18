/**
 * The pseudonymized document as text (GET /v1/documents/{id}/output.md),
 * handed to the agent so it can work on the [Person 1] version without OCR-ing
 * a PDF that has no text layer. Inline when small, a file (stdio) or a URL
 * (remote) when large, and never a reason to report a finished, billed
 * redaction as failed.
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { RedactPdfClient } from '../src/client.js';
import { REMOTE_SERVER_INSTRUCTIONS, RESTORE_NAMES, SERVER_INSTRUCTIONS } from '../src/descriptions.js';
import { createServer, documentTextPath, type ServerMode } from '../src/server.js';
import type { Job } from '../src/types.js';
import { fetchMock, jsonResponse, payload, rejection, type FetchMock } from './helpers.js';

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
const TEXT = '## Page 1\n\n[Person 1] sold the flat to [Org 1].\n';
const CSV = '﻿placeholder,label,category,original\n[Person 1],,Person,Anna Keller\n';

function job(mode: Job['mode'], status: Job['status'] = 'redacted'): Job {
  return {
    job_id: 'job-1',
    status,
    retention: 'ephemeral',
    mode,
    created_at: '2026-10-18T00:00:00Z',
    documents: [{ id: 'doc-1', file_name: 'in.pdf', status, page_count: 1, error_message: null }],
  };
}

function api(routes: { mode?: Job['mode']; text?: () => Response } = {}): FetchMock {
  return fetchMock(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/v1/jobs') && method === 'POST') return jsonResponse(job(routes.mode ?? 'pseudonymize', 'analyzing'));
    if (url.includes('/v1/jobs/')) return jsonResponse(job(routes.mode ?? 'pseudonymize'));
    if (url.endsWith('/output')) return new Response(PDF);
    if (url.endsWith('/output.md')) return routes.text ? routes.text() : new Response(TEXT, { headers: { 'Content-Type': 'text/markdown' } });
    if (url.endsWith('/correspondence')) return new Response(CSV);
    throw new Error(`unexpected ${method} ${url}`);
  });
}

const paths = (mock: FetchMock) => mock.mock.calls.map(([input]) => new URL(String(input)).pathname);

async function connect(mode: ServerMode, fetchImpl: FetchMock, maxInlineTextBytes?: number) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  const server = createServer({
    mode,
    client: new RedactPdfClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} }),
    pollOptions: { sleep: async () => {}, initialDelayMs: 1 },
    ...(maxInlineTextBytes != null ? { maxInlineTextBytes } : {}),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}

let dir: string;
let inputPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'doc-text-'));
  inputPath = join(dir, 'in.pdf');
  await writeFile(inputPath, '%PDF-1.4 source');
});

const andWait = (client: Client, args: Record<string, unknown> = {}) =>
  client.callTool({ name: 'redact_pdf_and_wait', arguments: { file_path: inputPath, mode: 'pseudonymize', timeout_seconds: 10, ...args } });

const andWaitRemote = (client: Client) =>
  client.callTool({
    name: 'redact_pdf_and_wait',
    arguments: { file_base64: Buffer.from('%PDF-1.4').toString('base64'), filename: 'in.pdf', mode: 'pseudonymize', timeout_seconds: 10 },
  });

describe('redact_pdf_and_wait, stdio', () => {
  it('returns a small text inline, with the restore loop as next step', async () => {
    const out = payload(await andWait(await connect('stdio', api())));

    expect(out.document_text).toBe(TEXT);
    expect(out.document_text_path).toBeUndefined();
    expect(String(out.next_step)).toMatch(/restore_names/);
    expect(String(out.next_step)).toMatch(/Never open the correspondence table or the restored file/);
    await expect(readFile(join(dir, 'in-redacted.md'))).rejects.toThrow();
  });

  it('writes a large text next to the PDF instead of inlining it', async () => {
    const out = payload(await andWait(await connect('stdio', api(), 10)));

    expect(out.document_text).toBeUndefined();
    expect(out.document_text_path).toBe(join(dir, 'in-redacted.md'));
    expect(out.document_text_bytes).toBe(new TextEncoder().encode(TEXT).byteLength);
    expect(await readFile(join(dir, 'in-redacted.md'), 'utf8')).toBe(TEXT);
  });

  it('the inline ceiling is inclusive and counted in bytes, not characters', async () => {
    const accented = '## Page 1\n\nRené\n';
    const bytes = new TextEncoder().encode(accented).byteLength;
    expect(bytes).toBeGreaterThan(accented.length);
    const at = payload(await andWait(await connect('stdio', api({ text: () => new Response(accented) }), bytes)));
    expect(at.document_text).toBe(accented);

    const over = payload(await andWait(await connect('stdio', api({ text: () => new Response(accented) }), accented.length), {
      output_path: join(dir, 'b.pdf'),
    }));
    expect(over.document_text_path).toBe(join(dir, 'b.md'));
  });

  it('a large text never overwrites an existing file, and the PDF is still done', async () => {
    await writeFile(join(dir, 'in-redacted.md'), 'mine');
    const result = await andWait(await connect('stdio', api(), 10));
    const out = payload(result);

    expect(result.isError).toBeFalsy();
    expect(out.status).toBe('redacted');
    expect(String(out.document_text_error)).toMatch(/already exists/);
    expect(String(out.document_text_error)).toMatch(/Do not redact again/);
    expect(await readFile(join(dir, 'in-redacted.md'), 'utf8')).toBe('mine');
  });

  it.each([
    [404, /not redacted with mode "pseudonymize", or this output has none/],
    [409, /edited in the Redact PDF AI Studio/],
  ])('a %i on the text is reported next to a finished redaction', async (status, message) => {
    const result = await andWait(await connect('stdio', api({ text: () => jsonResponse({ error: 'x' }, status) })));
    const out = payload(result);

    expect(result.isError).toBeFalsy();
    expect(out.status).toBe('redacted');
    expect(out.correspondence_path).toBe(join(dir, 'in-correspondence.csv'));
    expect(String(out.document_text_error)).toMatch(message);
    expect(out.document_text).toBeUndefined();
    // No "work from document_text" when there is none to work from.
    expect(out.next_step).toBeUndefined();
  });

  it('redact mode never asks for a text version', async () => {
    const fetchImpl = api({ mode: 'redact' });
    const out = payload(await andWait(await connect('stdio', fetchImpl)));

    expect(out.mode).toBe('redact');
    expect(out.document_text).toBeUndefined();
    expect(out.next_step).toBeUndefined();
    expect(paths(fetchImpl).some((p) => p.endsWith('/output.md'))).toBe(false);
  });
});

describe('redact_pdf_and_wait, remote', () => {
  it('inlines a small text and points at the local restore', async () => {
    const out = payload(await andWaitRemote(await connect('http', api())));

    expect(out.document_text).toBe(TEXT);
    expect(String(out.next_step)).toMatch(/cannot put the names back/);
  });

  it('returns a URL for a large text, since it has no disk to write to', async () => {
    const out = payload(await andWaitRemote(await connect('http', api(), 10)));

    expect(out.document_text).toBeUndefined();
    expect(out.document_text_path).toBeUndefined();
    expect(out.document_text_url).toBe('https://www.redact-pdf.ai/v1/documents/doc-1/output.md');
    expect(String(out.document_text_note)).toMatch(/X-API-Key/);
  });

  it('a failed text fetch is reported, the PDF still returned', async () => {
    const result = await andWaitRemote(await connect('http', api({ text: () => jsonResponse({ error: 'x' }, 409) })));
    const out = payload(result);

    expect(result.isError).toBeFalsy();
    expect(out.content_base64).toBeDefined();
    expect(String(out.document_text_error)).toMatch(/Studio/);
    expect(out.next_step).toBeUndefined();
  });

  it('a large text sent as a URL still comes with the next step', async () => {
    const out = payload(await andWaitRemote(await connect('http', api(), 10)));
    expect(String(out.next_step)).toMatch(/document_text_url/);
  });
});

describe('download_redacted', () => {
  it('stdio: returns the text of a pseudonymized document', async () => {
    const out = payload(await (await connect('stdio', api())).callTool({
      name: 'download_redacted',
      arguments: { document_id: 'doc-1', output_path: join(dir, 'x.pdf') },
    }));

    expect(out.status).toBe('downloaded');
    expect(out.document_text).toBe(TEXT);
    expect(String(out.next_step)).toMatch(/restore_names/);
    // This tool returns no correspondence_path: the step says how to get the table.
    expect(String(out.next_step)).toMatch(/download_correspondence/);
    expect(String(out.next_step)).not.toMatch(/correspondence_path/);
  });

  it('stdio: a large text goes next to the requested PDF path', async () => {
    const out = payload(await (await connect('stdio', api(), 10)).callTool({
      name: 'download_redacted',
      arguments: { document_id: 'doc-1', output_path: join(dir, 'x.pdf') },
    }));
    expect(out.document_text_path).toBe(join(dir, 'x.md'));
    expect(String(out.next_step)).toMatch(/download_correspondence/);
  });

  it('a redact-mode document (404) adds nothing, not an error', async () => {
    const out = payload(await (await connect('stdio', api({ text: () => jsonResponse({ error: 'x' }, 404) }))).callTool({
      name: 'download_redacted',
      arguments: { document_id: 'doc-1', output_path: join(dir, 'x.pdf') },
    }));

    expect(out.status).toBe('downloaded');
    expect(out.document_text).toBeUndefined();
    expect(out.document_text_error).toBeUndefined();
    expect(out.next_step).toBeUndefined();
  });

  it('any other text failure is reported', async () => {
    const out = payload(await (await connect('stdio', api({ text: () => jsonResponse({ error: 'x' }, 409) }))).callTool({
      name: 'download_redacted',
      arguments: { document_id: 'doc-1', output_path: join(dir, 'x.pdf') },
    }));
    expect(String(out.document_text_error)).toMatch(/Studio/);
    expect(out.next_step).toBeUndefined();
  });

  it('remote: inlines the text next to the PDF', async () => {
    const out = payload(await (await connect('http', api())).callTool({ name: 'download_redacted', arguments: { document_id: 'doc-1' } }));
    expect(out.document_text).toBe(TEXT);
    expect(out.content_base64).toBeDefined();
    expect(String(out.next_step)).toMatch(/cannot put the names back/);
  });
});

describe('client.downloadOutputText', () => {
  it('reads the text and maps 404/409 to what they mean', async () => {
    const ok = new RedactPdfClient({ apiKey: 'k', fetchImpl: api() as unknown as typeof fetch });
    expect(await ok.downloadOutputText('doc-1')).toBe(TEXT);

    for (const [status, code, retryable] of [[404, 'not_found', false], [409, 'conflict', false]] as const) {
      const client = new RedactPdfClient({
        apiKey: 'k',
        fetchImpl: api({ text: () => jsonResponse({ error: 'x' }, status) }) as unknown as typeof fetch,
      });
      const error = await rejection(client.downloadOutputText('doc-1'));
      expect(error.code).toBe(code);
      expect(error.retryable).toBe(retryable);
    }
  });

  it('leaves other failures as the client reported them', async () => {
    const client = new RedactPdfClient({
      apiKey: 'k',
      fetchImpl: api({ text: () => jsonResponse({ error: 'x' }, 402) }) as unknown as typeof fetch,
      sleep: async () => {},
    });
    expect((await rejection(client.downloadOutputText('doc-1'))).code).toBe('quota_exceeded');
  });
});

describe('documentTextPath', () => {
  it('sits next to the PDF', () => {
    expect(documentTextPath('/a/in-redacted.pdf')).toBe('/a/in-redacted.md');
  });
});

describe('privacy wording the agent reads', () => {
  it('the server instructions forbid reading the original first, and say why', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/do NOT open, Read, cat, preview or summarize the original file before calling/);
    expect(SERVER_INSTRUCTIONS).toMatch(/defeats the purpose/);
    expect(SERVER_INSTRUCTIONS).toMatch(/restore_names/);
  });

  it('reaches the client as the server instructions', async () => {
    const client = await connect('stdio', api());
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
  });

  it('every tool that takes the original says it, and restore_names says not to read its output', async () => {
    const client = await connect('stdio', api());
    const { tools } = await client.listTools();
    const description = (name: string) => tools.find((t) => t.name === name)?.description ?? '';
    for (const name of ['redact_pdf_and_wait', 'redact_pdf']) {
      expect(description(name)).toMatch(/Reading it first puts the personal data into this conversation/);
    }
    expect(description('restore_names')).toBe(RESTORE_NAMES);
    expect(RESTORE_NAMES).toMatch(/Do NOT open, read or quote the restored file or the correspondence CSV/);
    expect(description('download_correspondence')).toMatch(/Never open or read that file/);
  });

  it('the hosted server promises nothing it cannot keep', async () => {
    const client = await connect('http', api());
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toBe(REMOTE_SERVER_INSTRUCTIONS);
    expect(instructions).toMatch(/cannot keep personal data out of this conversation/);
    const { tools } = await client.listTools();
    const texts = [instructions, ...tools.map((t) => t.description ?? '')];
    for (const text of texts) {
      // No tool this server lacks, no input it does not take, no promise it breaks.
      expect(text).not.toMatch(/call restore_names|pass its path|without ever seeing a name|pass that file and correspondence_path/);
      expect(text).not.toMatch(/PRIVACY: when the user wants the document anonymized/);
    }
    for (const name of ['redact_pdf_and_wait', 'redact_pdf']) {
      expect(tools.find((t) => t.name === name)?.description).toMatch(/cannot keep personal data out/);
    }
    expect(tools.find((t) => t.name === 'download_correspondence')?.description).toMatch(/comes back inline/);
    // A remote long text is a URL, never a path on a disk this server does not have.
    expect(tools.find((t) => t.name === 'download_redacted')?.description).toMatch(/document_text_url/);
    expect(texts.join('\n')).not.toMatch(/document_text_path/);
  });

  it('the local server never sends the hosted wording', async () => {
    const client = await connect('stdio', api());
    const { tools } = await client.listTools();
    for (const text of [client.getInstructions() ?? '', ...tools.map((t) => t.description ?? '')]) {
      expect(text).not.toMatch(/cannot keep personal data out|this hosted server/i);
    }
  });
});
