/**
 * End-to-end tool tests over an in-memory MCP transport pair: a real client
 * talks to a real server, so tool listing, schemas and handler output are all
 * exercised the way an agent would exercise them.
 */

import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callAt, fetchMock, jsonResponse, payload } from './helpers.js';
import { METADATA_TIMEOUT_MS, RedactPdfClient } from '../src/client.js';
import { createServer, defaultOutputPath, type ServerMode } from '../src/server.js';
import type { Job } from '../src/types.js';

const REDACTED_PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // "%PDF-1.7"

function job(overrides: Partial<Job> = {}): Job {
  const status = overrides.status ?? 'redacted';
  return {
    job_id: 'job-1',
    status,
    retention: 'ephemeral',
    created_at: '2026-08-22T00:00:00Z',
    // Default the document to the job's own status: the API derives one from the
    // other, so a fixture that lets them drift describes an impossible response.
    documents: [
      { id: 'doc-1', file_name: 'in.pdf', status, page_count: 3, error_message: null },
    ],
    ...overrides,
  };
}

async function connect(
  mode: ServerMode,
  fetchImpl: typeof fetch,
  { apiKey }: { apiKey?: string | undefined } = { apiKey: 'k' },
) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  const server = createServer({
    mode,
    client: new RedactPdfClient({ apiKey, fetchImpl, sleep: async () => {} }),
    fetchImpl,
    // Stub DNS: without this the URL-guard tests resolve example.com for real
    // on every CI run, so the "offline" suite was not offline.
    resolveHost: async () => ['93.184.216.34'],
    // Poll on a virtual clock so the suite does not spend real seconds waiting.
    pollOptions: { sleep: async () => {}, initialDelayMs: 1 },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

let tempDir: string;
let inputPath: string;

beforeEach(async () => {
  // URL input is off by default on the remote server (DNS-rebinding gap); the
  // tests below that exercise it opt in, exactly as an operator would.
  process.env.REDACT_PDF_ENABLE_URL_INPUT = '1';
  tempDir = await mkdtemp(join(tmpdir(), 'redact-mcp-'));
  inputPath = join(tempDir, 'in.pdf');
  await writeFile(inputPath, Buffer.from('%PDF-1.4 fake source document'));
});

afterEach(() => {
  delete process.env.REDACT_PDF_ENABLE_URL_INPUT;
  vi.restoreAllMocks();
});

describe('tool listing', () => {
  it('lists the one-call tool first, because agents pick the first plausible match', async () => {
    const { client } = await connect('stdio', fetchMock() as unknown as typeof fetch);
    const { tools } = await client.listTools();
    expect(tools[0]?.name).toBe('redact_pdf_and_wait');
  });

  it('exposes exactly the six documented tools', async () => {
    const { client } = await connect('stdio', fetchMock() as unknown as typeof fetch);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      'redact_pdf_and_wait',
      'redact_pdf',
      'get_job_status',
      'download_redacted',
      'try_demo',
      'get_account_status',
    ]);
  });

  it('offers file_path only in stdio mode, where the server can actually read disk', async () => {
    const { client } = await connect('stdio', fetchMock() as unknown as typeof fetch);
    const { tools } = await client.listTools();
    const props = tools[0]?.inputSchema.properties as Record<string, unknown>;
    expect(props).toHaveProperty('file_path');
    expect(props).toHaveProperty('output_path');
    expect(props).not.toHaveProperty('file_url');
  });

  it('offers file_url / file_base64 only in remote mode, which has no user filesystem', async () => {
    const { client } = await connect('http', fetchMock() as unknown as typeof fetch);
    const { tools } = await client.listTools();
    const props = tools[0]?.inputSchema.properties as Record<string, unknown>;
    expect(props).toHaveProperty('file_url');
    expect(props).toHaveProperty('file_base64');
    expect(props).not.toHaveProperty('file_path');
    expect(props).not.toHaveProperty('output_path');
  });

  it('does not advertise file_url on a remote server by default', async () => {
    // The address guard cannot survive DNS rebinding, so an internet-reachable
    // server offers no URL-fetch surface unless an operator opts in.
    delete process.env.REDACT_PDF_ENABLE_URL_INPUT;
    const { client } = await connect('http', fetchMock() as unknown as typeof fetch);
    const { tools } = await client.listTools();
    const props = tools[0]?.inputSchema.properties as Record<string, unknown>;
    expect(props).not.toHaveProperty('file_url');
    expect(props).toHaveProperty('file_base64');
  });

  it('refuses a file_url argument when URL input is disabled', async () => {
    delete process.env.REDACT_PDF_ENABLE_URL_INPUT;
    const fetchImpl = fetchMock();
    const { client } = await connect('http', fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: 'redact_pdf',
      arguments: { file_url: 'https://example.com/a.pdf' },
    });
    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('declares redact_pdf_and_wait as writing to disk in stdio mode', async () => {
    // This is the tool that writes the actual redacted output; if it claimed to
    // be read-only, MCP clients would auto-approve it without prompting.
    const { client } = await connect('stdio', fetchMock() as unknown as typeof fetch);
    const { tools } = await client.listTools();
    const primary = tools.find((t) => t.name === 'redact_pdf_and_wait');
    expect(primary?.annotations?.readOnlyHint).toBe(false);
    expect(primary?.annotations?.destructiveHint).toBe(true);
  });

  it('tells the model that images are accepted, not just PDFs', async () => {
    // Observed in real use: an agent converted a screenshot to PDF before
    // calling this server, because the tool name and headline both say "PDF".
    // Image support existed the whole time; it just was not where the model
    // looks. If these assertions fail, that regression is back.
    const { client } = await connect('stdio', fetchMock() as unknown as typeof fetch);
    const { tools } = await client.listTools();

    for (const name of ['redact_pdf_and_wait', 'redact_pdf']) {
      const description = tools.find((t) => t.name === name)?.description ?? '';
      expect(description, `${name} must name the accepted formats`).toMatch(/JPEG and PNG/i);
      expect(description, `${name} must discourage pre-converting`).toMatch(/do NOT convert/i);
    }
  });

  it('describes the tools in terms of what redaction actually is', async () => {
    const { client } = await connect('stdio', fetchMock() as unknown as typeof fetch);
    const { tools } = await client.listTools();
    const primary = tools[0]?.description ?? '';
    expect(primary).toMatch(/irreversible/i);
    expect(primary).toMatch(/not hidden behind a black rectangle/i);
    expect(primary).toMatch(/OCR/);
  });
});

describe('redact_pdf_and_wait (stdio)', () => {
  it('uploads, waits, and writes the redacted PDF next to the original', async () => {
    const fetchImpl = fetchMock()
      .mockResolvedValueOnce(jsonResponse(job({ status: 'analyzing' }))) // POST /v1/jobs
      .mockResolvedValueOnce(jsonResponse(job())) // GET status -> redacted
      .mockResolvedValueOnce(new Response(REDACTED_PDF)); // GET output

    const { client } = await connect('stdio', fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: 'redact_pdf_and_wait',
      arguments: { file_path: inputPath, timeout_seconds: 10 },
    });

    const out = payload(result);
    expect(out.status).toBe('redacted');
    expect(out.output_path).toBe(defaultOutputPath(inputPath));
    expect(out.pages_redacted).toBe(3);

    const written = await readFile(out.output_path as string);
    expect(new Uint8Array(written)).toEqual(REDACTED_PDF);
  });

  it('bounds every status read by the metadata timeout as well as the budget', async () => {
    // Two regressions have lived in this one call site, and neither is visible
    // in tool output. Letting the client's own 3 attempts nest inside the loop
    // that IS the retry produced ~38x the request volume and ran a 10s budget
    // for 95s. Passing only the remaining budget then let ONE read own the
    // entire wait: with the 300s default the first poll issued a single ~298s
    // request, so an upstream that accepts the connection and then hangs was
    // never retried at all. Assert the wiring, since nothing else can.
    const seen: Array<{ maxAttempts?: number; timeoutMs?: number }> = [];
    vi.spyOn(RedactPdfClient.prototype, 'getJob').mockImplementation(async (_id, options = {}) => {
      seen.push(options);
      return job();
    });

    const fetchImpl = fetchMock()
      .mockResolvedValueOnce(jsonResponse(job({ status: 'analyzing' }))) // POST /v1/jobs
      .mockResolvedValueOnce(new Response(REDACTED_PDF)); // GET output

    const { client } = await connect('stdio', fetchImpl as unknown as typeof fetch);
    // No timeout_seconds: exercise the full 300s default, where the unclamped
    // read timeout was at its worst.
    await client.callTool({
      name: 'redact_pdf_and_wait',
      arguments: { file_path: inputPath },
    });

    expect(seen.length).toBeGreaterThan(0);
    for (const options of seen) {
      expect(options.maxAttempts).toBe(1);
      expect(options.timeoutMs).toBeLessThanOrEqual(METADATA_TIMEOUT_MS);
      expect(options.timeoutMs).toBeGreaterThanOrEqual(1_000);
    }
  });

  it('leaves the original file untouched', async () => {
    const before = await readFile(inputPath);
    const fetchImpl = fetchMock()
      .mockResolvedValueOnce(jsonResponse(job({ status: 'analyzing' })))
      .mockResolvedValueOnce(jsonResponse(job()))
      .mockResolvedValueOnce(new Response(REDACTED_PDF));

    const { client } = await connect('stdio', fetchImpl as unknown as typeof fetch);
    await client.callTool({
      name: 'redact_pdf_and_wait',
      arguments: { file_path: inputPath, timeout_seconds: 10 },
    });

    expect(await readFile(inputPath)).toEqual(before);
  });

  it('honours an explicit output_path', async () => {
    const target = join(tempDir, 'nested-output.pdf');
    const fetchImpl = fetchMock()
      .mockResolvedValueOnce(jsonResponse(job({ status: 'analyzing' })))
      .mockResolvedValueOnce(jsonResponse(job()))
      .mockResolvedValueOnce(new Response(REDACTED_PDF));

    const { client } = await connect('stdio', fetchImpl as unknown as typeof fetch);
    const out = payload(
      await client.callTool({
        name: 'redact_pdf_and_wait',
        arguments: { file_path: inputPath, output_path: target, timeout_seconds: 10 },
      }),
    );
    expect(out.output_path).toBe(target);
    await expect(readFile(target)).resolves.toBeDefined();
  });

  it('reports a missing file as a tool error, not a crash', async () => {
    const { client } = await connect('stdio', fetchMock() as unknown as typeof fetch);
    const result = await client.callTool({
      name: 'redact_pdf_and_wait',
      arguments: { file_path: join(tempDir, 'nope.pdf') },
    });
    expect(result.isError).toBe(true);
    expect(payload(result).error).toMatch(/no such file/);
  });

  it('refuses an unsupported file type before uploading anything', async () => {
    const docx = join(tempDir, 'contract.docx');
    await writeFile(docx, 'not a pdf');
    const fetchImpl = fetchMock();

    const { client } = await connect('stdio', fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: 'redact_pdf_and_wait',
      arguments: { file_path: docx },
    });

    expect(result.isError).toBe(true);
    expect(payload(result).error).toMatch(/PDF, JPEG and PNG/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails loudly when the API silently accepted none of the files', async () => {
    // The ingest path drops files it cannot handle instead of erroring, so a
    // job can come back with zero documents. Polling that would hang to timeout.
    const fetchImpl = fetchMock().mockResolvedValueOnce(
      jsonResponse(job({ status: 'analyzing', documents: [] })),
    );

    const { client } = await connect('stdio', fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: 'redact_pdf_and_wait',
      arguments: { file_path: inputPath, timeout_seconds: 10 },
    });

    expect(result.isError).toBe(true);
    expect(payload(result).error).toMatch(/accepted none of the files/);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // never started polling
  });

  it('surfaces a document that finished in error, with the reason', async () => {
    const failed = job({
      status: 'error',
      documents: [
        { id: 'doc-1', file_name: 'in.pdf', status: 'error', page_count: 0, error_message: 'password protected' },
      ],
    });
    const fetchImpl = fetchMock()
      .mockResolvedValueOnce(jsonResponse(job({ status: 'analyzing' })))
      .mockResolvedValueOnce(jsonResponse(failed));

    const { client } = await connect('stdio', fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: 'redact_pdf_and_wait',
      arguments: { file_path: inputPath, timeout_seconds: 10 },
    });

    expect(result.isError).toBe(true);
    expect(payload(result).error).toMatch(/password protected/);
  });

  it('turns a quota failure into a non-retryable, actionable message', async () => {
    const fetchImpl = fetchMock(
      async () =>
        new Response(JSON.stringify({ error: 'Insufficient quota.', code: 'quota_exceeded', request_id: 'req_1' }), {
          status: 402,
          headers: { 'Content-Type': 'application/json' },
        }),
    );

    const { client } = await connect('stdio', fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: 'redact_pdf_and_wait',
      arguments: { file_path: inputPath },
    });

    const out = payload(result);
    expect(result.isError).toBe(true);
    expect(out.code).toBe('quota_exceeded');
    expect(out.retryable).toBe(false);
    expect(out.error).toMatch(/pricing/);
  });
});

