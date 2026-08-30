/**
 * Thin HTTP client for the Redact PDF AI `/v1` API.
 *
 * Stateless by design: no database, no cache, no disk. It holds a base URL and
 * an API key and does nothing between calls. Everything the MCP tools need is
 * one method here.
 *
 * Two upload paths, because the API has two:
 *  - multipart `POST /v1/jobs` — simple, streams bytes through the API. Used for
 *    images (which the API converts) and for small PDFs.
 *  - `POST /v1/jobs/init` → `PUT` to a per-blob SAS URL → `POST .../commit` —
 *    the bytes never touch the API. Used for large PDFs so a slow upload does
 *    not hold an API connection open.
 */

import { createHash, randomUUID } from 'node:crypto';
import { errorFromResponse, RedactPdfError } from './errors.js';
import { assertFileWithinLimits } from './inputs.js';
import {
  MAX_FILES_PER_JOB,
  PII_CATEGORIES,
  type DemoResult,
  type InputFile,
  type Job,
  type JobUploadInit,
  type JobDocument,
  type Me,
  type RedactionRules,
  type UploadSlot,
} from './types.js';

export const DEFAULT_BASE_URL = 'https://www.redact-pdf.ai';

/**
 * PDFs at or below this go through multipart; above it, direct-to-blob. Well
 * under the 50 MB hard cap: the point is to stop holding an API connection open
 * for a long upload, not to work around the size limit.
 */
export const DIRECT_UPLOAD_THRESHOLD_BYTES = 8 * 1024 * 1024;

/**
 * Per-request deadlines. Without them a request inherits undici's ~300s default
 * and, multiplied by the retry count, one status check could outlive the
 * caller's entire poll budget — making `timeout_seconds` a suggestion rather
 * than a bound.
 */
export const METADATA_TIMEOUT_MS = 30_000;
export const TRANSFER_TIMEOUT_MS = 300_000;

/**
 * Ceiling on a server-requested retry pause. Both API limiters send a flat
 * `Retry-After: 60`, so obeying it literally across three attempts parks a
 * single tool call for two minutes — past most MCP client timeouts, and the
 * agent sees a hang rather than "rate limited". We wait a bounded amount and
 * put the real figure in the message instead.
 */
export const MAX_RETRY_SLEEP_MS = 10_000;
export const MIN_RETRY_SLEEP_MS = 250;

export interface ClientOptions {
  baseUrl?: string;
  apiKey?: string;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Attempts for transient failures (429 / 5xx / network). 1 = no retry. */
  maxAttempts?: number;
  /** Injectable for tests so retry backoff does not really sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Read a JSON body, mapping a mid-body failure to a RETRYABLE error.
 *
 * `request()` wraps only the fetch call, so everything that goes wrong after
 * the headers arrive lands here instead: a connection reset while the body
 * streams surfaces as a bare `TypeError('terminated')`, an abort during the
 * read as a `DOMException`, and a proxy that answers 200 with an HTML error
 * page as a `SyntaxError`. None of them is a RedactPdfError, and the poll loop
 * treats anything that is not one as non-retryable — so an unwrapped blip on a
 * status read ended a five-minute wait seconds into it, on exactly the kind of
 * transient fault the loop exists to ride out.
 */
async function readJson<T>(response: Response, what: string): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch (cause) {
    throw new RedactPdfError(
      `Could not read the ${what} response from the server: ${cause instanceof Error ? cause.message : String(cause)}. This is usually a transient network or proxy fault rather than a problem with the request.`,
      { code: 'network_error', retryable: true },
    );
  }
}

/**
 * Deterministic idempotency key: same bytes + same rules => same key.
 *
 * This is the guard against a looping agent burning the user's page quota. An
 * agent that calls `redact_pdf` three times with the same file gets one job and
 * is billed once (the API keeps completed keys for 24h). Callers who genuinely
 * want a second, separate redaction of the same file pass their own key.
 */
export function deriveIdempotencyKey(files: InputFile[], rules: RedactionRules): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => a.filename.localeCompare(b.filename))) {
    hash.update(file.filename);
    hash.update('\0');
    hash.update(file.bytes);
    hash.update('\0');
  }
  hash.update(
    JSON.stringify({
      categories: rules.pii_categories ? [...rules.pii_categories].sort() : null,
      included: rules.pii_included_terms ? [...rules.pii_included_terms].sort() : null,
      excluded: rules.pii_excluded_terms ? [...rules.pii_excluded_terms].sort() : null,
      retention: rules.retention ?? 'ephemeral',
    }),
  );
  return `mcp-${hash.digest('hex').slice(0, 48)}`;
}

