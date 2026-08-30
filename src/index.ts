/** Programmatic entry point — for embedding the server rather than running a binary. */
export { RedactPdfClient, DEFAULT_BASE_URL, deriveIdempotencyKey } from './client.js';
export { createServer, defaultOutputPath, VERSION, type CreateServerOptions, type ServerMode } from './server.js';
export { RedactPdfError, type ApiErrorCode } from './errors.js';
export { pollUntilTerminal, isTerminal, delayForAttempt, DEFAULT_POLL_OPTIONS } from './poll.js';
export * from './types.js';