describe('remote mode', () => {
  it('inlines the redacted PDF as base64 when it is small', async () => {
    const fetchImpl = fetchMock()
      .mockResolvedValueOnce(new Response(Buffer.from('%PDF-1.4 source'), { headers: { 'Content-Type': 'application/pdf' } })) // download source
      .mockResolvedValueOnce(jsonResponse(job({ status: 'analyzing' })))
      .mockResolvedValueOnce(jsonResponse(job()))
      .mockResolvedValueOnce(new Response(REDACTED_PDF));

    const { client } = await connect('http', fetchImpl as unknown as typeof fetch);
    const out = payload(
      await client.callTool({
        name: 'redact_pdf_and_wait',
        arguments: { file_url: 'https://example.com/contract.pdf', timeout_seconds: 10 },
      }),
    );

    expect(out.status).toBe('redacted');
    expect(Buffer.from(out.content_base64 as string, 'base64')).toEqual(Buffer.from(REDACTED_PDF));
  });

  it('rejects a non-http URL scheme by name, so the guard is what fails it', async () => {
    // Asserting only isError would pass with the scheme guard deleted, because
    // fetching file:// throws anyway. The message pins which layer refused.
    const fetchImpl = fetchMock();
    const { client } = await connect('http', fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: 'redact_pdf',
      arguments: { file_url: 'file:///etc/passwd' },
    });
    expect(result.isError).toBe(true);
    expect(payload(result).error).toMatch(/Only http\(s\) URLs are supported/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a URL aimed at the cloud metadata endpoint', async () => {
    const fetchImpl = fetchMock();
    const { client } = await connect('http', fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: 'redact_pdf',
      arguments: { file_url: 'http://169.254.169.254/latest/meta-data/' },
    });
    expect(result.isError).toBe(true);
    expect(payload(result).error).toMatch(/must point at a public internet host/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('requires a filename alongside base64 so the type can be determined', async () => {
    const { client } = await connect('http', fetchMock() as unknown as typeof fetch);
    const result = await client.callTool({
      name: 'redact_pdf',
      arguments: { file_base64: Buffer.from('%PDF-1.4').toString('base64') },
    });
    expect(result.isError).toBe(true);
    expect(payload(result).error).toMatch(/filename is required/);
  });
});

describe('download_redacted', () => {
  it('writes the redacted PDF to the requested path in stdio mode', async () => {
    const target = join(tempDir, 'out.pdf');
    const fetchImpl = fetchMock(async () => new Response(REDACTED_PDF));
    const { client } = await connect('stdio', fetchImpl as unknown as typeof fetch);

    const out = payload(
      await client.callTool({
        name: 'download_redacted',
        arguments: { document_id: 'doc-1', output_path: target },
      }),
    );

    expect(out.status).toBe('downloaded');
    expect(out.output_path).toBe(target);
    expect(new Uint8Array(await readFile(target))).toEqual(REDACTED_PDF);
  });

  it('refuses to silently overwrite an existing file', async () => {
    const target = join(tempDir, 'taken.pdf');
    await writeFile(target, 'precious');
    const fetchImpl = fetchMock(async () => new Response(REDACTED_PDF));
    const { client } = await connect('stdio', fetchImpl as unknown as typeof fetch);

    const result = await client.callTool({
      name: 'download_redacted',
      arguments: { document_id: 'doc-1', output_path: target },
    });

    expect(result.isError).toBe(true);
    expect(payload(result).error).toMatch(/already exists/);
    // The existing file is untouched.
    expect(await readFile(target, 'utf8')).toBe('precious');
  });

  it('does not clobber a file created after the call began', async () => {
    // The guard must be enforced by the filesystem, not by a stat() that a
    // concurrent write can slip past.
    const target = join(tempDir, 'racy.pdf');
    const fetchImpl = fetchMock(async () => {
      await writeFile(target, 'written by someone else');
      return new Response(REDACTED_PDF);
    });
    const { client } = await connect('stdio', fetchImpl as unknown as typeof fetch);

    const result = await client.callTool({
      name: 'download_redacted',
      arguments: { document_id: 'doc-1', output_path: target },
    });

    expect(result.isError).toBe(true);
    expect(await readFile(target, 'utf8')).toBe('written by someone else');
  });

  it('leaves no .partial file behind when it refuses to overwrite', async () => {
    const target = join(tempDir, 'existing.pdf');
    await writeFile(target, 'keep me');
    const fetchImpl = fetchMock(async () => new Response(REDACTED_PDF));
    const { client } = await connect('stdio', fetchImpl as unknown as typeof fetch);

    await client.callTool({
      name: 'download_redacted',
      arguments: { document_id: 'doc-1', output_path: target },
    });

    const leftovers = (await readdir(tempDir)).filter((name) => name.includes('.partial'));
    expect(leftovers).toEqual([]);
  });

  it('declares itself as writing to disk, so clients do not auto-approve it', async () => {
    const { client } = await connect('stdio', fetchMock() as unknown as typeof fetch);
    const { tools } = await client.listTools();
    const download = tools.find((t) => t.name === 'download_redacted');
    expect(download?.annotations?.readOnlyHint).toBe(false);
    expect(download?.annotations?.destructiveHint).toBe(true);
  });

  it('returns the bytes inline in remote mode, where there is no user disk', async () => {
    const fetchImpl = fetchMock(async () => new Response(REDACTED_PDF));
    const { client } = await connect('http', fetchImpl as unknown as typeof fetch);
    const out = payload(
      await client.callTool({ name: 'download_redacted', arguments: { document_id: 'doc-1' } }),
    );
    expect(Buffer.from(out.content_base64 as string, 'base64')).toEqual(Buffer.from(REDACTED_PDF));
  });

  it('returns a URL instead of inlining a file that is too big', async () => {
    const big = new Uint8Array(64);
    const fetchImpl = fetchMock(async () => new Response(big));
    const mcp = new Client({ name: 'test', version: '1.0.0' });
    const server = createServer({
      mode: 'http',
      client: new RedactPdfClient({
        apiKey: 'k',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep: async () => {},
      }),
      maxInlineBytes: 8,
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), mcp.connect(a)]);

    const out = payload(
      await mcp.callTool({ name: 'download_redacted', arguments: { document_id: 'doc-9' } }),
    );
    expect(out.content_base64).toBeUndefined();
    expect(out.download_url).toContain('/v1/documents/doc-9/output');
    expect(out.download_note).toMatch(/X-API-Key/);
  });
});

describe('get_account_status', () => {
  it('confirms a valid key and names the account', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse({ user_id: 'u_1', email: 'a@b.c' }));
    const { client } = await connect('stdio', fetchImpl as unknown as typeof fetch);
    const out = payload(await client.callTool({ name: 'get_account_status', arguments: {} }));

    expect(out.authenticated).toBe(true);
    expect(out.email).toBe('a@b.c');
    expect(callAt(fetchImpl, 0)[0]).toBe('https://www.redact-pdf.ai/v1/me');
  });

  it('turns a bad key into a non-retryable, actionable failure', async () => {
    const fetchImpl = fetchMock(
      async () =>
        new Response(JSON.stringify({ error: 'nope', code: 'unauthorized' }), { status: 401 }),
    );
    const { client } = await connect('stdio', fetchImpl as unknown as typeof fetch);
    const out = payload(await client.callTool({ name: 'get_account_status', arguments: {} }));

    expect(out.code).toBe('unauthorized');
    expect(out.retryable).toBe(false);
    expect(out.error).toMatch(/REDACT_PDF_API_KEY/);
  });
});

