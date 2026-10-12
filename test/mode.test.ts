/**
 * `mode: "pseudonymize"` end to end: argument -> wire -> correspondence table.
 *
 * Every branch here is new, and this package's history is fixes landing in
 * branches nothing exercised. The failure that matters most is silent: a mode
 * dropped anywhere on the way returns black boxes and reports success, so each
 * hop is pinned on its own.
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { deriveIdempotencyKey, RedactPdfClient, withoutEmptyRules } from '../src/client.js';
import { correspondencePath, createServer, type ServerMode } from '../src/server.js';
import type { InputFile, Job } from '../src/types.js';
import { callAt, fetchMock, jsonResponse, payload, type FetchMock } from './helpers.js';

const REDACTED_PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
// As the API serves it: with a BOM, so Excel reads accented names right.
const CSV_BODY = 'placeholder,label,category,original\n[P1],[Seller],Person,Anna Keller\n';
const CSV = `\uFEFF${CSV_BODY}`;

const file: InputFile = { filename: 'contract.pdf', contentType: 'application/pdf', bytes: new Uint8Array([1, 2, 3]) };

function job(overrides: Partial<Job> = {}): Job {
  const status = overrides.status ?? 'redacted';
  return {
    job_id: 'job-1',
    status,
    retention: 'ephemeral',
    created_at: '2026-10-11T00:00:00Z',
    documents: [{ id: 'doc-1', file_name: 'in.pdf', status, page_count: 2, error_message: null }],
    ...overrides,
  };
}

/** Answers by route, so a test states what the server returns, not call order. */
function api(routes: { jobMode?: Job['mode']; correspondence?: () => Response; demoMode?: 'redact' | 'pseudonymize' | null } = {}): FetchMock {
  return fetchMock(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/v1/jobs') && method === 'POST') return jsonResponse(job({ status: 'analyzing', mode: routes.jobMode }));
    if (url.includes('/v1/jobs/')) return jsonResponse(job({ mode: routes.jobMode }));
    if (url.endsWith('/output')) return new Response(REDACTED_PDF);
    if (url.endsWith('/correspondence')) {
      return routes.correspondence ? routes.correspondence() : new Response(CSV, { headers: { 'Content-Type': 'text/csv' } });
    }
    if (url.endsWith('/v1/demo/redact')) {
      return jsonResponse({
        status: 'ok',
        message: 'm',
        file_name: 'contract.pdf',
        total_pages: 3,
        redacted_pages: 1,
        detected_pii: [{ category: 'Person', masks: 2 }],
        ...(routes.demoMode === null ? {} : { mode: routes.demoMode ?? 'pseudonymize' }),
        ...(routes.demoMode ? {} : routes.demoMode === null ? {} : { tags: ['[P1]', '[P2]'] }),
        redacted_first_page_url: 'https://blob.example/x.pdf',
        link_expires_in_days: 14,
      });
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
}

const calledPaths = (mock: FetchMock) => mock.mock.calls.map(([input]) => new URL(String(input)).pathname);

async function sentForm(init: RequestInit): Promise<FormData> {
  return new Request('https://example.invalid', { method: 'POST', body: init.body as FormData }).formData();
}

async function connect(mode: ServerMode, fetchImpl: FetchMock) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  const server = createServer({
    mode,
    client: new RedactPdfClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} }),
    pollOptions: { sleep: async () => {}, initialDelayMs: 1 },
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}

let tempDir: string;
let inputPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'redact-mode-'));
  inputPath = join(tempDir, 'in.pdf');
  await writeFile(inputPath, Buffer.from('%PDF-1.4 source'));
});

