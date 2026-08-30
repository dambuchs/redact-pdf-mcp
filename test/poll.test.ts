import { describe, expect, it } from 'vitest';
import { DEFAULT_POLL_OPTIONS, delayForAttempt, isTerminal, pollUntilTerminal } from '../src/poll.js';
import { rejection } from './helpers.js';
import { RedactPdfError } from '../src/errors.js';
import type { Job, JobDocument } from '../src/types.js';

const opts = DEFAULT_POLL_OPTIONS;

function doc(status: JobDocument['status'], id = 'doc-1'): JobDocument {
  return { id, file_name: 'x.pdf', status, page_count: 1, error_message: null };
}

function job(status: Job['status'], documents: JobDocument[] = [doc(status)]): Job {
  return {
    job_id: 'job-1',
    status,
    retention: 'ephemeral',
    created_at: '2026-08-22T00:00:00Z',
    documents,
  };
}

/** A clock and sleeper that advance a virtual timeline instead of waiting. */
function fakeClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
    get value() {
      return now;
    },
  };
}

describe('delayForAttempt', () => {
  it('grows geometrically from the initial delay', () => {
    expect(delayForAttempt(1, 0, opts)).toBe(2_000);
    expect(delayForAttempt(2, 0, opts)).toBe(3_000);
    expect(delayForAttempt(3, 0, opts)).toBe(4_500);
  });

  it('never exceeds maxDelayMs', () => {
    for (let attempt = 1; attempt <= 50; attempt += 1) {
      expect(delayForAttempt(attempt, 0, opts)).toBeLessThanOrEqual(opts.maxDelayMs);
    }
  });

  it('clamps the final wait to the remaining budget so it never overshoots', () => {
    expect(delayForAttempt(10, opts.timeoutMs - 1_000, opts)).toBe(1_000);
  });

  it('returns 0 once the budget is spent', () => {
    expect(delayForAttempt(3, opts.timeoutMs, opts)).toBe(0);
    expect(delayForAttempt(3, opts.timeoutMs + 5_000, opts)).toBe(0);
  });
});

describe('isTerminal', () => {
  it('is false while any document is still working', () => {
    expect(isTerminal(job('analyzing', [doc('redacted', 'a'), doc('analyzing', 'b')]))).toBe(false);
  });

  it('is true when every document has settled, including mixed success and failure', () => {
    expect(isTerminal(job('redacted', [doc('redacted', 'a'), doc('error', 'b')]))).toBe(true);
  });

  it('falls back to the job status when there are no documents', () => {
    expect(isTerminal(job('analyzing', []))).toBe(false);
    expect(isTerminal(job('error', []))).toBe(true);
  });

  it('treats an uncommitted direct upload as not terminal', () => {
    expect(isTerminal(job('uploaded', [doc('uploading')]))).toBe(false);
  });
});

describe('pollUntilTerminal', () => {
  it('returns as soon as the job settles', async () => {
    const clock = fakeClock();
    const statuses: Job[] = [job('analyzing'), job('redacting'), job('redacted')];
    let calls = 0;

    const result = await pollUntilTerminal(
      'job-1',
      async () => statuses[calls++] ?? job('redacted'),
      { sleep: clock.sleep, now: clock.now },
    );

    expect(result.status).toBe('redacted');
    expect(calls).toBe(3);
  });

  it('returns a job that ended in error rather than throwing — error is terminal', async () => {
    const clock = fakeClock();
    const failed = job('error', [
      { id: 'd', file_name: 'x.pdf', status: 'error', page_count: 0, error_message: 'boom' },
    ]);
    const result = await pollUntilTerminal('job-1', async () => failed, {
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(result.status).toBe('error');
  });

  it('gives up at the deadline with a resumable message, not a failure claim', async () => {
    const clock = fakeClock();
    await expect(
      pollUntilTerminal('job-42', async () => job('analyzing'), {
        timeoutMs: 30_000,
        sleep: clock.sleep,
        now: clock.now,
      }),
      // Not retryable: the structured flag has to agree with the prose, or an
      // agent keying off `retryable` re-uploads the whole document.
    ).rejects.toMatchObject({ code: 'timeout', retryable: false, jobId: 'job-42' });

    // And the message must point the agent at the resume path.
    const error = await rejection(
      pollUntilTerminal('job-42', async () => job('analyzing'), {
        timeoutMs: 30_000,
        sleep: clock.sleep,
        now: clock.now,
      }),
    );
    expect(error.message).toContain('job-42');
    expect(error.message).toContain('get_job_status');
    expect(error.message).toContain('not a failure');
  });

  it('keeps polling through a transient status failure rather than losing the job', async () => {
    const clock = fakeClock();
    let call = 0;
    const result = await pollUntilTerminal(
      'job-1',
      async () => {
        call += 1;
        if (call <= 2) {
          throw new RedactPdfError('rate limited', { code: 'rate_limited', retryable: true });
        }
        return job('redacted');
      },
      { sleep: clock.sleep, now: clock.now },
    );
    expect(result.status).toBe('redacted');
    expect(call).toBe(3);
  });

  it('stops immediately on an error that can never resolve, and tags the job id', async () => {
    const clock = fakeClock();
    const error = await rejection(
      pollUntilTerminal(
        'job-7',
        async () => {
          throw new RedactPdfError('bad key', { code: 'unauthorized', retryable: false });
        },
        { sleep: clock.sleep, now: clock.now },
      ),
    );
    expect(error.code).toBe('unauthorized');
    expect(error.jobId).toBe('job-7');
  });

  it('reports an unreadable job with its id, warning against paying twice', async () => {
    const clock = fakeClock();
    const error = await rejection(
      pollUntilTerminal(
        'job-9',
        async () => {
          throw new RedactPdfError('boom', { code: 'internal_error', retryable: true });
        },
        { timeoutMs: 20_000, sleep: clock.sleep, now: clock.now },
      ),
    );
    expect(error.jobId).toBe('job-9');
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/pay for it twice/);
  });

  it('does not run past the deadline', async () => {
    const clock = fakeClock();
    await pollUntilTerminal('job-1', async () => job('analyzing'), {
      timeoutMs: 20_000,
      sleep: clock.sleep,
      now: clock.now,
    }).catch(() => undefined);
    expect(clock.value).toBeLessThanOrEqual(20_000);
  });

  it('stops polling if the deadline passes while a status request is in flight', async () => {
    const clock = fakeClock();
    let calls = 0;
    await pollUntilTerminal(
      'job-1',
      async () => {
        calls += 1;
        clock.advance(60_000); // a slow request eats the whole budget
        return job('analyzing');
      },
      { timeoutMs: 30_000, sleep: clock.sleep, now: clock.now },
    ).catch(() => undefined);
    expect(calls).toBe(1);
  });
});
