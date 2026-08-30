/** Shared test helpers: typed fetch mocks and rejection capture. */
import { vi, type Mock } from 'vitest';
import type { RedactPdfError } from '../src/errors.js';

export type FetchMock = Mock<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>;

/** A `fetch` double with the real signature, so `.mock.calls[n][1]` is typed. */
export function fetchMock(impl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): FetchMock {
  return impl ? vi.fn(impl) : (vi.fn() as FetchMock);
}

/** The [url, init] pair of the nth call, without optional-chaining noise. */
export function callAt(mock: FetchMock, index: number): [string, RequestInit] {
  const call = mock.mock.calls[index];
  if (!call) throw new Error(`fetch was not called ${index + 1} time(s)`);
  return [String(call[0]), (call[1] ?? {}) as RequestInit];
}

/** Await a promise expected to reject, and hand back the typed error. */
export async function rejection(promise: Promise<unknown>): Promise<RedactPdfError> {
  try {
    await promise;
  } catch (error) {
    return error as RedactPdfError;
  }
  throw new Error('Expected the promise to reject, but it resolved.');
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Tool results carry JSON text; parse the first content block. */
export function payload(result: unknown): Record<string, unknown> {
  const blocks = (result as { content: Array<{ type: string; text: string }> }).content;
  const first = blocks[0];
  if (!first) throw new Error('Tool result had no content block.');
  return JSON.parse(first.text) as Record<string, unknown>;
}
