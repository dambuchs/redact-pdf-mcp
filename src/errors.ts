/**
 * Error mapping for the Redact PDF AI `/v1` API.
 *
 * Every message here is read by an LLM, not a human tail-ing logs — so each one
 * says what went wrong AND what the agent (or its user) should do next. A bare
 * "402 Payment Required" makes an agent retry forever; "you are out of pages,
 * top up at <url>, do not retry" makes it stop and tell the user.
 */

/** Stable `code` values the API returns in its error envelope. */
export type ApiErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'quota_exceeded'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'payload_too_large'
  | 'internal_error'
  | 'network_error'
  | 'timeout'
  | 'error';

export const SIGN_UP_URL = 'https://www.redact-pdf.ai/sign-up';
export const API_KEYS_URL = 'https://www.redact-pdf.ai/dashboard/settings';
export const PRICING_URL = 'https://www.redact-pdf.ai/pricing';
export const DOCS_URL = 'https://www.redact-pdf.ai/docs';

export class RedactPdfError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number | undefined;
  readonly requestId: string | undefined;
  /** False when retrying cannot possibly succeed (bad key, no quota, bad input). */
  readonly retryable: boolean;
  /** Seconds the server asked us to wait, when it said so. */
  readonly retryAfterSeconds: number | undefined;
  /**
   * The job (and document) this failure relates to, once one exists.
   *
   * Anything that fails after the job was created has already cost the user
   * pages. If the error does not carry the id, the agent's only recovery is to
   * upload the whole file again — so every post-create path attaches it here and
   * the tool layer surfaces it.
   */
  jobId: string | undefined;
  documentId: string | undefined;

  constructor(
    message: string,
    opts: {
      code: ApiErrorCode;
      status?: number;
      requestId?: string;
      retryable?: boolean;
      retryAfterSeconds?: number;
      jobId?: string;
      documentId?: string;
    },
  ) {
    super(message);
    this.name = 'RedactPdfError';
    this.code = opts.code;
    this.status = opts.status;
    this.requestId = opts.requestId;
    this.retryable = opts.retryable ?? false;
    this.retryAfterSeconds = opts.retryAfterSeconds;
    this.jobId = opts.jobId;
    this.documentId = opts.documentId;
  }

  /** Tag an error with the job it belongs to, in place, and hand it back. */
  withJob(jobId: string, documentId?: string): this {
    (this as { jobId: string | undefined }).jobId = jobId;
    if (documentId) (this as { documentId: string | undefined }).documentId = documentId;
    return this;
  }

  /** One string carrying the diagnosis, the fix, and the support id. */
  toAgentMessage(): string {
    const parts = [this.message];
    if (this.requestId) parts.push(`(request_id: ${this.requestId})`);
    return parts.join(' ');
  }
}

/** The `{error, code, request_id}` envelope every `/v1` error body uses. */
interface ApiErrorBody {
  error?: string;
  code?: string;
  request_id?: string;
}

function parseRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number.parseInt(raw, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/**
 * Turn a non-2xx response into a `RedactPdfError` whose message tells an agent
 * what to do next. Consumes the response body.
 */
export async function errorFromResponse(response: Response): Promise<RedactPdfError> {
  let body: ApiErrorBody = {};
  let raw = '';
  try {
    raw = await response.text();
    if (raw) body = JSON.parse(raw) as ApiErrorBody;
  } catch {
    // Non-JSON error page (proxy timeout, HTML 502). Keep `raw` as the detail.
  }

  const status = response.status;
  const requestId = body.request_id;
  const detail = body.error || raw.slice(0, 300) || response.statusText || 'Unknown error';
  const retryAfterSeconds = parseRetryAfter(response.headers);

  switch (status) {
    case 401:
      return new RedactPdfError(
        `Unauthorized: the API key is missing or invalid. Set REDACT_PDF_API_KEY to a key from ${API_KEYS_URL} (create a free account at ${SIGN_UP_URL}). Do not retry until the key is fixed.`,
        { code: 'unauthorized', status, requestId, retryable: false },
      );
    case 402:
      return new RedactPdfError(
        `Out of pages: this account has no redaction quota left (${detail}). Ask the user to top up at ${PRICING_URL}. Do not retry — retrying will keep failing.`,
        { code: 'quota_exceeded', status, requestId, retryable: false },
      );
    case 403:
      return new RedactPdfError(`Forbidden: ${detail}`, {
        code: 'forbidden',
        status,
        requestId,
        retryable: false,
      });
    case 404:
      return new RedactPdfError(
        `Not found: ${detail}. The job or document id may be wrong, or it belonged to a different API key, or its retention window has passed.`,
        { code: 'not_found', status, requestId, retryable: false },
      );
    case 409:
      return new RedactPdfError(
        `Conflict: ${detail}. An identical request is already in flight, and the API does not return its job id here — so there is nothing to poll yet. Wait a few seconds and call this tool AGAIN WITH THE SAME arguments: the idempotency key is derived from them, so the retry joins the existing job. Do NOT pass a new idempotency_key; that creates a second job and bills the user twice.`,
        // Not retryable: the in-flight request will not have finished inside our
        // backoff, and `request()` would replay the entire upload body to find out.
        { code: 'conflict', status, requestId, retryable: false },
      );
    case 413:
      return new RedactPdfError(
        `File too large: ${detail}. The per-file limit is 50 MB for PDFs and 10 MB for images. Split the document and redact it in parts.`,
        { code: 'payload_too_large', status, requestId, retryable: false },
      );
    case 422:
      return new RedactPdfError(
        `Invalid request: ${detail}. If this mentions an idempotency key, the same key was already used with different parameters. Prefer polling the original job with get_job_status; passing a different idempotency_key creates a SECOND job and bills the user again for the same pages.`,
        { code: 'invalid_request', status, requestId, retryable: false },
      );
    case 429:
      return new RedactPdfError(
        `Rate limited: ${detail}. Wait ${retryAfterSeconds ?? 60}s and retry — this is a per-minute cap, not a quota problem.`,
        { code: 'rate_limited', status, requestId, retryable: true, retryAfterSeconds },
      );
    case 400:
      return new RedactPdfError(
        `Invalid request: ${detail}. See ${DOCS_URL} for accepted values.`,
        { code: 'invalid_request', status, requestId, retryable: false },
      );
    default:
      if (status >= 500) {
        return new RedactPdfError(
          `Redact PDF AI server error (${status}): ${detail}. This is transient — retry with backoff.`,
          { code: 'internal_error', status, requestId, retryable: true, retryAfterSeconds },
        );
      }
      return new RedactPdfError(`Request failed (${status}): ${detail}`, {
        code: 'error',
        status,
        requestId,
        retryable: false,
      });
  }
}
