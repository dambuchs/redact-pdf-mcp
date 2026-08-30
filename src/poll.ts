/**
 * Job polling for the one-call `redact_pdf_and_wait` tool.
 *
 * Split out from the client and kept pure-ish (clock and fetcher injected) so
 * the schedule can be unit-tested without waiting real minutes. The schedule
 * matters: poll too fast and a looping agent hammers the rate limiter; poll too
 * slow and a 20-second redaction takes a minute to report back.
 */

import { RedactPdfError } from './errors.js';
import { TERMINAL_STATUSES, type Job } from './types.js';

export interface PollOptions {
  /** Wall-clock budget. The API is async; agents should not block forever. */
  timeoutMs?: number;
  /** First wait, before the first status check. */
  initialDelayMs?: number;
  /** Ceiling for the growing interval. */
  maxDelayMs?: number;
  /** Growth factor between polls. */
  factor?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const DEFAULT_POLL_OPTIONS: Required<Omit<PollOptions, 'sleep' | 'now'>> = {
  timeoutMs: 300_000,
  initialDelayMs: 2_000,
  maxDelayMs: 15_000,
  factor: 1.5,
};

/**
 * The delay before poll number `attempt` (1-based), clamped so the total never
 * overshoots the deadline — the last wait lands exactly on it.
 */
export function delayForAttempt(
  attempt: number,
  elapsedMs: number,
  options: Required<Omit<PollOptions, 'sleep' | 'now'>>,
): number {
  const raw = options.initialDelayMs * options.factor ** (attempt - 1);
  const capped = Math.min(raw, options.maxDelayMs);
  const remaining = options.timeoutMs - elapsedMs;
  return Math.max(0, Math.min(capped, remaining));
}

/** True once every document has settled (`redacted` or `error`). */
export function isTerminal(job: Job): boolean {
  if (job.documents.length === 0) return TERMINAL_STATUSES.has(job.status);
  return job.documents.every((doc) => TERMINAL_STATUSES.has(doc.status));
}

/**
 * Poll `fetchJob` until the job settles or the budget runs out.
 *
 * A timeout is not a failure of the job — the work continues server-side — so
 * the error says so, and hands back the job id to resume with `get_job_status`.
 */
export async function pollUntilTerminal(
  jobId: string,
  /**
   * `remainingMs` is the budget left; a status read must not outlive it. The
   * loop is itself the retry, so the fetcher should not retry internally —
   * nesting the two produced ~38x the happy-path request volume against a
   * degraded API and let a 10s budget run for 95s.
   */
  fetchJob: (jobId: string, remainingMs: number) => Promise<Job>,
  options: PollOptions = {},
): Promise<Job> {
  const config = { ...DEFAULT_POLL_OPTIONS, ...stripUndefined(options) };
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? (() => Date.now());

  const startedAt = now();
  let attempt = 0;
  let lastJob: Job | undefined;
  let lastError: RedactPdfError | undefined;

  for (;;) {
    attempt += 1;
    const elapsed = now() - startedAt;
    if (elapsed >= config.timeoutMs) break;

    await sleep(delayForAttempt(attempt, elapsed, config));

    try {
      lastJob = await fetchJob(jobId, Math.max(0, config.timeoutMs - (now() - startedAt)));
      lastError = undefined;
    } catch (error) {
      // The job is already created and already billed. A rate limit, a 503, or
      // a network blip while asking after it says nothing about the redaction
      // itself — so keep asking until the budget runs out rather than throwing
      // away the only handle the caller has on paid-for work. Errors that can
      // never resolve (bad key, no quota, wrong id) still stop us immediately.
      const failure = asRedactPdfError(error);
      if (!failure.retryable) throw failure.withJob(jobId);
      lastError = failure;
    }

    if (lastJob && isTerminal(lastJob)) return lastJob;

    if (now() - startedAt >= config.timeoutMs) break;
  }

  const budgetSeconds = Math.round(config.timeoutMs / 1000);
  // `lastError` is only cleared by a SUCCESSFUL read, so if it is still set the
  // most recent attempt failed. Reporting the last known job status instead
  // would tell the agent "the server is fine, it is still working" on the
  // strength of a status that may be minutes stale — while every read since
  // then failed. Surface the outage; it is the actionable fact.
  if (lastError) {
    const staleness = lastJob
      ? ` The last status read that succeeded reported "${lastJob.status}", but every attempt since then failed, so that may be far out of date.`
      : '';
    throw new RedactPdfError(
      `Could not read the status of job ${jobId} within ${budgetSeconds}s: ${lastError.message}${staleness} The job was created and may still be running — call get_job_status with job_id "${jobId}" before redacting this document again, or you will pay for it twice.`,
      { code: lastError.code, retryable: false, jobId },
    );
  }

  throw new RedactPdfError(
    `Job ${jobId} was still ${lastJob?.status ?? 'processing'} after ${budgetSeconds}s. It is still running on the server — this is not a failure, and re-running this tool will NOT speed it up. Call get_job_status with job_id "${jobId}" in a minute, then download_redacted once it reports "redacted".`,
    // Deliberately not retryable: the machine-readable flag has to agree with
    // the prose, or an agent keying off `retryable` re-uploads the whole file.
    { code: 'timeout', retryable: false, jobId },
  );
}

function asRedactPdfError(error: unknown): RedactPdfError {
  if (error instanceof RedactPdfError) return error;
  return new RedactPdfError(
    error instanceof Error ? error.message : String(error),
    { code: 'error', retryable: false },
  );
}

function stripUndefined<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}
