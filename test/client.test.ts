import { describe, expect, it, vi } from 'vitest';
import { callAt, fetchMock, jsonResponse, rejection } from './helpers.js';
import {
  assertUploadable,
  matchSlotToFile,
  deriveIdempotencyKey,
  DIRECT_UPLOAD_THRESHOLD_BYTES,
  RedactPdfClient,
} from '../src/client.js';
import { RedactPdfError } from '../src/errors.js';
import type { InputFile } from '../src/types.js';

const noSleep = async () => {};

function pdf(name: string, bytes: number, fill = 1): InputFile {
  return {
    filename: name,
    contentType: 'application/pdf',
    bytes: new Uint8Array(bytes).fill(fill),
  };
}

function errorResponse(status: number, code: string, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify({ error: 'nope', code, request_id: 'req_abc' }), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

describe('deriveIdempotencyKey', () => {
  it('is stable for identical input, so a retrying agent is not billed twice', () => {
    const a = deriveIdempotencyKey([pdf('a.pdf', 10)], { retention: 'ephemeral' });
    const b = deriveIdempotencyKey([pdf('a.pdf', 10)], { retention: 'ephemeral' });
    expect(a).toBe(b);
  });

  it('changes when the bytes change', () => {
    const a = deriveIdempotencyKey([pdf('a.pdf', 10, 1)], {});
    const b = deriveIdempotencyKey([pdf('a.pdf', 10, 2)], {});
    expect(a).not.toBe(b);
  });

  it('changes when the redaction rules change', () => {
    const a = deriveIdempotencyKey([pdf('a.pdf', 10)], { pii_categories: ['Person'] });
    const b = deriveIdempotencyKey([pdf('a.pdf', 10)], { pii_categories: ['Email'] });
    expect(a).not.toBe(b);
  });

  it('ignores the order rules were listed in', () => {
    const a = deriveIdempotencyKey([pdf('a.pdf', 10)], { pii_categories: ['Person', 'Email'] });
    const b = deriveIdempotencyKey([pdf('a.pdf', 10)], { pii_categories: ['Email', 'Person'] });
    expect(a).toBe(b);
  });

  it('distinguishes an omitted rule from an empty one', () => {
    const a = deriveIdempotencyKey([pdf('a.pdf', 10)], {});
    const b = deriveIdempotencyKey([pdf('a.pdf', 10)], { pii_included_terms: [] });
    expect(a).not.toBe(b);
  });

  it('changes when only the retention mode differs', () => {
    // Otherwise a `studio` request replays an `ephemeral` job, silently giving
    // the caller different retention than they asked for.
    const a = deriveIdempotencyKey([pdf('a.pdf', 10)], { retention: 'ephemeral' });
    const b = deriveIdempotencyKey([pdf('a.pdf', 10)], { retention: 'studio' });
    expect(a).not.toBe(b);
  });

  it('stays within the API key length limit', () => {
    expect(deriveIdempotencyKey([pdf('a.pdf', 10)], {}).length).toBeLessThanOrEqual(200);
  });
});

describe('assertUploadable', () => {
  it('rejects an empty file list', () => {
    expect(() => assertUploadable([])).toThrow(RedactPdfError);
  });

  it('rejects more files than a job accepts', () => {
    const files = Array.from({ length: 101 }, (_, i) => pdf(`f${i}.pdf`, 10));
    expect(() => assertUploadable(files)).toThrow(/at most 100 files/);
  });

  it('rejects a PDF over 50 MB with the size in the message', () => {
    expect(() => assertUploadable([pdf('big.pdf', 51 * 1024 * 1024)])).toThrow(/51\.0 MB/);
  });

  it('applies the tighter 10 MB limit to images', () => {
    const image: InputFile = {
      filename: 'scan.png',
      contentType: 'image/png',
      bytes: new Uint8Array(11 * 1024 * 1024),
    };
    expect(() => assertUploadable([image])).toThrow(/10 MB limit for images/);
  });
});

describe('error mapping', () => {
  it('does not retry a bad API key', async () => {
    const fetchImpl = fetchMock(async () => errorResponse(401, 'unauthorized'));
    const client = new RedactPdfClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep });

    await expect(client.me()).rejects.toMatchObject({ code: 'unauthorized', retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry an exhausted quota, and says so', async () => {
    const fetchImpl = fetchMock(async () => errorResponse(402, 'quota_exceeded'));
    const client = new RedactPdfClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep });

    const error = await rejection(client.me());
    expect(error.code).toBe('quota_exceeded');
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('Do not retry');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a 429 and honours Retry-After', async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = fetchMock()
      .mockResolvedValueOnce(errorResponse(429, 'rate_limited', { 'Retry-After': '7' }))
      .mockResolvedValueOnce(jsonResponse({ user_id: 'u', email: 'a@b.c' }));

    const client = new RedactPdfClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, sleep });
    await expect(client.me()).resolves.toMatchObject({ user_id: 'u' });
    // Honoured, plus a little jitter so a rate-limited fleet does not retry in
    // lockstep. Measured without it: six retries within a 5 ms spread.
    const waited = (sleep.mock.calls.at(0) as unknown as [number])[0];
    expect(waited).toBeGreaterThanOrEqual(7_000);
    expect(waited).toBeLessThan(7_300);
  });

  it('gives up rather than retry futilely when the server asks for longer than we will wait', async () => {
    // The limiter uses a FIXED window, so sleeping less than it asked lands in
    // the same window and 429s again. Measured: three attempts, three identical
    // failures, triple the load on the limiter that just asked for relief.
    const sleep = vi.fn(async () => {});
    const fetchImpl = fetchMock(async () =>
      errorResponse(429, 'rate_limited', { 'Retry-After': '60' }),
    );

    const client = new RedactPdfClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
    });
    await expect(client.me()).rejects.toMatchObject({ code: 'rate_limited' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('floors a Retry-After of 0 so retries are not fired back to back', async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = fetchMock()
      .mockResolvedValueOnce(errorResponse(429, 'rate_limited', { 'Retry-After': '0' }))
      .mockResolvedValueOnce(jsonResponse({ user_id: 'u', email: 'a@b.c' }));

    const client = new RedactPdfClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
    });
    await client.me();
    const firstSleep = sleep.mock.calls.at(0) as unknown as [number] | undefined;
    expect(firstSleep?.[0]).toBeGreaterThanOrEqual(250);
  });

  it('retries a thrown network error, not just an HTTP status', async () => {
    // Every other failure test uses a status code; the throw path was untested.
    const fetchImpl = fetchMock()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse({ user_id: 'u', email: 'a@b.c' }));

    const client = new RedactPdfClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    await expect(client.me()).resolves.toMatchObject({ user_id: 'u' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('never follows a redirect while carrying the API key', async () => {
    // undici strips Authorization cross-origin but replays X-API-Key verbatim.
    const fetchImpl = fetchMock(async () => jsonResponse({ user_id: 'u', email: 'a@b.c' }));
    const client = new RedactPdfClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    await client.me();
    expect(callAt(fetchImpl, 0)[1].redirect).toBe('error');
  });

  it('retries 5xx up to maxAttempts then surfaces the error', async () => {
    const fetchImpl = fetchMock(async () => errorResponse(503, 'internal_error'));
    const client = new RedactPdfClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
      maxAttempts: 3,
    });

    await expect(client.me()).rejects.toMatchObject({ code: 'internal_error' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('keeps the request_id so a failure can be traced to support', async () => {
    const fetchImpl = fetchMock(async () => errorResponse(404, 'not_found'));
    const client = new RedactPdfClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep });
    const error = await rejection(client.getJob('x'));
    expect(error.requestId).toBe('req_abc');
    expect(error.toAgentMessage()).toContain('req_abc');
  });

  it('survives a non-JSON error page from a proxy', async () => {
    const fetchImpl = fetchMock(
      async () => new Response('<html>502 Bad Gateway</html>', { status: 502 }),
    );
    const client = new RedactPdfClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
      maxAttempts: 1,
    });
    await expect(client.me()).rejects.toMatchObject({ code: 'internal_error' });
  });

  it('explains a missing API key instead of sending an unauthenticated request', async () => {
    const fetchImpl = fetchMock();
    const client = new RedactPdfClient({ fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep });
    await expect(client.me()).rejects.toThrow(/REDACT_PDF_API_KEY/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('allows the keyless demo with no API key', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse({ status: 'ok', message: 'hi' }));
    const client = new RedactPdfClient({ fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep });
    await expect(client.demo()).resolves.toMatchObject({ status: 'ok' });

    const headers = callAt(fetchImpl, 0)[1].headers as Headers;
    expect(headers.has('X-API-Key')).toBe(false);
  });
});