describe('try_demo', () => {
  const demoRedactBody = {
    status: 'ok',
    message: 'Redacted the first page of in.pdf (3 pages).',
    file_name: 'in.pdf',
    total_pages: 3,
    redacted_pages: 1,
    detected_pii: [{ category: 'Person', masks: 2 }],
    redacted_first_page_url: 'https://blob.example/in_demo.pdf?sig=x',
    link_expires_in_days: 14,
  };

  it('works with no API key configured and says so', async () => {
    const fetchImpl = fetchMock(async () =>
      jsonResponse({
        status: 'ok',
        message: 'demo',
        sample_input: 'Jane Sample',
        detected_pii: [{ category: 'Person', example: 'Jane Sample', masked: true }],
        redacted_pdf_path: '/v1/demo/sample.pdf',
      }),
    );

    const { client } = await connect('stdio', fetchImpl as unknown as typeof fetch, { apiKey: undefined });
    const out = payload(await client.callTool({ name: 'try_demo', arguments: {} }));

    expect(out.status).toBe('ok');
    expect(out.mode).toBe('sample');
    expect(out.api_key_configured).toBe(false);
    expect(out.next_step).toMatch(/sign-up/);
    // The ask must carry the offer, not just the URL.
    expect(out.next_step).toMatch(/first document \(up to 5 pages\)/);
    expect(out.redacted_sample_pdf).toBe('https://www.redact-pdf.ai/v1/demo/sample.pdf');
  });

  it('redacts the first page of a real file with no key', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(demoRedactBody));
    const { client } = await connect('stdio', fetchImpl as unknown as typeof fetch, { apiKey: undefined });
    const out = payload(
      await client.callTool({ name: 'try_demo', arguments: { file_path: inputPath, pii_categories: ['Person'] } }),
    );

    expect(out.mode).toBe('first_page');
    expect(out.total_pages).toBe(3);
    expect(out.detected_and_removed).toEqual([{ category: 'Person', masks: 2 }]);
    expect(out.redacted_first_page_pdf).toBe('https://blob.example/in_demo.pdf?sig=x');
    expect(out.next_step).toMatch(/Only the first page/);

    const [url, init] = callAt(fetchImpl, 0);
    expect(url).toBe('https://www.redact-pdf.ai/v1/demo/redact');
    expect(init.method).toBe('POST');
    // Keyless by contract: no key configured, and none must be sent.
    expect(new Headers(init.headers).get('X-API-Key')).toBeNull();
    const form = init.body as FormData;
    expect((form.get('file') as File).name).toBe('in.pdf');
    expect(form.get('pii_categories')).toBe('["Person"]');
  });

  it('validates categories with the same enum as the redact tools', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(demoRedactBody));
    const { client } = await connect('stdio', fetchImpl as unknown as typeof fetch, { apiKey: undefined });
    const { tools } = await client.listTools();
    const schema = tools.find((t) => t.name === 'try_demo')?.inputSchema as { properties: Record<string, { items?: { enum?: string[] } }> };
    expect(schema.properties.pii_categories?.items?.enum).toContain('Email');

    // A lowercase name must be refused by the schema before any upload, not
    // uploaded and reported as "no personal data found". The SDK answers a
    // schema violation with a plain-text error block, not our JSON envelope.
    const result = await client.callTool({ name: 'try_demo', arguments: { file_path: inputPath, pii_categories: ['email'] } });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    expect(text).toMatch(/pii_categories/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a source the transport cannot use instead of silently running the sample', async () => {
    delete process.env.REDACT_PDF_ENABLE_URL_INPUT; // hosted default: no URL fetching
    const fetchImpl = fetchMock(async () => jsonResponse(demoRedactBody));
    const hosted = await connect('http', fetchImpl as unknown as typeof fetch, { apiKey: undefined });
    const viaUrl = payload(
      await hosted.client.callTool({ name: 'try_demo', arguments: { file_url: 'https://example.com/a.pdf' } }),
    );
    expect(viaUrl.code).toBe('invalid_request');
    expect(viaUrl.error).toMatch(/file_base64/);
    const viaPath = payload(await hosted.client.callTool({ name: 'try_demo', arguments: { file_path: inputPath } }));
    expect(viaPath.code).toBe('invalid_request');
    expect(viaPath.error).toMatch(/hosted/);

    const local = await connect('stdio', fetchImpl as unknown as typeof fetch, { apiKey: undefined });
    const viaBase64 = payload(
      await local.client.callTool({ name: 'try_demo', arguments: { file_base64: 'JVBERi0xLjQ=', filename: 'a.pdf' } }),
    );
    expect(viaBase64.code).toBe('invalid_request');
    expect(viaBase64.error).toMatch(/file_path/);

    // None of those reached the network: no sample call, no upload.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a file over the demo cap before touching the network', async () => {
    const bigPath = join(tempDir, 'big.pdf');
    await writeFile(bigPath, Buffer.alloc(5 * 1024 * 1024 + 1, 0x20));
    const fetchImpl = fetchMock(async () => jsonResponse(demoRedactBody));
    const { client } = await connect('stdio', fetchImpl as unknown as typeof fetch, { apiKey: undefined });
    const out = payload(await client.callTool({ name: 'try_demo', arguments: { file_path: bigPath } }));

    expect(out.code).toBe('invalid_request');
    expect(out.error).toMatch(/5 MB/);
    expect(out.error).toMatch(/redact_pdf_and_wait/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('accepts an inline file on the remote transport', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(demoRedactBody));
    const { client } = await connect('http', fetchImpl as unknown as typeof fetch, { apiKey: undefined });
    const out = payload(
      await client.callTool({
        name: 'try_demo',
        arguments: { file_base64: Buffer.from('%PDF-1.4').toString('base64'), filename: 'inline.pdf' },
      }),
    );

    expect(out.mode).toBe('first_page');
    const [, init] = callAt(fetchImpl, 0);
    expect(((init.body as FormData).get('file') as File).name).toBe('inline.pdf');
  });
});