export class RedactPdfClient {
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.sleep = options.sleep ?? defaultSleep;
  }

  get hasApiKey(): boolean {
    return Boolean(this.apiKey);
  }

  private requireApiKey(): string {
    if (!this.apiKey) {
      throw new RedactPdfError(
        'No API key configured. Set the REDACT_PDF_API_KEY environment variable to a key from https://www.redact-pdf.ai/dashboard/settings (free account: https://www.redact-pdf.ai/sign-up). The try_demo tool works without a key if you just want to check the service is reachable.',
        { code: 'unauthorized', retryable: false },
      );
    }
    return this.apiKey;
  }

  /**
   * One request, with backoff on the failures that are actually transient.
   * A 401 or 402 fails immediately — retrying a bad key wastes the agent's turn.
   */
  private async request(
    path: string,
    init: RequestInit & { authenticated?: boolean; timeoutMs?: number; maxAttempts?: number } = {},
  ): Promise<Response> {
    const {
      authenticated = true,
      headers,
      timeoutMs = METADATA_TIMEOUT_MS,
      maxAttempts = this.maxAttempts,
      ...rest
    } = init;
    const url = `${this.baseUrl}${path}`;

    const requestHeaders = new Headers(headers);
    if (authenticated) requestHeaders.set('X-API-Key', this.requireApiKey());
    if (!requestHeaders.has('user-agent')) {
      requestHeaders.set('User-Agent', 'redact-pdf-mcp');
    }

    let lastError: RedactPdfError | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          ...rest,
          headers: requestHeaders,
          signal: AbortSignal.timeout(timeoutMs),
          // Never follow a redirect while carrying the key: undici strips
          // Authorization on a cross-origin hop but replays custom headers like
          // X-API-Key verbatim. The API does not redirect today, so failing
          // closed costs nothing and forecloses a key-harvesting redirect later.
          redirect: 'error',
        });
      } catch (cause) {
        const timedOut =
          cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
        lastError = new RedactPdfError(
          timedOut
            ? `Request to ${url} timed out after ${Math.round(timeoutMs / 1000)}s.`
            : `Could not reach ${url}: ${cause instanceof Error ? cause.message : String(cause)}. Check network access to www.redact-pdf.ai.`,
          { code: timedOut ? 'timeout' : 'network_error', retryable: true },
        );
        if (attempt < maxAttempts) {
          await this.sleep(backoffMs(attempt));
          continue;
        }
        throw lastError;
      }

      if (response.ok) return response;

      const error = await errorFromResponse(response);
      if (!error.retryable || attempt === maxAttempts) throw error;
      lastError = error;

      if (error.retryAfterSeconds != null) {
        const requestedMs = error.retryAfterSeconds * 1000;
        // If the server asked for longer than we are willing to wait, retrying
        // is not just impolite, it is futile: the limiter uses a fixed window,
        // so a shorter sleep lands in the SAME window and 429s again. Measured:
        // three attempts, three identical failures, triple the load on the
        // limiter that just asked for relief. Surface it instead and let the
        // agent decide.
        if (requestedMs > MAX_RETRY_SLEEP_MS) throw error;
        await this.sleep(
          // Jitter here too — this path had none, so rate-limited agents
          // retried in lockstep to within 5 ms of each other.
          Math.max(requestedMs, MIN_RETRY_SLEEP_MS) + Math.floor(Math.random() * 250),
        );
      } else {
        await this.sleep(backoffMs(attempt));
      }
    }

    /* istanbul ignore next — the loop either returns or throws. */
    throw lastError ?? new RedactPdfError('Request failed', { code: 'error' });
  }

  /** `GET /v1/demo` — keyless. Proves the service is reachable with zero setup. */
  async demo(): Promise<DemoResult> {
    const response = await this.request('/v1/demo', { method: 'GET', authenticated: false });
    return readJson<DemoResult>(response, 'demo');
  }

  /** `GET /v1/me` — validates the key and returns who it belongs to. */
  async me(): Promise<Me> {
    const response = await this.request('/v1/me', { method: 'GET' });
    return readJson<Me>(response, 'account');
  }

  /**
   * `GET /v1/jobs/{id}`
   *
   * `options` lets the poll loop bound a single status read. Without it the
   * client's own 3 attempts nest inside the loop's budget: a hanging endpoint
   * turned a 10-second `timeout_seconds` into a 95-second call, and a stuck job
   * produced ~38x the happy-path request volume against an already-degraded API.
   */
  async getJob(jobId: string, options: { maxAttempts?: number; timeoutMs?: number } = {}): Promise<Job> {
    const response = await this.request(`/v1/jobs/${encodeURIComponent(jobId)}`, {
      method: 'GET',
      ...options,
    });
    return readJson<Job>(response, 'job status');
  }

  /** `DELETE /v1/jobs/{id}` — purge the job and its artifacts. */
  async deleteJob(jobId: string): Promise<void> {
    await this.request(`/v1/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
  }

  /** `GET /v1/documents/{id}/output` — the redacted PDF bytes. */
  async downloadOutput(documentId: string): Promise<Uint8Array> {
    const response = await this.request(
      `/v1/documents/${encodeURIComponent(documentId)}/output`,
      { method: 'GET', timeoutMs: TRANSFER_TIMEOUT_MS },
    );
    return new Uint8Array(await response.arrayBuffer());
  }

  /**
   * Create a job, picking the upload path that fits the files.
   *
   * Mixed batches (images + a large PDF) go through multipart as a whole: the
   * direct-to-blob path is PDF-only, and one job cannot be split across both.
   */
  async createJob(
    files: InputFile[],
    inputRules: RedactionRules = {},
    idempotencyKey?: string,
  ): Promise<Job> {
    assertUploadable(files);
    const rules = withoutEmptyRules(inputRules);
    const key = idempotencyKey ?? deriveIdempotencyKey(files, rules);

    const allPdf = files.every((f) => f.contentType === 'application/pdf');
    const isLarge = files.some((f) => f.bytes.byteLength > DIRECT_UPLOAD_THRESHOLD_BYTES);

    if (allPdf && isLarge) return this.createJobDirect(files, rules, key);
    return this.createJobMultipart(files, rules, key);
  }

  /** Small files / images: stream through `POST /v1/jobs` as multipart. */
  private async createJobMultipart(
    files: InputFile[],
    rules: RedactionRules,
    idempotencyKey: string,
  ): Promise<Job> {
    const form = new FormData();
    for (const file of files) {
      // Copy into a fresh ArrayBuffer: Blob rejects a Uint8Array view backed by
      // a SharedArrayBuffer, and a subarray view would otherwise send the whole
      // backing buffer.
      const copy = new Uint8Array(file.bytes.byteLength);
      copy.set(file.bytes);
      form.append('files', new Blob([copy], { type: file.contentType }), file.filename);
    }
    // The multipart endpoint takes these as JSON-encoded strings, not repeated fields.
    if (rules.pii_categories) form.append('pii_categories', JSON.stringify(rules.pii_categories));
    if (rules.pii_included_terms) {
      form.append('pii_included_terms', JSON.stringify(rules.pii_included_terms));
    }
    if (rules.pii_excluded_terms) {
      form.append('pii_excluded_terms', JSON.stringify(rules.pii_excluded_terms));
    }
    form.append('retention', rules.retention ?? 'ephemeral');

    const response = await this.request('/v1/jobs', {
      method: 'POST',
      body: form,
      headers: { 'X-Idempotency-Key': idempotencyKey },
      timeoutMs: TRANSFER_TIMEOUT_MS,
    });
    return readJson<Job>(response, 'job creation');
  }

  /** Large PDFs: reserve slots, PUT straight to blob storage, then commit. */
  private async createJobDirect(
    files: InputFile[],
    rules: RedactionRules,
    idempotencyKey: string,
  ): Promise<Job> {
    const initResponse = await this.request('/v1/jobs/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': idempotencyKey },
      body: JSON.stringify({
        files: files.map((f) => ({
          filename: f.filename,
          content_type: f.contentType,
          size_bytes: f.bytes.byteLength,
        })),
        ...rules,
        retention: rules.retention ?? 'ephemeral',
      }),
    });
    const init = await readJson<JobUploadInit>(initResponse, 'upload init');

    // No slots means this is an idempotent replay. That does NOT always mean the
    // job is fine: the server only mints slots for documents still `uploading`,
    // so a document its commit left in `error` (a transient blob-verification
    // failure, say) gets no slot either. Commit is idempotent and re-checks
    // exactly those documents, so re-committing is the server's own recovery
    // path — and without this the file would be stuck behind the derived
    // idempotency key for its full 24h lifetime.
    if (init.uploads.length === 0) {
      const existing = await this.getJob(init.job_id);
      if (!existing.documents.some(isAwaitingUploadCommit)) return existing;
      return this.commitJob(init.job_id);
    }

    const unassigned = [...files];
    for (const slot of init.uploads) {
      await this.putBlob(slot.upload_url, matchSlotToFile(slot, unassigned));
    }

    return this.commitJob(init.job_id);
  }

  /** `POST /v1/jobs/{id}/commit` — verify the blobs landed and release to the worker. */
  private async commitJob(jobId: string): Promise<Job> {
    const response = await this.request(`/v1/jobs/${encodeURIComponent(jobId)}/commit`, {
      method: 'POST',
    });
    return readJson<Job>(response, 'commit');
  }

  /**
   * PUT one file to its short-lived Azure SAS URL.
   *
   * `x-ms-blob-type` is required by Azure for a single-shot block blob write,
   * and `Content-Type` must match what the SAS was signed for or Azure rejects
   * the signature. Sent with plain fetch — no Azure SDK dependency.
   */
  private async putBlob(uploadUrl: string, file: InputFile): Promise<void> {
    const copy = new Uint8Array(file.bytes.byteLength);
    copy.set(file.bytes);

    let lastError: RedactPdfError | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(uploadUrl, {
          method: 'PUT',
          headers: {
            'x-ms-blob-type': 'BlockBlob',
            'Content-Type': file.contentType,
          },
          body: copy,
          signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
        });
      } catch (cause) {
        lastError = new RedactPdfError(
          `Direct upload of "${file.filename}" failed: ${cause instanceof Error ? cause.message : String(cause)}. The upload URL is short-lived — retry the whole redact call.`,
          { code: 'network_error', retryable: true },
        );
        if (attempt < this.maxAttempts) {
          await this.sleep(backoffMs(attempt));
          continue;
        }
        throw lastError;
      }

      if (response.ok) return;

      const detail = await response.text().catch(() => '');
      // 403 here is usually an expired or malformed SAS, which no amount of
      // retrying fixes; 5xx from storage is worth another go.
      const retryable = response.status >= 500;
      lastError = new RedactPdfError(
        `Direct upload of "${file.filename}" was rejected by storage (${response.status}): ${detail.slice(0, 200)}. The upload URL expires after 30 minutes — retry the whole redact call.`,
        { code: 'error', status: response.status, retryable },
      );
      if (!retryable || attempt === this.maxAttempts) throw lastError;
      await this.sleep(backoffMs(attempt));
    }

    /* istanbul ignore next — the loop either returns or throws. */
    throw lastError ?? new RedactPdfError('Direct upload failed', { code: 'error' });
  }
}

/**
 * Is this document stuck at the UPLOAD stage, where re-committing is the
 * server's own recovery path?
 *
 * `error` on its own is not enough: it is also the terminal state of a document
 * whose REDACTION failed. Re-committing one of those flips it back to
 * `uploaded` and makes the worker run the same doomed redaction again — and if
 * the blob has since been reclaimed, it overwrites the real diagnosis ("PDF is
 * password protected") with "Upload was not completed". So only `uploading`,
 * or an error the server itself attributes to the upload, is recoverable.
 */
function isAwaitingUploadCommit(doc: JobDocument): boolean {
  // Deliberately NOT `status === 'uploading'`. That state is ambiguous: it means
  // either "a previous caller crashed before committing" or "another caller is
  // PUTting the bytes right now". Committing on it makes the second reading
  // fatal — a concurrent call verifies the blob before it has landed, flips the
  // shared job to `error`, and the winner is told to retry with a fresh
  // idempotency key, i.e. to pay a second time for a document that succeeded.
  // These error messages are unambiguous: the server has already decided the
  // upload failed, so re-committing is the recovery path it documents.
  if (doc.status !== 'error') return false;
  const reason = doc.error_message ?? '';
  return /upload was not completed|verify uploaded file size|exceeds the maximum allowed size/i.test(reason);
}

/**
 * Strip empty rule arrays before anything reaches the wire.
 *
 * The API treats an empty list as a deliberate instruction rather than an
 * absent one: `pii_categories: []` is stored as "redact nothing", the worker
 * honours it, and the job then reports `redacted` over a document from which
 * nothing was removed. The MCP schema rejects that too, but this client is
 * exported for direct use, so the guard has to sit below both entry points —
 * silently returning an unredacted file is the one outcome this package must
 * never produce.
 */
export function withoutEmptyRules(rules: RedactionRules): RedactionRules {
  // Mirror the API's own cleaning (_clean_str_list drops non-strings and blanks)
  // BEFORE deciding whether a list is empty. `["  "]` and `[null]` survive a
  // bare `.length` check but arrive at the worker as `[]`, which it reads as
  // "redact nothing" — the same unredacted-file-reported-as-redacted failure an
  // empty literal causes.
  const clean = (list: string[] | undefined): string[] | undefined => {
    if (!list) return undefined;
    const kept = list.filter((item) => typeof item === 'string' && item.trim() !== '');
    return kept.length ? kept : undefined;
  };

  const cleaned: RedactionRules = {};
  const categories = clean(rules.pii_categories);
  if (rules.pii_categories && !categories) {
    // Silently dropping this one would fall back to account defaults, which may
    // not be what was asked for. For the rule that decides what gets redacted,
    // say so instead of guessing.
    throw new RedactPdfError(
      'pii_categories was given but contains no usable category. Omit it to use the account defaults, or pass at least one of: ' +
        `${PII_CATEGORIES.join(', ')}. An empty list would mean "redact nothing" and return an unredacted file.`,
      { code: 'invalid_request' },
    );
  }
  if (categories) cleaned.pii_categories = categories;
  const included = clean(rules.pii_included_terms);
  if (included) cleaned.pii_included_terms = included;
  const excluded = clean(rules.pii_excluded_terms);
  if (excluded) cleaned.pii_excluded_terms = excluded;
  if (rules.retention) cleaned.retention = rules.retention;
  return cleaned;
}

/**
 * Pair an upload slot with the file whose bytes belong in it.
 *
 * Strictly by filename, consuming each file once. The previous positional
 * fallback was unsound: `uploads` is a filtered view (only documents still
 * awaiting bytes), so its indices do not line up with the submitted list on a
 * partial replay — and the failure was silent, writing one document's contents
 * into another's blob. Refusing to guess is the only safe option.
 */
export function matchSlotToFile(slot: UploadSlot, files: InputFile[]): InputFile {
  const index = files.findIndex((file) => file.filename === slot.filename);
  if (index === -1) {
    throw new RedactPdfError(
      `The server asked for an upload of "${slot.filename ?? 'unnamed'}" (document ${slot.document_id}), which is not among the submitted files. Retry the redact call.`,
      { code: 'error', retryable: true },
    );
  }
  // Consume it, so duplicate basenames map to distinct slots rather than both
  // resolving to the first match.
  const [file] = files.splice(index, 1);
  return file as InputFile;
}

/**
 * Exponential backoff with FULL jitter, capped so an agent never stalls for minutes.
 *
 * Full jitter (uniform over [0, base]) rather than base + a small offset: with
 * a 250 ms additive jitter on an 8 s base, 30 agents retrying a failed call all
 * landed within 348 ms of each other — a synchronised wave that arrives exactly
 * when the upstream is least able to serve it. Spreading over the whole
 * interval is what actually decorrelates a fleet.
 */
export function backoffMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** (attempt - 1), 8000);
  return Math.floor(Math.random() * base);
}

/**
 * Reject locally what the API would reject anyway — saves a round trip and a
 * confusing 4xx. Per-file limits come from the shared check in inputs.ts so the
 * two paths cannot disagree about what is acceptable.
 */
export function assertUploadable(files: InputFile[]): void {
  if (files.length === 0) {
    throw new RedactPdfError('No files to redact.', { code: 'invalid_request' });
  }
  if (files.length > MAX_FILES_PER_JOB) {
    throw new RedactPdfError(
      `Too many files: ${files.length}. A job takes at most ${MAX_FILES_PER_JOB} files — split them into several jobs.`,
      { code: 'invalid_request' },
    );
  }
  for (const file of files) assertFileWithinLimits(file);
}

/** A fresh key for callers who explicitly want a duplicate job. */
export function randomIdempotencyKey(): string {
  return `mcp-${randomUUID()}`;
}