describe('matchSlotToFile', () => {
  // The previous positional fallback wrote one document's bytes into another
  // document's blob, silently. Both halves of the fix need pinning.
  const slot = (filename: string | null, id = 'doc-1') => ({
    document_id: id,
    filename,
    upload_url: 'https://blob.example/x',
  });

  it('refuses to guess when no filename matches, instead of falling back to position', () => {
    const files = [pdf('a.pdf', 10)];
    expect(() => matchSlotToFile(slot('b.pdf'), files)).toThrow(/not among the submitted files/);
  });

  it('refuses a slot with no filename rather than taking the first file', () => {
    const files = [pdf('a.pdf', 10)];
    expect(() => matchSlotToFile(slot(null), files)).toThrow(/not among the submitted files/);
  });

  it('consumes each file once, so duplicate basenames map to distinct slots', () => {
    const first = pdf('same.pdf', 10, 1);
    const second = pdf('same.pdf', 10, 2);
    const pool = [first, second];

    expect(matchSlotToFile(slot('same.pdf', 'd1'), pool)).toBe(first);
    // Without consumption both slots resolve to `first`, and the second
    // document's bytes are never uploaded at all.
    expect(matchSlotToFile(slot('same.pdf', 'd2'), pool)).toBe(second);
    expect(pool).toHaveLength(0);
  });
});