describe('get_job_status', () => {
  it('tells the agent to wait rather than poll tightly while work is in flight', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(job({ status: 'analyzing' })));
    const { client } = await connect('stdio', fetchImpl as unknown as typeof fetch);
    const out = payload(await client.callTool({ name: 'get_job_status', arguments: { job_id: 'job-1' } }));

    expect(out.is_final).toBe(false);
    expect(out.next_step).toMatch(/wait a few seconds/);
  });

  it('points at download_redacted once the job is final', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(job()));
    const { client } = await connect('stdio', fetchImpl as unknown as typeof fetch);
    const out = payload(await client.callTool({ name: 'get_job_status', arguments: { job_id: 'job-1' } }));

    expect(out.is_final).toBe(true);
    expect(out.next_step).toMatch(/download_redacted/);
  });
});

describe('defaultOutputPath', () => {
  it('adds a -redacted suffix beside the original', () => {
    expect(defaultOutputPath('/tmp/report.pdf')).toBe('/tmp/report-redacted.pdf');
  });

  it('gives converted images a .pdf extension, since that is what comes back', () => {
    expect(defaultOutputPath('/tmp/scan.png')).toBe('/tmp/scan-redacted.pdf');
  });

  it('handles a name with dots', () => {
    expect(defaultOutputPath('/tmp/2026.q3.report.pdf')).toBe('/tmp/2026.q3.report-redacted.pdf');
  });
});