describe('mode on the wire', () => {
  it('survives the empty-rule cleaning, which rebuilds the rules field by field', () => {
    expect(withoutEmptyRules({ mode: 'pseudonymize' })).toEqual({ mode: 'pseudonymize' });
    expect(withoutEmptyRules({ pii_excluded_terms: [], mode: 'pseudonymize' })).toEqual({ mode: 'pseudonymize' });
  });

  it('is sent on the multipart path, and omitted when not given', async () => {
    const fetchImpl = api();
    const client = new RedactPdfClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.createJob([file], { mode: 'pseudonymize' });
    await client.createJob([file], {});

    expect((await sentForm(callAt(fetchImpl, 0)[1])).get('mode')).toBe('pseudonymize');
    expect((await sentForm(callAt(fetchImpl, 1)[1])).has('mode')).toBe(false);
  });

  it('is sent on the direct-upload path', async () => {
    const big: InputFile = { filename: 'big.pdf', contentType: 'application/pdf', bytes: new Uint8Array(9 * 1024 * 1024) };
    const fetchImpl = fetchMock()
      .mockResolvedValueOnce(jsonResponse({ job_id: 'j', uploads: [] }))
      .mockResolvedValueOnce(jsonResponse(job()));
    await new RedactPdfClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch }).createJob([big], { mode: 'pseudonymize' });

    const body = JSON.parse(String(callAt(fetchImpl, 0)[1].body)) as Record<string, unknown>;
    expect(body.mode).toBe('pseudonymize');
  });

  it('is sent to the keyless demo', async () => {
    const fetchImpl = api();
    await new RedactPdfClient({ fetchImpl: fetchImpl as unknown as typeof fetch }).demoRedact(file, { mode: 'pseudonymize' });

    expect((await sentForm(callAt(fetchImpl, 0)[1])).get('mode')).toBe('pseudonymize');
  });

  it('changes the derived idempotency key only when it changes the output', () => {
    const legacy = deriveIdempotencyKey([file], {});
    expect(deriveIdempotencyKey([file], { mode: 'redact' })).toBe(legacy);
    expect(deriveIdempotencyKey([file], { mode: 'pseudonymize' })).not.toBe(legacy);
  });
});