describe('upload path selection', () => {
  it('uses multipart POST /v1/jobs for a small PDF', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse({ job_id: 'j', documents: [] }));
    const client = new RedactPdfClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep });

    await client.createJob([pdf('small.pdf', 1024)]);
    expect(callAt(fetchImpl, 0)[0]).toBe('https://www.redact-pdf.ai/v1/jobs');
  });

  it('uses multipart for images regardless of size, since direct upload is PDF-only', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse({ job_id: 'j', documents: [] }));
    const client = new RedactPdfClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep });

    await client.createJob([
      { filename: 'scan.png', contentType: 'image/png', bytes: new Uint8Array(9 * 1024 * 1024) },
    ]);
    expect(callAt(fetchImpl, 0)[0]).toBe('https://www.redact-pdf.ai/v1/jobs');
  });

  it('uses init + PUT + commit for a large PDF, with the Azure block-blob header', async () => {
    const big = pdf('big.pdf', DIRECT_UPLOAD_THRESHOLD_BYTES + 1);
    const fetchImpl = fetchMock()
      .mockResolvedValueOnce(
        jsonResponse({
          job_id: 'job-9',
          uploads: [{ document_id: 'doc-9', filename: 'big.pdf', upload_url: 'https://blob.example/x?sig=1' }],
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
      .mockResolvedValueOnce(jsonResponse({ job_id: 'job-9', status: 'analyzing', documents: [] }));

    const client = new RedactPdfClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep });
    await client.createJob([big]);

    expect(callAt(fetchImpl, 0)[0]).toBe('https://www.redact-pdf.ai/v1/jobs/init');

    const [putUrl, putInit] = callAt(fetchImpl, 1);
    expect(putUrl).toBe('https://blob.example/x?sig=1');
    expect(putInit.method).toBe('PUT');
    expect((putInit.headers as Record<string, string>)['x-ms-blob-type']).toBe('BlockBlob');
    // Azure signs the SAS against the content type; a mismatch is a 403.
    expect((putInit.headers as Record<string, string>)['Content-Type']).toBe('application/pdf');

    expect(callAt(fetchImpl, 2)[0]).toBe('https://www.redact-pdf.ai/v1/jobs/job-9/commit');
  });

  it('does not re-upload on an idempotent replay that returns no slots', async () => {
    const big = pdf('big.pdf', DIRECT_UPLOAD_THRESHOLD_BYTES + 1);
    const fetchImpl = fetchMock()
      .mockResolvedValueOnce(jsonResponse({ job_id: 'job-9', uploads: [] }))
      .mockResolvedValueOnce(jsonResponse({ job_id: 'job-9', status: 'analyzing', documents: [] }));

    const client = new RedactPdfClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep });
    await client.createJob([big]);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(callAt(fetchImpl, 1)[0]).toBe('https://www.redact-pdf.ai/v1/jobs/job-9');
  });

  it('sends the derived idempotency key', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse({ job_id: 'j', documents: [] }));
    const client = new RedactPdfClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep });

    const file = pdf('a.pdf', 512);
    await client.createJob([file]);
    const headers = callAt(fetchImpl, 0)[1].headers as Headers;
    expect(headers.get('X-Idempotency-Key')).toBe(deriveIdempotencyKey([file], {}));
  });

  it('lets a caller override the idempotency key to force a second redaction', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse({ job_id: 'j', documents: [] }));
    const client = new RedactPdfClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep });

    await client.createJob([pdf('a.pdf', 512)], {}, 'my-own-key');
    const headers = callAt(fetchImpl, 0)[1].headers as Headers;
    expect(headers.get('X-Idempotency-Key')).toBe('my-own-key');
  });

  it('fails a rejected blob upload without committing, and does not retry a bad SAS', async () => {
    const big = pdf('big.pdf', DIRECT_UPLOAD_THRESHOLD_BYTES + 1);
    const fetchImpl = fetchMock()
      .mockResolvedValueOnce(
        jsonResponse({
          job_id: 'job-9',
          uploads: [{ document_id: 'doc-9', filename: 'big.pdf', upload_url: 'https://blob.example/x' }],
        }),
      )
      .mockResolvedValue(new Response('AuthenticationFailed', { status: 403 }));

    const client = new RedactPdfClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep });
    // An expired or malformed SAS will not start working; retrying just re-sends the bytes.
    await expect(client.createJob([big])).rejects.toMatchObject({ retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(2); // init + one PUT, never commit
  });

  it('retries a 5xx from blob storage before giving up', async () => {
    const big = pdf('big.pdf', DIRECT_UPLOAD_THRESHOLD_BYTES + 1);
    const fetchImpl = fetchMock()
      .mockResolvedValueOnce(
        jsonResponse({
          job_id: 'job-9',
          uploads: [{ document_id: 'doc-9', filename: 'big.pdf', upload_url: 'https://blob.example/x' }],
        }),
      )
      .mockResolvedValueOnce(new Response('ServerBusy', { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
      .mockResolvedValueOnce(jsonResponse({ job_id: 'job-9', status: 'analyzing', documents: [] }));

    const client = new RedactPdfClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep });
    await client.createJob([big]);

    expect(callAt(fetchImpl, 3)[0]).toBe('https://www.redact-pdf.ai/v1/jobs/job-9/commit');
  });
});

