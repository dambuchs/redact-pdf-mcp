/**
 * The "don't make the user pay twice" machinery.
 *
 * Everything after a job is created has already cost the user pages, so a
 * failure there must hand back the ids needed to resume. Mutation testing found
 * this entire path deletable with the suite still green — and that the resume
 * hint was pointing the wrong way.
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { RedactPdfClient } from '../src/client.js';
import { createServer } from '../src/server.js';
import { fetchMock, jsonResponse, payload } from './helpers.js';
import type { DocumentStatus } from '../src/types.js';

let inputPath: string;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'resume-'));
  inputPath = join(dir, 'in.pdf');
  await writeFile(inputPath, Buffer.from('%PDF-1.4'));
});

const job = (status: DocumentStatus, error: string | null = null) =>
  jsonResponse({
    job_id: 'job-9',
    status,
    retention: 'ephemeral',
    created_at: '2026-08-22T00:00:00Z',
    documents: [{ id: 'doc-9', file_name: 'in.pdf', status, page_count: 1, error_message: error }],
  });

async function callRedact(fetchImpl: unknown) {
  const mcp = new Client({ name: 't', version: '1' });
  const server = createServer({
    mode: 'stdio',
    client: new RedactPdfClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as typeof fetch,
      sleep: async () => {},
    }),
    pollOptions: { sleep: async () => {}, initialDelayMs: 1 },
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), mcp.connect(a)]);
  return mcp.callTool({
    name: 'redact_pdf_and_wait',
    arguments: { file_path: inputPath, timeout_seconds: 10 },
  });
}

describe('a failure after billing hands back the job', () => {
  it('carries job_id and tells the agent not to re-upload', async () => {
    const fetchImpl = fetchMock()
      .mockResolvedValueOnce(job('analyzing'))
      .mockResolvedValueOnce(job('error', 'password protected'));

    const out = payload(await callRedact(fetchImpl));
    expect(out.job_id).toBe('job-9');
    expect(out.do_not_re_upload).toMatch(/already submitted and billed/i);
  });

  it('does NOT send the agent to download output that was never produced', async () => {
    // The redaction failed, so there is nothing to download. Pointing at
    // download_redacted here wastes a call and contradicts the error text.
    const fetchImpl = fetchMock()
      .mockResolvedValueOnce(job('analyzing'))
      .mockResolvedValueOnce(job('error', 'password protected'));

    const out = payload(await callRedact(fetchImpl));
    expect(out.resume_with).toEqual({ tool: 'get_job_status', job_id: 'job-9' });
    expect(out.document_id).toBeUndefined();
  });

  it('DOES send the agent to download when the redaction succeeded and only the download failed', async () => {
    const fetchImpl = fetchMock()
      .mockResolvedValueOnce(job('analyzing'))
      .mockResolvedValueOnce(job('redacted'))
      .mockResolvedValue(
        new Response(JSON.stringify({ error: 'boom', code: 'error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const out = payload(await callRedact(fetchImpl));
    expect(out.resume_with).toEqual({ tool: 'download_redacted', document_id: 'doc-9' });
  });

  it('keeps the job id even when the download dies mid-stream as a raw TypeError', async () => {
    // downloadOutput reads the body outside the client's try/catch, so a
    // connection reset arrives as a bare TypeError rather than a RedactPdfError.
    const brokenBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new TypeError('terminated'));
      },
    });
    const fetchImpl = fetchMock()
      .mockResolvedValueOnce(job('analyzing'))
      .mockResolvedValueOnce(job('redacted'))
      .mockResolvedValueOnce(new Response(brokenBody));

    const out = payload(await callRedact(fetchImpl));
    expect(out.job_id).toBe('job-9');
    expect(out.document_id).toBe('doc-9');
    expect(out.resume_with).toEqual({ tool: 'download_redacted', document_id: 'doc-9' });
  });
});
