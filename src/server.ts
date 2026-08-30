/**
 * The MCP server: six tools over the Redact PDF AI `/v1` API.
 *
 * Tool registration order is deliberate. Clients present tools to the model in
 * the order the server lists them, and agents reliably reach for the first
 * plausible match — so the one-call `redact_pdf_and_wait` goes first and the
 * lower-level pieces follow.
 */

import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { link, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { METADATA_TIMEOUT_MS, RedactPdfClient, withoutEmptyRules } from './client.js';
import { ACCOUNT_STATUS, DOWNLOAD, JOB_STATUS, PARAM, REDACT_ASYNC, REDACT_AND_WAIT, TRY_DEMO } from './descriptions.js';
import { RedactPdfError } from './errors.js';
import { logToolCall } from './observability.js';
import { fileFromBase64, fileFromPath, fileFromUrl } from './inputs.js';
import { isTerminal, pollUntilTerminal, type PollOptions } from './poll.js';
import {
  MAX_IMAGE_BYTES,
  MAX_PDF_BYTES,
  PII_CATEGORIES,
  type InputFile,
  type Job,
  type RedactionRules,
} from './types.js';

/** stdio can touch the user's disk; a hosted HTTP server cannot. */
export type ServerMode = 'stdio' | 'http';

export interface CreateServerOptions {
  mode: ServerMode;
  client: RedactPdfClient;
  /** Ceiling for inline base64 in remote responses; larger outputs return a URL. */
  maxInlineBytes?: number;
  /**
   * Fetcher used to download `file_url` inputs in remote mode. Deliberately
   * separate from the API client's fetch: this one must never carry the
   * caller's API key to a third-party URL. Injectable for tests.
   */
  fetchImpl?: typeof fetch;
  /**
   * Hostname resolver used when validating a `file_url`. Injectable so the test
   * suite can exercise the guard without a real DNS lookup — without it three
   * tests silently resolved example.com on every CI run.
   */
  resolveHost?: (hostname: string) => Promise<string[]>;
  /**
   * Overrides for the `redact_pdf_and_wait` poll schedule. A deployment that
   * knows its documents are small can poll sooner; the defaults suit a mix.
   * `timeout_seconds` on the tool call still wins over `timeoutMs` here.
   */
  pollOptions?: PollOptions;
}

/**
 * Read from package.json rather than duplicated here: `npm version patch` edits
 * package.json and nothing else, so a hardcoded copy would report a stale
 * version to every MCP client from the first release onward. package.json is
 * always present in an npm tarball, one level up from dist/.
 */
export const VERSION: string = readVersion();

function readVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    return (require('../package.json') as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
const DEFAULT_MAX_INLINE_BYTES = 6 * 1024 * 1024;
const MAX_TIMEOUT_SECONDS = 900;

/** Shared redaction-rule arguments — identical across both redact tools. */
const ruleShape = {
  pii_categories: z.array(z.enum(PII_CATEGORIES)).min(1).optional().describe(PARAM.piiCategories),
  pii_included_terms: z.array(z.string()).optional().describe(PARAM.includedTerms),
  pii_excluded_terms: z.array(z.string()).optional().describe(PARAM.excludedTerms),
  retention: z.enum(['ephemeral', 'studio']).optional().describe(PARAM.retention),
  idempotency_key: z.string().max(200).optional().describe(PARAM.idempotencyKey),
};

type RuleArgs = {
  pii_categories?: string[];
  pii_included_terms?: string[];
  pii_excluded_terms?: string[];
  retention?: 'ephemeral' | 'studio';
  idempotency_key?: string;
};

/**
 * Build the wire rules from tool arguments.
 *
 * Delegates the empty-list stripping to the client's `withoutEmptyRules` rather
 * than repeating it: the API reads `pii_categories: []` as a deliberate "redact
 * nothing", so a job would report `redacted` over an untouched document. Two
 * copies of that guard is two places for it to rot.
 */
function rulesFrom(args: RuleArgs): RedactionRules {
  return withoutEmptyRules({
    ...(args.pii_categories ? { pii_categories: args.pii_categories } : {}),
    ...(args.pii_included_terms ? { pii_included_terms: args.pii_included_terms } : {}),
    ...(args.pii_excluded_terms ? { pii_excluded_terms: args.pii_excluded_terms } : {}),
    ...(args.retention ? { retention: args.retention } : {}),
  });
}

/** Source arguments differ by transport — see the note in inputs.ts. */
const stdioSourceShape = {
  file_path: z.string().min(1).describe(PARAM.filePath),
};

const httpSourceShape = {
  file_url: z.string().url().optional().describe(PARAM.fileUrl),
  file_base64: z.string().optional().describe(PARAM.fileBase64),
  filename: z.string().optional().describe(PARAM.filename),
};

/** Remote inputs with `file_url` withheld — see urlInputEnabled(). */
const httpSourceShapeNoUrl = {
  file_base64: z.string().optional().describe(PARAM.fileBase64),
  filename: z.string().optional().describe(PARAM.filename),
};

/**
 * Whether the hosted server will fetch a caller-supplied URL. Off by default.
 *
 * `assertPublicUrl` resolves a hostname and judges the addresses it gets back,
 * but the socket then resolves the name a second time — so a DNS-rebinding
 * attacker with a short TTL can have us validate a public address and connect
 * to a private one. Closing that properly means pinning the connection to the
 * validated IP, which needs a custom dispatcher.
 *
 * Until then the honest posture for an internet-reachable server is to not have
 * the surface at all: `file_base64` covers the same use case without asking the
 * server to make an outbound request on a stranger's behalf. Operators who need
 * URL input — and who have egress controls of their own — opt in explicitly.
 *
 * stdio is unaffected: it runs on the user's own machine, where a URL fetch has
 * no privilege the user lacks.
 */
function urlInputEnabled(): boolean {
  return process.env.REDACT_PDF_ENABLE_URL_INPUT === '1';
}

type SourceArgs = {
  file_path?: string;
  file_url?: string;
  file_base64?: string;
  filename?: string;
};

async function resolveInput(
  mode: ServerMode,
  args: SourceArgs,
  fetchImpl: typeof fetch,
  resolveHost?: (hostname: string) => Promise<string[]>,
): Promise<InputFile> {
  if (mode === 'stdio') {
    if (!args.file_path) {
      throw new RedactPdfError('file_path is required.', { code: 'invalid_request' });
    }
    return fileFromPath(args.file_path);
  }
  if (args.file_url) {
    if (!urlInputEnabled()) {
      throw new RedactPdfError(
        'This server does not fetch documents by URL. Send the document inline as file_base64 (with filename) instead.',
        { code: 'invalid_request' },
      );
    }
    return fileFromUrl(args.file_url, fetchImpl, resolveHost);
  }
  if (args.file_base64) {
    if (!args.filename) {
      throw new RedactPdfError(
        'filename is required alongside file_base64, so the document type can be determined (e.g. "contract.pdf").',
        { code: 'invalid_request' },
      );
    }
    return fileFromBase64(args.filename, args.file_base64);
  }
  throw new RedactPdfError('Provide either file_url or file_base64 (with filename).', {
    code: 'invalid_request',
  });
}

/** `/a/b/report.pdf` -> `/a/b/report-redacted.pdf` */
export function defaultOutputPath(inputPath: string): string {
  const absolute = isAbsolute(inputPath) ? inputPath : resolve(process.cwd(), inputPath);
  const ext = extname(absolute);
  const stem = basename(absolute, ext);
  // Images come back as PDFs — the API converts them during ingest.
  return join(dirname(absolute), `${stem}-redacted.pdf`);
}

/**
 * Run work that happens after a job exists, tagging any failure with its id.
 *
 * Without this, a failure between "job created" and "file written" reports an
 * error with no handle on work the user has already paid for, and the agent's
 * only recourse is to upload and pay again.
 */
async function withJobContext<T>(jobId: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    // Any throwable, not just RedactPdfError: `downloadOutput` reads the body
    // outside the client's own try/catch, so a mid-download connection reset
    // arrives as a bare TypeError. Letting that through unwrapped loses the job
    // id on a document the user has already paid for.
    throw asJobError(error, jobId);
  }
}

/** As withJobContext, but the output exists, so the failure is resumable by download. */
async function withDocumentContext<T>(
  jobId: string,
  documentId: string,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw asJobError(error, jobId, documentId);
  }
}