describe('mode as a tool argument', () => {
  it('reaches the wire from redact_pdf and shows on the job', async () => {
    const fetchImpl = api({ jobMode: 'pseudonymize' });
    const client = await connect('stdio', fetchImpl);
    const out = payload(await client.callTool({ name: 'redact_pdf', arguments: { file_path: inputPath, mode: 'pseudonymize' } }));

    expect((await sentForm(callAt(fetchImpl, 0)[1])).get('mode')).toBe('pseudonymize');
    expect(out.mode).toBe('pseudonymize');
  });

  it('reports redact for a job from a server that predates modes', async () => {
    const client = await connect('stdio', api());
    const out = payload(await client.callTool({ name: 'get_job_status', arguments: { job_id: 'job-1' } }));
    expect(out.mode).toBe('redact');
  });

  it('rejects an unknown mode before uploading anything', async () => {
    const fetchImpl = api();
    const client = await connect('stdio', fetchImpl);
    const result = await client.callTool({ name: 'redact_pdf', arguments: { file_path: inputPath, mode: 'blur' } });

    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('redact_pdf_and_wait with pseudonymize', () => {
  it('stdio: writes the correspondence table next to the PDF', async () => {
    const fetchImpl = api({ jobMode: 'pseudonymize' });
    const client = await connect('stdio', fetchImpl);
    const out = payload(await client.callTool({
      name: 'redact_pdf_and_wait',
      arguments: { file_path: inputPath, mode: 'pseudonymize', timeout_seconds: 10 },
    }));

    expect(out.status).toBe('redacted');
    expect(out.mode).toBe('pseudonymize');
    expect(out.correspondence_path).toBe(join(tempDir, 'in-correspondence.csv'));
    expect(await readFile(out.correspondence_path as string, 'utf8')).toBe(CSV);
    expect(new Uint8Array(await readFile(out.output_path as string))).toEqual(REDACTED_PDF);
  });

  it('stdio: never overwrites an existing table, and still reports the PDF as done', async () => {
    const existing = join(tempDir, 'in-correspondence.csv');
    await writeFile(existing, 'mine');
    const client = await connect('stdio', api({ jobMode: 'pseudonymize' }));
    const result = await client.callTool({
      name: 'redact_pdf_and_wait',
      arguments: { file_path: inputPath, mode: 'pseudonymize', timeout_seconds: 10 },
    });
    const out = payload(result);

    expect(result.isError).toBeFalsy();
    expect(out.status).toBe('redacted');
    expect(String(out.correspondence_error)).toMatch(/already exists/);
    expect(String(out.correspondence_error)).toMatch(/do not redact again/i);
    expect(await readFile(existing, 'utf8')).toBe('mine');
  });

  it('http: returns the table inline', async () => {
    const client = await connect('http', api({ jobMode: 'pseudonymize' }));
    const out = payload(await client.callTool({
      name: 'redact_pdf_and_wait',
      arguments: { file_base64: Buffer.from('%PDF-1.4').toString('base64'), filename: 'in.pdf', mode: 'pseudonymize', timeout_seconds: 10 },
    }));

    // Response.text() drops the BOM: agents get the plain table.
    expect(out.correspondence_csv).toBe(CSV_BODY);
    expect(String(out.note)).toMatch(/re-identifies/);
  });

  it('a failed table fetch is reported, not turned into a failed (and re-run) redaction', async () => {
    const client = await connect('http', api({ jobMode: 'pseudonymize', correspondence: () => jsonResponse({ error: 'x' }, 404) }));
    const result = await client.callTool({
      name: 'redact_pdf_and_wait',
      arguments: { file_base64: Buffer.from('%PDF-1.4').toString('base64'), filename: 'in.pdf', mode: 'pseudonymize', timeout_seconds: 10 },
    });
    const out = payload(result);

    expect(result.isError).toBeFalsy();
    expect(out.status).toBe('redacted');
    expect(out.content_base64).toBeDefined();
    expect(String(out.correspondence_error)).toMatch(/download_correspondence tool \(document_id "doc-1"\)/);
  });

  it('stdio: a failed table fetch writes no file and still reports the PDF as done', async () => {
    const client = await connect('stdio', api({ jobMode: 'pseudonymize', correspondence: () => jsonResponse({ error: 'x' }, 404) }));
    const result = await client.callTool({
      name: 'redact_pdf_and_wait',
      arguments: { file_path: inputPath, mode: 'pseudonymize', timeout_seconds: 10 },
    });
    const out = payload(result);

    expect(result.isError).toBeFalsy();
    expect(out.status).toBe('redacted');
    expect(out.correspondence_path).toBeUndefined();
    expect(String(out.correspondence_error)).toMatch(/download_correspondence tool \(document_id "doc-1"\)/);
    await expect(readFile(join(tempDir, 'in-correspondence.csv'))).rejects.toThrow();
  });

  it('http: redact mode never asks for a table', async () => {
    const fetchImpl = api();
    const client = await connect('http', fetchImpl);
    const out = payload(await client.callTool({
      name: 'redact_pdf_and_wait',
      arguments: { file_base64: Buffer.from('%PDF-1.4').toString('base64'), filename: 'in.pdf', timeout_seconds: 10 },
    }));

    expect(out.mode).toBe('redact');
    expect(out.correspondence_csv).toBeUndefined();
    expect(out.correspondence_error).toBeUndefined();
    expect(calledPaths(fetchImpl).some(path => path.endsWith('/correspondence'))).toBe(false);
  });

  it('redact mode never asks for a table', async () => {
    const fetchImpl = api();
    const client = await connect('stdio', fetchImpl);
    const out = payload(await client.callTool({ name: 'redact_pdf_and_wait', arguments: { file_path: inputPath, timeout_seconds: 10 } }));

    expect(out.mode).toBe('redact');
    expect(out.correspondence_path).toBeUndefined();
    expect(calledPaths(fetchImpl).some(path => path.endsWith('/correspondence'))).toBe(false);
  });

  it('follows the job the server returned, not the argument (an idempotent replay keeps its first mode)', async () => {
    const fetchImpl = api({ jobMode: 'redact' });
    const client = await connect('stdio', fetchImpl);
    const out = payload(await client.callTool({
      name: 'redact_pdf_and_wait',
      arguments: { file_path: inputPath, mode: 'pseudonymize', timeout_seconds: 10 },
    }));

    expect(out.mode).toBe('redact');
    expect(calledPaths(fetchImpl).some(path => path.endsWith('/correspondence'))).toBe(false);
  });
});

describe('try_demo with pseudonymize', () => {
  it('passes the mode and lists the tags drawn', async () => {
    const fetchImpl = api();
    const client = await connect('stdio', fetchImpl);
    const out = payload(await client.callTool({ name: 'try_demo', arguments: { file_path: inputPath, mode: 'pseudonymize' } }));

    expect((await sentForm(callAt(fetchImpl, 0)[1])).get('mode')).toBe('pseudonymize');
    expect(out.mode).toBe('first_page');
    expect(out.redaction_mode).toBe('pseudonymize');
    expect(out.tags).toEqual(['[P1]', '[P2]']);
  });
});

describe('correspondencePath', () => {
  it('sits next to the PDF, named after the document', () => {
    expect(correspondencePath('/a/b/report-redacted.pdf')).toBe('/a/b/report-correspondence.csv');
    expect(correspondencePath('/a/b/out.pdf')).toBe('/a/b/out-correspondence.csv');
  });
});


describe('servers that predate modes', () => {
  it('a job without a mode field was drawn in black boxes, whatever was asked', async () => {
    const fetchImpl = api({ jobMode: undefined });
    const client = await connect('stdio', fetchImpl);
    const out = payload(await client.callTool({
      name: 'redact_pdf_and_wait',
      arguments: { file_path: inputPath, mode: 'pseudonymize', timeout_seconds: 10 },
    }));

    expect(out.mode).toBe('redact');
    expect(String(out.note)).not.toMatch(/tag/);
    expect(calledPaths(fetchImpl).some(path => path.endsWith('/correspondence'))).toBe(false);
  });

  it('a demo answer without mode or tags reads as redact', async () => {
    const client = await connect('stdio', api({ demoMode: null }));
    const out = payload(await client.callTool({ name: 'try_demo', arguments: { file_path: inputPath } }));

    expect(out.redaction_mode).toBe('redact');
    expect(out.tags).toBeUndefined();
  });
});

describe('download_correspondence', () => {
  it('stdio: writes the table with a BOM, never over an existing file', async () => {
    const client = await connect('stdio', api());
    const target = join(tempDir, 'table.csv');
    const out = payload(await client.callTool({ name: 'download_correspondence', arguments: { document_id: 'doc-1', output_path: target } }));

    expect(out.output_path).toBe(target);
    expect(await readFile(target, 'utf8')).toBe(CSV);

    const again = await client.callTool({ name: 'download_correspondence', arguments: { document_id: 'doc-1', output_path: target } });
    expect(again.isError).toBe(true);
    expect(await readFile(target, 'utf8')).toBe(CSV);
  });

  it('http: returns the table inline, with the warning', async () => {
    const client = await connect('http', api());
    const out = payload(await client.callTool({ name: 'download_correspondence', arguments: { document_id: 'doc-1' } }));

    expect(out.correspondence_csv).toBe(CSV_BODY);
    expect(String(out.note)).toMatch(/re-identifies/);
  });

  it('a redact-mode document has no table: an error, not an empty file', async () => {
    const client = await connect('stdio', api({ correspondence: () => jsonResponse({ error: 'No correspondence table' }, 404) }));
    const target = join(tempDir, 'none.csv');
    const result = await client.callTool({ name: 'download_correspondence', arguments: { document_id: 'doc-1', output_path: target } });

    expect(result.isError).toBe(true);
    await expect(readFile(target)).rejects.toThrow();
  });
});

describe('correspondence errors say what helps, not "retry"', () => {
  it.each([
    [409, /edited in the Redact PDF AI Studio/, 'conflict'],
    [422, /analysed in redact mode/, 'invalid_request'],
    [404, /not redacted with mode "pseudonymize"/, 'not_found'],
  ])('maps %i', async (status, message, code) => {
    const client = await connect('http', api({ correspondence: () => jsonResponse({ error: 'x' }, status) }));
    const result = await client.callTool({ name: 'download_correspondence', arguments: { document_id: 'doc-1' } });
    const out = payload(result);

    expect(result.isError).toBe(true);
    expect(String(out.error)).toMatch(message);
    expect(String(out.error)).not.toMatch(/AGAIN WITH THE SAME arguments|idempotency/);
    expect(out.code).toBe(code);
    expect(out.retryable).toBe(false);
  });
});


describe('auto-fetch failure advice', () => {
  it('does not send the agent to fetch again when the table needs the user first', async () => {
    const client = await connect('http', api({ jobMode: 'pseudonymize', correspondence: () => jsonResponse({ error: 'x' }, 409) }));
    const out = payload(await client.callTool({
      name: 'redact_pdf_and_wait',
      arguments: { file_base64: Buffer.from('%PDF-1.4').toString('base64'), filename: 'in.pdf', mode: 'pseudonymize', timeout_seconds: 10 },
    }));

    expect(out.status).toBe('redacted');
    expect(String(out.correspondence_error)).toMatch(/Studio/);
    expect(String(out.correspondence_error)).not.toMatch(/Get it later/);
    expect(String(out.correspondence_error)).toMatch(/Do not redact again/);
  });
});