describe('reading a response body', () => {
  // request() wraps only the fetch call, so everything that fails after the
  // headers arrive lands outside it: a reset mid-stream is a bare
  // TypeError('terminated'), a proxy answering 200 with an HTML error page is a
  // SyntaxError. The poll loop treats anything that is not a RedactPdfError as
  // non-retryable, so an unwrapped blip on a status read ended a five-minute
  // wait seconds into it — on exactly the fault the loop exists to ride out.
  it('classifies a truncated status body as retryable rather than fatal', async () => {
    const fetchImpl = fetchMock(
      async () =>
        new Response('{"job_id": "jo', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const client = new RedactPdfClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });

    const error = await rejection(client.getJob('job-1'));

    expect(error).toBeInstanceOf(RedactPdfError);
    expect(error.code).toBe('network_error');
    expect(error.retryable).toBe(true);
  });

  it('classifies an HTML error page served as 200 the same way', async () => {
    const fetchImpl = fetchMock(
      async () => new Response('<html>502 Bad Gateway</html>', { status: 200 }),
    );
    const client = new RedactPdfClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });

    const error = await rejection(client.getJob('job-1'));

    expect(error.code).toBe('network_error');
    expect(error.retryable).toBe(true);
  });
});

describe('demoRedact', () => {
  it('posts the file as keyless multipart and never retries', async () => {
    let calls = 0;
    const fetchImpl = fetchMock(async () => {
      calls += 1;
      return jsonResponse({ detail: 'boom' }, 502);
    });
    const client = new RedactPdfClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} });
    const file = { filename: 'a.png', contentType: 'image/png', bytes: new Uint8Array([1, 2, 3]) };

    await expect(client.demoRedact(file, { pii_categories: ['Email'] })).rejects.toBeInstanceOf(RedactPdfError);

    // A 502 is retryable elsewhere; the demo redacts synchronously, so a retry
    // would process the page twice.
    expect(calls).toBe(1);
    const [url, init] = callAt(fetchImpl, 0);
    expect(url).toBe('https://www.redact-pdf.ai/v1/demo/redact');
    expect(new Headers(init.headers).get('X-API-Key')).toBeNull();
    const form = init.body as FormData;
    expect((form.get('file') as File).type).toBe('image/png');
    expect(form.get('pii_categories')).toBe('["Email"]');
  });
});