function asJobError(error: unknown, jobId: string, documentId?: string): RedactPdfError {
  const wrapped =
    error instanceof RedactPdfError
      ? error
      : new RedactPdfError(
          `Downloading the redacted output failed: ${error instanceof Error ? error.message : String(error)}.`,
          { code: 'network_error', retryable: true },
        );
  return wrapped.jobId ? wrapped : wrapped.withJob(jobId, documentId);
}

function resolveOutputPath(candidate: string): string {
  return isAbsolute(candidate) ? candidate : resolve(process.cwd(), candidate);
}

/**
 * Write the redacted PDF, atomically and without clobbering.
 *
 * Atomic because a half-written PDF that looks like a redacted document is
 * worse than no file at all — the user would have no way to tell. Non-clobbering
 * because `output_path` is model-chosen, and silently overwriting whatever
 * happens to be at that path is not a decision a tool should make on its own.
 */
async function writeOutput(outputPath: string, bytes: Uint8Array): Promise<void> {
  // The temp name must be unique per call, not merely per process-and-moment.
  // Deriving it from pid + timestamp collided when two tool calls landed in the
  // same millisecond: both truncated the SAME temp file, and because link()
  // leaves that name pointing at the delivered inode, the second write went
  // THROUGH the hardlink and rewrote a file the first call had already reported
  // as finished — one document's bytes inside another document's output. A
  // random component plus O_EXCL makes sharing a temp file impossible.
  //
  // Kept short and in the destination's own directory (all link() needs) rather
  // than appended to outputPath: a 45-character suffix on an already-long
  // basename overflows the 255-byte limit, failing the temp create for a final
  // path that is itself perfectly legal.
  const temp = join(dirname(outputPath), `.redact-${randomUUID()}.partial`);
  try {
    // 'wx' fails rather than truncating if the name somehow already exists.
    await writeFile(temp, bytes, { flag: 'wx' });
  } catch (cause) {
    // 'wx' failing with EEXIST proves we did NOT create this file, so deleting
    // it would destroy whatever does own the name — a concurrent call's
    // in-flight temp. Sharing a temp file is how round 3 spliced one document's
    // bytes into another's output; do not also make it deletable.
    if ((cause as NodeJS.ErrnoException)?.code !== 'EEXIST') {
      await unlink(temp).catch(() => undefined);
    }
    throw writeFailure(outputPath, cause);
  }

  try {
    // link() fails if the destination exists — unlike rename(), which replaces
    // it silently. Checking with stat() first would leave a window in which a
    // concurrent call could create the file between the check and the write,
    // so let the filesystem decide, atomically.
    await link(temp, outputPath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code === 'EEXIST') {
      throw alreadyExistsError(outputPath);
    }
    // ANY other link() failure falls back to an exclusive create at the
    // destination. This gate used to enumerate the errnos of filesystems
    // without hardlinks (exFAT, FAT32, parts of SMB and FUSE) — which meant
    // guessing them per platform, and getting it wrong off POSIX: Windows maps
    // a CreateHardLinkW failure on a non-NTFS volume to EISDIR, and some FUSE
    // mounts answer ENOSYS, neither of which was listed. The user then got
    // "pass an absolute output_path inside a directory this process can write
    // to" for a directory plain writeFile handles — after the pages were
    // already billed. Falling back on everything is safe because 'wx' keeps the
    // no-overwrite guarantee, and a genuine fault (EACCES, ENOSPC) still fails
    // here with the honest error it would have raised anyway. Only
    // crash-atomicity is traded away, which these filesystems never offered.
    try {
      await writeFile(outputPath, bytes, { flag: 'wx' });
    } catch (fallbackCause) {
      if ((fallbackCause as NodeJS.ErrnoException)?.code === 'EEXIST') {
        throw alreadyExistsError(outputPath);
      }
      throw writeFailure(outputPath, fallbackCause);
    }
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

/** One wording for the refusal, reached from both the link and fallback paths. */
function alreadyExistsError(outputPath: string): RedactPdfError {
  return new RedactPdfError(
    `"${outputPath}" already exists. Refusing to overwrite it — pass a different output_path, or delete the existing file first if it is genuinely stale.`,
    { code: 'invalid_request' },
  );
}

function writeFailure(outputPath: string, cause: unknown): RedactPdfError {
  return new RedactPdfError(
    `Could not write the redacted PDF to "${outputPath}": ${cause instanceof Error ? cause.message : String(cause)}. Pass an absolute output_path inside a directory this process can write to.`,
    { code: 'invalid_request' },
  );
}

function jsonResult(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(error: unknown): CallToolResult {
  const message =
    error instanceof RedactPdfError
      ? error.toAgentMessage()
      : error instanceof Error
        ? error.message
        : String(error);
  const code = error instanceof RedactPdfError ? error.code : 'error';
  const retryable = error instanceof RedactPdfError ? error.retryable : false;
  const jobId = error instanceof RedactPdfError ? error.jobId : undefined;
  const documentId = error instanceof RedactPdfError ? error.documentId : undefined;

  const body: Record<string, unknown> = { error: message, code, retryable };
  // A failure after the job exists has already cost the user pages. Give the
  // agent the ids as structured fields so it resumes instead of re-uploading.
  if (jobId) {
    body.job_id = jobId;
    if (documentId) body.document_id = documentId;
    body.resume_with = documentId
      ? { tool: 'download_redacted', document_id: documentId }
      : { tool: 'get_job_status', job_id: jobId };
    body.do_not_re_upload =
      'This document was already submitted and billed. Use resume_with rather than calling a redact tool again.';
  }
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
  };
}

/**
 * Wrap a handler so a thrown error becomes a tool error the model can act on —
 * and so every call leaves a trace.
 *
 * `guard` converting failures into ordinary results is what made this package
 * silent under load: nothing threw, so nothing was logged, and every response
 * was an HTTP 200. The log line here is the only evidence an operator gets.
 */
function guard<A>(toolName: string, handler: (args: A) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    const startedAt = Date.now();
    try {
      const result = await handler(args);
      logToolCall({ tool: toolName, outcome: 'ok', durationMs: Date.now() - startedAt });
      return result;
    } catch (error) {
      const failure = error instanceof RedactPdfError ? error : undefined;
      logToolCall({
        tool: toolName,
        outcome: 'error',
        durationMs: Date.now() - startedAt,
        code: failure?.code ?? 'error',
        httpStatus: failure?.status,
        jobId: failure?.jobId,
        documentId: failure?.documentId,
        requestId: failure?.requestId,
      });
      return errorResult(error);
    }
  };
}

/**
 * The API silently drops files it cannot ingest (unsupported type, over the
 * size cap) rather than failing the whole job — so a job can come back with
 * fewer documents than we sent, or none at all. Catch that here: a job with no
 * documents would otherwise be polled until timeout for work that will never
 * happen.
 */
function assertJobAccepted(job: Job): void {
  if (job.documents.length === 0) {
    throw new RedactPdfError(
      `The job was created but the server accepted none of the files. Redact PDF AI takes PDF, JPEG and PNG within the size limits (${MAX_PDF_BYTES / 1024 / 1024} MB PDF / ${MAX_IMAGE_BYTES / 1024 / 1024} MB image); check the file is a real, non-corrupt document of one of those types.`,
      { code: 'invalid_request' },
    );
  }
  // No partial-acceptance branch: every tool submits exactly one file, so
  // "some accepted" cannot occur. Add one here if a batch tool is introduced —
  // client.createJob already accepts up to MAX_FILES_PER_JOB.
}

function summariseJob(job: Job) {
  return {
    job_id: job.job_id,
    status: job.status,
    retention: job.retention,
    created_at: job.created_at,
    documents: job.documents.map((doc) => ({
      document_id: doc.id,
      file_name: doc.file_name,
      status: doc.status,
      page_count: doc.page_count,
      error_message: doc.error_message,
    })),
  };
}

export function createServer(options: CreateServerOptions): McpServer {
  const { mode, client } = options;
  const maxInlineBytes = options.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES;
  const downloadFetch = options.fetchImpl ?? globalThis.fetch;
  const resolveHost = options.resolveHost;
  const pollOptions = options.pollOptions ?? {};

  const server = new McpServer(
    { name: 'redact-pdf', version: VERSION },
    {
      instructions:
        'Redact PDF AI permanently removes PII from documents. The sensitive text is deleted from the file, not covered with a black box. It accepts PDF, JPEG and PNG, so pass a photo or screenshot straight in rather than converting it to a PDF first; the output is a redacted PDF either way. For almost every request, call redact_pdf_and_wait once and you are done. try_demo needs no API key and is the fastest way to confirm the server is working.',
    },
  );

  // Typed as ZodRawShape so the stdio/http branches unify instead of widening
  // each optional key to `undefined`.
  const sourceShape: z.ZodRawShape =
    mode === 'stdio'
      ? stdioSourceShape
      : urlInputEnabled()
        ? httpSourceShape
        : httpSourceShapeNoUrl;
  const destinationShape: z.ZodRawShape =
    mode === 'stdio'
      ? { output_path: z.string().optional().describe(PARAM.outputPath) }
      : {};

  // ---- 1. The one-call tool. Listed first on purpose. -----------------------
  server.registerTool(
    'redact_pdf_and_wait',
    {
      title: 'Redact a PDF (upload, wait, return the redacted file)',
      description: REDACT_AND_WAIT,
      inputSchema: {
        ...sourceShape,
        ...destinationShape,
        ...ruleShape,
        timeout_seconds: z.number().int().min(10).max(MAX_TIMEOUT_SECONDS).optional().describe(PARAM.timeout),
      },
      // Writes a redacted PDF to disk in stdio mode; declare that honestly.
      annotations: {
        readOnlyHint: false,
        destructiveHint: mode === 'stdio',
        openWorldHint: true,
      },
    },
    guard('redact_pdf_and_wait', async (args: SourceArgs & RuleArgs & { output_path?: string; timeout_seconds?: number }) => {
      const file = await resolveInput(mode, args, downloadFetch, resolveHost);
      const job = await client.createJob([file], rulesFrom(args), args.idempotency_key);
      assertJobAccepted(job);

      // Past this point the pages are spent. Any failure must hand back the id.
      return await withJobContext(job.job_id, async () => {
        const finished = await pollUntilTerminal(
          job.job_id,
          // One attempt per poll, bounded by the remaining budget: the loop is
          // the retry, so letting the client retry inside it multiplies traffic
          // and breaks the advertised timeout.
          //
          // Bounded by METADATA_TIMEOUT_MS as well as the budget. Passing the
          // remaining budget alone let ONE read own the whole wait: with the
          // 300s default, the first poll issued a single request with a ~298s
          // deadline, so an upstream that accepts the connection and then hangs
          // burned the entire budget on one attempt and the loop never got a
          // second — "the loop is itself the retry" only holds if a read is
          // short enough for a retry to fit.
          (id, remainingMs) =>
            client.getJob(id, {
              maxAttempts: 1,
              timeoutMs: Math.min(METADATA_TIMEOUT_MS, Math.max(1_000, remainingMs)),
            }),
          {
          ...pollOptions,
          // No local default: poll.ts owns DEFAULT_POLL_OPTIONS.timeoutMs, and a
          // second copy here would drift from the value the description states.
          ...(args.timeout_seconds != null ? { timeoutMs: args.timeout_seconds * 1000 } : {}),
          },
        );

        const document = finished.documents[0];
        if (!document || document.status !== 'redacted') {
          throw new RedactPdfError(
            `Redaction failed for "${file.filename}": ${document?.error_message ?? 'the document did not reach a redacted state'}.${args.idempotency_key ? '' : ' Because no idempotency_key was given, one was derived from the file contents, so calling this tool again with the same file and settings will replay THIS SAME failed job for the next 24 hours. To force a genuine fresh attempt, call again with a distinct idempotency_key.'}`,
            // Deliberately no documentId: the redaction failed, so there is no
            // output to download. Handing one over makes resume_with point the
            // agent at download_redacted for a document that produced nothing.
            { code: 'error', retryable: false, jobId: finished.job_id },
          );
        }

        // From here the output exists, so a failure IS resumable by downloading
        // it — tag with the document id so resume_with says so.
        const bytes = await withDocumentContext(finished.job_id, document.id, () =>
          client.downloadOutput(document.id),
        );

        if (mode === 'stdio') {
          const outputPath = args.output_path
            ? resolveOutputPath(args.output_path)
            : defaultOutputPath(args.file_path as string);
          // Inside the document context: the bytes are downloaded and billed by
          // now, so a write failure is resumable by downloading again.
          await withDocumentContext(finished.job_id, document.id, () =>
            writeOutput(outputPath, bytes),
          );
          return jsonResult({
            status: 'redacted',
            output_path: outputPath,
            pages_redacted: document.page_count,
            job_id: finished.job_id,
            document_id: document.id,
            note: 'The PII text was removed from the file, not covered — it cannot be recovered from the output. The original file was not modified.',
          });
        }

        return jsonResult({
          status: 'redacted',
          pages_redacted: document.page_count,
          job_id: finished.job_id,
          document_id: document.id,
          ...downloadPayload(client.baseUrl, document.id, bytes, maxInlineBytes),
        });
      });
    }),
  );

  // ---- 2. Fire-and-forget upload. -----------------------------------------
  server.registerTool(
    'redact_pdf',
    {
      title: 'Start a redaction job (does not wait)',
      description: REDACT_ASYNC,
      inputSchema: { ...sourceShape, ...ruleShape },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard('redact_pdf', async (args: SourceArgs & RuleArgs) => {
      const file = await resolveInput(mode, args, downloadFetch, resolveHost);
      const job = await client.createJob([file], rulesFrom(args), args.idempotency_key);
      assertJobAccepted(job);
      return jsonResult({
        ...summariseJob(job),
        next_step: `Poll get_job_status with job_id "${job.job_id}" until status is "redacted", then call download_redacted.`,
      });
    }),
  );

  // ---- 3. Status. ----------------------------------------------------------
  server.registerTool(
    'get_job_status',
    {
      title: 'Check redaction job status',
      description: JOB_STATUS,
      inputSchema: { job_id: z.string().min(1).describe(PARAM.jobId) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('get_job_status', async (args: { job_id: string }) => {
      const job = await client.getJob(args.job_id);
      const done = isTerminal(job);
      return jsonResult({
        ...summariseJob(job),
        is_final: done,
        next_step: done
          ? 'Call download_redacted with a document_id whose status is "redacted".'
          : 'Still processing — wait a few seconds before checking again.',
      });
    }),
  );

  // ---- 4. Download. --------------------------------------------------------
  server.registerTool(
    'download_redacted',
    {
      title: 'Download a redacted PDF',
      description: DOWNLOAD,
      inputSchema: {
        document_id: z.string().min(1).describe(PARAM.documentId),
        ...destinationShape,
      },
      // In stdio mode this writes a file to a model-chosen path. Declaring it
      // read-only would let clients auto-approve it without prompting.
      annotations:
        mode === 'stdio'
          ? { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
          : { readOnlyHint: true, openWorldHint: true },
    },
    guard('download_redacted', async (args: { document_id: string; output_path?: string }) => {
      const bytes = await client.downloadOutput(args.document_id);

      if (mode === 'stdio') {
        const outputPath = args.output_path
          ? resolveOutputPath(args.output_path)
          : resolve(process.cwd(), `${args.document_id}-redacted.pdf`);
        await writeOutput(outputPath, bytes);
        return jsonResult({
          status: 'downloaded',
          output_path: outputPath,
          bytes: bytes.byteLength,
        });
      }

      return jsonResult({
        status: 'downloaded',
        bytes: bytes.byteLength,
        ...downloadPayload(client.baseUrl, args.document_id, bytes, maxInlineBytes),
      });
    }),
  );

  // ---- 5. Keyless demo. ----------------------------------------------------
  server.registerTool(
    'try_demo',
    {
      title: 'Try redaction with no API key',
      description: TRY_DEMO,
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('try_demo', async () => {
      const demo = await client.demo();
      return jsonResult({
        status: 'ok',
        message: demo.message,
        sample_input: demo.sample_input,
        detected_and_removed: demo.detected_pii,
        redacted_sample_pdf: `${client.baseUrl}${demo.redacted_pdf_path}`,
        api_key_configured: client.hasApiKey,
        next_step: client.hasApiKey
          ? 'An API key is configured — call redact_pdf_and_wait to redact a real document.'
          : 'No API key is configured. To redact real documents, get a key at https://www.redact-pdf.ai/sign-up and set REDACT_PDF_API_KEY.',
      });
    }),
  );

  // ---- 6. Account / quota preflight. ---------------------------------------
  server.registerTool(
    'get_account_status',
    {
      title: 'Check API key and account',
      description: ACCOUNT_STATUS,
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('get_account_status', async () => {
      const me = await client.me();
      return jsonResult({
        status: 'ok',
        authenticated: true,
        user_id: me.user_id,
        email: me.email,
        note: 'The key is valid. Redaction is billed per page against this account\'s plan quota and credit packs; a redaction call that fails with code "quota_exceeded" means the user must top up. Pricing: https://www.redact-pdf.ai/pricing',
      });
    }),
  );

  return server;
}

/**
 * Remote mode has no user filesystem, so hand back the bytes when they are
 * small enough to be worth inlining, and otherwise the authenticated URL.
 */
function downloadPayload(
  baseUrl: string,
  documentId: string,
  bytes: Uint8Array,
  maxInlineBytes: number,
): Record<string, unknown> {
  const url = `${baseUrl}/v1/documents/${encodeURIComponent(documentId)}/output`;
  if (bytes.byteLength <= maxInlineBytes) {
    return {
      content_base64: Buffer.from(bytes).toString('base64'),
      content_type: 'application/pdf',
      bytes: bytes.byteLength,
      download_url: url,
    };
  }
  return {
    bytes: bytes.byteLength,
    download_url: url,
    download_note: `The file is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB — too large to inline. Fetch download_url with the header "X-API-Key: <your key>".`,
  };
}
