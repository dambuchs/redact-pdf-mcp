/**
 * The MCP server: tools over the Redact PDF AI `/v1` API, plus one local-only
 * tool (restore_names) that never talks to it.
 *
 * Tool registration order is deliberate. Clients present tools to the model in
 * the order the server lists them, and agents reliably reach for the first
 * plausible match — so the one-call `redact_pdf_and_wait` goes first and the
 * lower-level pieces follow.
 */

import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { link, readFile, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { METADATA_TIMEOUT_MS, RedactPdfClient, withoutEmptyRules } from './client.js';
import {
  ACCOUNT_STATUS,
  describeFor,
  JOB_STATUS,
  KEY_SETUP_NOTE,
  PARAM,
  RESTORE_NAMES,
  SET_API_KEY,
  TRY_DEMO,
} from './descriptions.js';
import { isWellFormedKey, writeKeyFile, type KeySource } from './key.js';
import { RedactPdfError, SIGN_UP_URL } from './errors.js';
import { logToolCall } from './observability.js';
import { fileFromBase64, fileFromPath, fileFromUrl } from './inputs.js';
import { isTerminal, pollUntilTerminal, type PollOptions } from './poll.js';
import {
  parseCorrespondenceCsv,
  RESTORABLE_EXTENSIONS,
  restoreDocx,
  restoredPath,
  restoreText,
  type RestoreCounts,
} from './restore.js';
import {
  DEMO_MAX_BYTES,
  MAX_IMAGE_BYTES,
  MAX_PDF_BYTES,
  PII_CATEGORIES,
  REDACTION_MODES,
  type InputFile,
  type Job,
  type RedactionMode,
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
   * Ceiling for the pseudonymized text returned inline. Larger texts go to a
   * file next to the PDF (stdio) or a URL (remote): a 300-page contract inline
   * would fill the agent's context before it could do any work.
   */
  maxInlineTextBytes?: number;
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
  /**
   * Where the stdio server's key comes from. When given (stdio only), the
   * server registers set_api_key, which saves a key to `keySource.filePath`.
   * The client should read its key from the same source so the save applies
   * at once.
   */
  keySource?: KeySource;
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
export const DEFAULT_MAX_INLINE_TEXT_BYTES = 32 * 1024;
const MAX_TIMEOUT_SECONDS = 900;

/**
 * What-to-redact arguments, shared by the redact tools AND the keyless demo.
 * One validator on purpose: a hand-typed copy for the demo once accepted any
 * string, so "email" (not "Email") uploaded the file, redacted nothing, and
 * came back as a successful "no personal data found".
 */
const piiRuleShape = {
  pii_categories: z.array(z.enum(PII_CATEGORIES)).min(1).optional().describe(PARAM.piiCategories),
  pii_included_terms: z.array(z.string()).optional().describe(PARAM.includedTerms),
  pii_excluded_terms: z.array(z.string()).optional().describe(PARAM.excludedTerms),
  mode: z.enum(REDACTION_MODES).optional().describe(PARAM.mode),
};

/** Job-level arguments that only apply to billed jobs. */
const ruleShape = {
  ...piiRuleShape,
  retention: z.enum(['ephemeral', 'studio']).optional().describe(PARAM.retention),
  idempotency_key: z.string().max(200).optional().describe(PARAM.idempotencyKey),
};

type RuleArgs = {
  pii_categories?: string[];
  pii_included_terms?: string[];
  pii_excluded_terms?: string[];
  retention?: 'ephemeral' | 'studio';
  mode?: RedactionMode;
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
    ...(args.mode ? { mode: args.mode } : {}),
  });
}

/** The correspondence file next to the redacted PDF: `x-redacted.pdf` -> `x-correspondence.csv`. */
export function correspondencePath(outputPath: string): string {
  const ext = extname(outputPath);
  const stem = basename(outputPath, ext).replace(/-redacted$/, '');
  return join(dirname(outputPath), `${stem}-correspondence.csv`);
}

/**
 * The tag -> original table of a pseudonymized document, best effort.
 *
 * The PDF is already written (and billed) when this runs, so a failure here
 * must not turn the call into an error: the agent would re-run a finished job.
 * It is reported next to the result instead, with how to fetch the table later.
 */
async function fetchCorrespondence(
  client: RedactPdfClient,
  documentId: string,
): Promise<{ csv: string } | { error: string }> {
  try {
    return { csv: await client.downloadCorrespondence(documentId) };
  } catch (error) {
    return { error: correspondenceFailure(client, documentId, error) };
  }
}

/** stdio: fetch the table and write it next to the PDF, never over an existing file. */
async function writeCorrespondence(
  client: RedactPdfClient,
  documentId: string,
  path: string,
): Promise<{ correspondence_path: string } | { correspondence_error: string }> {
  const fetched = await fetchCorrespondence(client, documentId);
  if ('error' in fetched) return { correspondence_error: fetched.error };
  try {
    // With a BOM, as the API serves it, so Excel opens accented names right.
    await writeOutput(path, new TextEncoder().encode(`\uFEFF${fetched.csv}`));
    return { correspondence_path: path };
  } catch (error) {
    return { correspondence_error: correspondenceFailure(client, documentId, error) };
  }
}

function correspondenceFailure(client: RedactPdfClient, documentId: string, error: unknown): string {
  const message =
    error instanceof RedactPdfError ? error.toAgentMessage() : error instanceof Error ? error.message : String(error);
  // A 409/422 says what the user must do first; fetching again would only
  // repeat it, so the "get it later" hint is for transient failures only.
  const settled = error instanceof RedactPdfError && (error.code === 'conflict' || error.code === 'invalid_request');
  const later = settled ? '' : ` Get it later with the download_correspondence tool (document_id "${documentId}").`;
  return `The redacted PDF is ready, but the correspondence table could not be saved: ${message}${later} Do not redact again.`;
}

/** The text version next to the PDF: `x-redacted.pdf` -> `x-redacted.md`. */
export function documentTextPath(outputPath: string): string {
  const ext = extname(outputPath);
  return join(dirname(outputPath), `${basename(outputPath, ext)}.md`);
}

const textBytes = (text: string) => new TextEncoder().encode(text).byteLength;

/**
 * The pseudonymized document as text, best effort like the table: the PDF is
 * done and billed, so a failure is reported next to it, never as an error.
 *
 * `missingIsQuiet`: download_redacted does not know the document's mode, and
 * a redact-mode document has no text (404). There, absence is not news.
 */
async function documentText(
  client: RedactPdfClient,
  documentId: string,
  target: { stdioPath: string } | { baseUrl: string },
  maxInlineTextBytes: number,
  missingIsQuiet: boolean,
): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await client.downloadOutputText(documentId);
  } catch (error) {
    if (missingIsQuiet && error instanceof RedactPdfError && error.code === 'not_found') return {};
    const message = error instanceof RedactPdfError ? error.toAgentMessage() : error instanceof Error ? error.message : String(error);
    return { document_text_error: `The redacted PDF is ready, but its text version could not be fetched: ${message} Do not redact again.` };
  }
  const bytes = textBytes(text);
  if (bytes <= maxInlineTextBytes) return { document_text: text };
  if ('stdioPath' in target) {
    try {
      await writeOutput(target.stdioPath, new TextEncoder().encode(text));
    } catch (error) {
      const message = error instanceof RedactPdfError ? error.toAgentMessage() : String(error);
      return { document_text_error: `The redacted PDF is ready, but its text version could not be saved: ${message} Do not redact again.` };
    }
    return {
      document_text_path: target.stdioPath,
      document_text_bytes: bytes,
      document_text_note: `The text version is ${(bytes / 1024).toFixed(0)} KB, too large to return inline; it was written to document_text_path. Read it from there (it contains tags, not names).`,
    };
  }
  return {
    document_text_url: `${target.baseUrl}/v1/documents/${encodeURIComponent(documentId)}/output.md`,
    document_text_bytes: bytes,
    document_text_note: `The text version is ${(bytes / 1024).toFixed(0)} KB, too large to return inline. Fetch document_text_url with the header "X-API-Key: <your key>".`,
  };
}

const WORK_FROM_TEXT =
  'Work from document_text (or the file at document_text_path): it is the document as the PDF shows it, every name replaced by its tag. Do not OCR or read the PDF instead, and do not open the original file.';

const KEEP_TAGS = 'Keep each tag exactly as written, brackets included, wherever your answer refers to that entity.';
const NEVER_OPEN =
  'Never open the correspondence table or the restored file yourself: both contain the real names, and reading them puts the names into this conversation.';

const RESTORE_NEXT_STEP = `${WORK_FROM_TEXT} ${KEEP_TAGS} To hand the user a version with the real names, write your result to a .md, .txt or .docx file and call restore_names with that file and correspondence_path. ${NEVER_OPEN}`;

/** download_redacted has no correspondence_path: the table is one more call away. */
const DOWNLOAD_NEXT_STEP = `${WORK_FROM_TEXT} ${KEEP_TAGS} To hand the user a version with the real names, save the table with download_correspondence (same document_id; it returns output_path), write your result to a .md, .txt or .docx file, and call restore_names with that file and the table's path. ${NEVER_OPEN}`;

/**
 * A next step only when there is text to work from. After a failed fetch,
 * "work from document_text" points at a field that is not there, and "do not
 * read the PDF" leaves the agent no way forward at all.
 */
function hasDocumentText(fields: Record<string, unknown>): boolean {
  return 'document_text' in fields || 'document_text_path' in fields || 'document_text_url' in fields;
}

const REMOTE_NEXT_STEP = `Work from document_text (or fetch document_text_url): it is the document as the PDF shows it, every name replaced by its tag. Do not OCR the PDF instead. ${KEEP_TAGS} This hosted server cannot put the names back; the user can, with the correspondence table, or with restore_names on a local install (npx redact-pdf-mcp).`;

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

function hasSource(args: SourceArgs): boolean {
  return Boolean(args.file_path || args.file_url || args.file_base64);
}

const PSEUDONYMIZED_NOTE =
  'Each entity was replaced by a consistent tag such as [Person 1]; the original text was removed from the file, not covered. The correspondence table maps every tag back to the original and re-identifies the document: keep it with the user and never share it alongside the redacted PDF.';

/** The one sentence that turns "get a key" into "it costs nothing to try". */
export const FREE_FIRST_DOCUMENT_NOTE =
  'A free account gets its first document (up to 5 pages) redacted in full, editable masks included, with no card.';

async function resolveInput(
  mode: ServerMode,
  args: SourceArgs,
  fetchImpl: typeof fetch,
  resolveHost?: (hostname: string) => Promise<string[]>,
): Promise<InputFile> {
  if (mode === 'stdio') {
    if (!args.file_path) {
      throw new RedactPdfError(
        args.file_url || args.file_base64
          ? 'This server runs on the user\'s machine and reads files by path: pass file_path (an absolute path). file_url and file_base64 are for the hosted server.'
          : 'file_path is required.',
        { code: 'invalid_request' },
      );
    }
    return fileFromPath(args.file_path);
  }
  if (args.file_path) {
    throw new RedactPdfError(
      'This server is hosted and cannot read paths on your machine. Send the document inline as file_base64 (with filename).',
      { code: 'invalid_request' },
    );
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
    `Could not write "${outputPath}": ${cause instanceof Error ? cause.message : String(cause)}. Pass an absolute output_path inside a directory this process can write to.`,
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
    mode: job.mode ?? 'redact',
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
  const maxInlineTextBytes = options.maxInlineTextBytes ?? DEFAULT_MAX_INLINE_TEXT_BYTES;
  const downloadFetch = options.fetchImpl ?? globalThis.fetch;
  const resolveHost = options.resolveHost;
  const pollOptions = options.pollOptions ?? {};
  const wording = describeFor(mode);
  // A hosted server must never write a key to its own disk.
  const keySource = mode === 'stdio' ? options.keySource : undefined;

  // While a key the user hasn't confirmed is in use, every result names its
  // account: if injected text planted it, the wrong account shows on first use.
  const tool = <A>(name: string, handler: (args: A) => Promise<CallToolResult>) => {
    const guarded = guard(name, handler);
    return async (args: A): Promise<CallToolResult> => {
      const result = await guarded(args);
      const session = keySource?.session();
      return session
        ? { ...result, content: [...result.content, { type: 'text', text: sessionAccountNote(session.account) }] }
        : result;
    };
  };

  const server = new McpServer(
    { name: 'redact-pdf', version: VERSION },
    { instructions: keySource ? `${wording.instructions}\n\n${KEY_SETUP_NOTE}` : wording.instructions },
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
      description: wording.redactAndWait,
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
    tool('redact_pdf_and_wait', async (args: SourceArgs & RuleArgs & { output_path?: string; timeout_seconds?: number }) => {
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

        // The server's record of the job decides, not the argument: a replayed
        // idempotency key returns the job as it was first created, and a
        // server that predates modes (no `mode` field) ignored the argument
        // and drew black boxes.
        const pseudonymized = (finished.mode ?? 'redact') === 'pseudonymize';

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
          const correspondence = pseudonymized
            ? await writeCorrespondence(client, document.id, correspondencePath(outputPath))
            : {};
          const text = pseudonymized
            ? await documentText(client, document.id, { stdioPath: documentTextPath(outputPath) }, maxInlineTextBytes, false)
            : {};
          return jsonResult({
            status: 'redacted',
            mode: pseudonymized ? 'pseudonymize' : 'redact',
            output_path: outputPath,
            ...correspondence,
            pages_redacted: document.page_count,
            job_id: finished.job_id,
            document_id: document.id,
            note: pseudonymized
              ? `${PSEUDONYMIZED_NOTE} The original file was not modified.`
              : 'The PII text was removed from the file, not covered — it cannot be recovered from the output. The original file was not modified.',
            ...text,
            ...(hasDocumentText(text) ? { next_step: RESTORE_NEXT_STEP } : {}),
          });
        }

        const correspondence = pseudonymized ? await fetchCorrespondence(client, document.id) : null;
        const text = pseudonymized
          ? await documentText(client, document.id, { baseUrl: client.baseUrl }, maxInlineTextBytes, false)
          : {};
        return jsonResult({
          status: 'redacted',
          mode: pseudonymized ? 'pseudonymize' : 'redact',
          pages_redacted: document.page_count,
          job_id: finished.job_id,
          document_id: document.id,
          ...downloadPayload(client.baseUrl, document.id, bytes, maxInlineBytes),
          ...(correspondence === null
            ? {}
            : 'csv' in correspondence
              ? { correspondence_csv: correspondence.csv, note: PSEUDONYMIZED_NOTE }
              : { correspondence_error: correspondence.error }),
          ...text,
          ...(hasDocumentText(text) ? { next_step: REMOTE_NEXT_STEP } : {}),
        });
      });
    }),
  );

  // ---- 2. Fire-and-forget upload. -----------------------------------------
  server.registerTool(
    'redact_pdf',
    {
      title: 'Start a redaction job (does not wait)',
      description: wording.redactAsync,
      inputSchema: { ...sourceShape, ...ruleShape },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    tool('redact_pdf', async (args: SourceArgs & RuleArgs) => {
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
    tool('get_job_status', async (args: { job_id: string }) => {
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
      description: wording.download,
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
    tool('download_redacted', async (args: { document_id: string; output_path?: string }) => {
      const bytes = await client.downloadOutput(args.document_id);

      if (mode === 'stdio') {
        const outputPath = args.output_path
          ? resolveOutputPath(args.output_path)
          : resolve(process.cwd(), `${args.document_id}-redacted.pdf`);
        await writeOutput(outputPath, bytes);
        const text = await documentText(
          client, args.document_id, { stdioPath: documentTextPath(outputPath) }, maxInlineTextBytes, true,
        );
        return jsonResult({
          status: 'downloaded',
          output_path: outputPath,
          bytes: bytes.byteLength,
          ...text,
          ...(hasDocumentText(text) ? { next_step: DOWNLOAD_NEXT_STEP } : {}),
        });
      }

      const text = await documentText(client, args.document_id, { baseUrl: client.baseUrl }, maxInlineTextBytes, true);
      return jsonResult({
        status: 'downloaded',
        bytes: bytes.byteLength,
        ...downloadPayload(client.baseUrl, args.document_id, bytes, maxInlineBytes),
        ...text,
        ...(hasDocumentText(text) ? { next_step: REMOTE_NEXT_STEP } : {}),
      });
    }),
  );

  // ---- 4b. Correspondence table of a pseudonymized document. ----------------
  // redact_pdf_and_wait fetches it itself; this is how the async flow
  // (redact_pdf -> get_job_status -> download_redacted) and a failed fetch get it.
  server.registerTool(
    'download_correspondence',
    {
      title: 'Download the tag -> original table of a pseudonymized document',
      description: wording.downloadCorrespondence,
      inputSchema: {
        document_id: z.string().min(1).describe(PARAM.documentId),
        ...(mode === 'stdio'
          ? { output_path: z.string().optional().describe(PARAM.correspondenceOutputPath) }
          : {}),
      },
      annotations:
        mode === 'stdio'
          ? { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
          : { readOnlyHint: true, openWorldHint: true },
    },
    tool('download_correspondence', async (args: { document_id: string; output_path?: string }) => {
      const csv = await client.downloadCorrespondence(args.document_id);
      if (mode === 'stdio') {
        const outputPath = args.output_path
          ? resolveOutputPath(args.output_path)
          : resolve(process.cwd(), `${args.document_id}-correspondence.csv`);
        // With a BOM, as the API serves it, so Excel opens accented names right.
        await writeOutput(outputPath, new TextEncoder().encode(`\uFEFF${csv}`));
        return jsonResult({ status: 'downloaded', output_path: outputPath, note: PSEUDONYMIZED_NOTE });
      }
      return jsonResult({ status: 'downloaded', correspondence_csv: csv, note: PSEUDONYMIZED_NOTE });
    }),
  );

  // ---- 5. Keyless demo. ----------------------------------------------------
  // Every source argument is optional here: with none, the built-in sample
  // runs. All four keys are declared on EVERY transport on purpose: the SDK
  // strips arguments the schema does not name before the handler runs, so a
  // key the transport does not support would otherwise vanish and the call
  // would silently fall back to the sample. Declared, it reaches resolveInput,
  // which refuses it with a message that says what to send instead.
  const demoSourceShape: z.ZodRawShape = {
    file_path: z.string().min(1).optional().describe(PARAM.filePath),
    file_url: z.string().url().optional().describe(PARAM.fileUrl),
    file_base64: z.string().optional().describe(PARAM.fileBase64),
    filename: z.string().optional().describe(PARAM.filename),
  };
  server.registerTool(
    'try_demo',
    {
      title: 'Try redaction with no API key (first page of a real file, or a sample)',
      description: TRY_DEMO,
      inputSchema: { ...demoSourceShape, ...piiRuleShape },
      // With a file it uploads user data and creates a server-side demo record.
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    tool('try_demo', async (args: SourceArgs & RuleArgs) => {
      const keyNote = client.hasApiKey
        ? 'An API key is configured — call redact_pdf_and_wait to redact the whole document.'
        : `No API key is configured. To redact whole documents, get a key at ${SIGN_UP_URL} and ${keySource ? 'call set_api_key with it' : 'set REDACT_PDF_API_KEY'}. ${FREE_FIRST_DOCUMENT_NOTE}`;

      if (!hasSource(args)) {
        const demo = await client.demo();
        return jsonResult({
          status: 'ok',
          mode: 'sample',
          message: demo.message,
          sample_input: demo.sample_input,
          detected_and_removed: demo.detected_pii,
          redacted_sample_pdf: `${client.baseUrl}${demo.redacted_pdf_path}`,
          api_key_configured: client.hasApiKey,
          next_step: `${keyNote} To show the user real output first, call try_demo again with their file: it redacts the first page with no key.`,
        });
      }

      const file = await resolveInput(mode, args, downloadFetch, resolveHost);
      if (file.bytes.byteLength > DEMO_MAX_BYTES) {
        throw new RedactPdfError(
          `"${file.filename}" is ${(file.bytes.byteLength / 1024 / 1024).toFixed(1)} MB; the keyless demo takes files up to ${DEMO_MAX_BYTES / 1024 / 1024} MB. Use redact_pdf_and_wait with an API key for this one.`,
          { code: 'invalid_request' },
        );
      }
      const demo = await client.demoRedact(file, rulesFrom(args));
      return jsonResult({
        status: 'ok',
        mode: 'first_page',
        message: demo.message,
        file_name: demo.file_name,
        total_pages: demo.total_pages,
        redacted_pages: demo.redacted_pages,
        detected_and_removed: demo.detected_pii,
        // `mode` above is which demo ran; this is how the page was redacted.
        redaction_mode: demo.mode ?? 'redact',
        ...(demo.tags ? { tags: demo.tags } : {}),
        redacted_first_page_pdf: demo.redacted_first_page_url,
        link_expires_in_days: demo.link_expires_in_days,
        api_key_configured: client.hasApiKey,
        next_step: `${keyNote} Only the first page was redacted here.`,
      });
    }),
  );

  // ---- 5b. Put the names back (local only). ---------------------------------
  // Never registered on the hosted server: it would need the table uploaded,
  // i.e. the names sent over the wire to a tool whose result the model reads.
  if (mode === 'stdio') {
    server.registerTool(
      'restore_names',
      {
        title: 'Put the real names back into a file written from a pseudonymized document',
        description: RESTORE_NAMES,
        inputSchema: {
          file_path: z.string().min(1).describe(PARAM.restoreFilePath),
          correspondence_path: z.string().min(1).describe(PARAM.restoreCorrespondencePath),
          output_path: z.string().optional().describe(PARAM.restoreOutputPath),
        },
        // Writes a new file, never over an existing one, and calls no network.
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      tool('restore_names', async (args: { file_path: string; correspondence_path: string; output_path?: string }) =>
        jsonResult(await restoreNames(args)),
      ),
    );
  }

  // ---- 6. Account / quota preflight. ---------------------------------------
  server.registerTool(
    'get_account_status',
    {
      title: 'Check API key and account',
      description: ACCOUNT_STATUS,
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    tool('get_account_status', async () => {
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

  // ---- 7. Save a key (local only). -----------------------------------------
  // For clients that can't pass REDACT_PDF_API_KEY, such as Cowork, which
  // drops a plugin MCP server that references userConfig. The key never
  // appears in a result.
  if (keySource) {
    const confirmSave = elicitConfirmSave(server);
    server.registerTool(
      'set_api_key',
      {
        title: 'Use the API key the user gave (saved on this machine once they confirm)',
        description: SET_API_KEY,
        inputSchema: { api_key: z.string().describe(PARAM.apiKey) },
        // Can replace the saved key (only with the user's confirmation), and
        // what a repeat does depends on the user's answer.
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      },
      tool('set_api_key', async (args: { api_key: string }) =>
        jsonResult(await saveApiKey(client, keySource, args.api_key, confirmSave)),
      ),
    );
  }

  return server;
}

/**
 * How set_api_key asks the user, outside the model, to approve a save.
 * "unsupported" when the client can't show a form (MCP elicitation).
 */
export type ConfirmSave = (
  request: { accountEmail: string; keyEnding: string; replacing: boolean },
) => Promise<'accepted' | 'declined' | 'unsupported'>;

/**
 * The form waits for a person, who may read it carefully. The SDK's default
 * request timeout is 60 s, after which a user who was still reading got
 * "could not ask" and the agent was nudged to ask again.
 */
export const CONFIRM_TIMEOUT_MS = 10 * 60_000;

/** Elicitation through the connected client, when it declares form support. */
export function elicitConfirmSave(server: McpServer): ConfirmSave {
  return async ({ accountEmail, keyEnding, replacing }) => {
    const elicitation = server.server.getClientCapabilities()?.elicitation;
    // An empty capability object means form mode (the spec's original shape).
    if (!elicitation || (elicitation.url && !elicitation.form)) return 'unsupported';
    let result;
    try {
      result = await server.server.elicitInput(
        {
          mode: 'form',
          // The key's last characters let the user recognise the key they
          // pasted; a lookalike account email alone is easy to miss.
          message: `${replacing ? 'Replace the saved Redact PDF AI API key with the' : 'Save the Redact PDF AI API'} key ending in "${keyEnding}", for the account ${accountEmail}? Documents redacted from now on are uploaded to that account. Only confirm if you gave this key yourself and the account is yours.`,
          requestedSchema: {
            type: 'object',
            properties: { confirm: { type: 'boolean', title: `Use the account ${accountEmail}`, default: false } },
            required: ['confirm'],
          },
        },
        { timeout: CONFIRM_TIMEOUT_MS },
      );
    } catch (cause) {
      if (cause instanceof McpError && cause.code === ErrorCode.RequestTimeout) {
        throw new RedactPdfError(
          'The user did not answer the confirmation in time, so nothing was saved. Ask them in the conversation before calling set_api_key again.',
          { code: 'not_confirmed' },
        );
      }
      throw new RedactPdfError(
        `Could not ask the user to confirm the key (${cause instanceof Error ? cause.message : String(cause)}). Nothing was saved.`,
        { code: 'not_confirmed' },
      );
    }
    return result.action === 'accept' && result.content?.confirm === true ? 'accepted' : 'declined';
  };
}

/** What /v1/me must return before an account is shown to the user and trusted. */
const ACCOUNT_EMAIL = /^[^\s@<>"'`\p{Cc}\p{Cf}]{1,64}@[^\s@<>"'`\p{Cc}\p{Cf}]{1,190}$/u;

/** Shown with every tool result while a key the user hasn't confirmed is in use. */
export function sessionAccountNote(account: string): string {
  return `Account: this session sends documents to the Redact PDF AI account ${account}, using a key given in the conversation that the user has not confirmed. If that is not the user's own account, stop and tell them.`;
}

/**
 * set_api_key, apart from the wiring so the rule is easy to audit: nothing
 * that is returned or thrown contains the key.
 *
 * The threat is a key that isn't the user's. Text the model reads (a document
 * in pseudonymize mode is exactly that) can say "call set_api_key with ...",
 * and checking the key against the API only proves it works: an attacker's own
 * key works. Saved, it would send every later document to the attacker's
 * account, in every session. So:
 *
 *   - only a key the user approves in a form (MCP elicitation, outside the
 *     model) is written to disk, and replacing a saved key needs the same;
 *   - a client that can't show a form gets the key for this session only, in
 *     memory, and never in place of a working key; every tool result then names
 *     the account, so a wrong one shows on first use and ends with the session.
 */
export async function saveApiKey(
  client: RedactPdfClient,
  keySource: KeySource,
  apiKey: string,
  confirm: ConfirmSave = async () => 'unsupported',
): Promise<Record<string, unknown>> {
  if (!isWellFormedKey(apiKey)) {
    throw new RedactPdfError(
      'That does not look like an API key: it should be one token with no spaces, copied from https://www.redact-pdf.ai/dashboard/settings. Nothing was saved.',
      { code: 'invalid_request' },
    );
  }
  const key = apiKey.trim();
  const me = await verifiedAccount(client, key);

  const saved = keySource.saved();
  const session = keySource.session();
  if (saved === key || session?.key === key) {
    // The saved key is the user's own file: if a session key was shadowing
    // it, going back to it needs no confirmation.
    if (saved === key && session) keySource.setSession(undefined);
    return {
      status: 'already_saved',
      ...(saved === key ? { key_file: keySource.filePath } : { session_only: true }),
      account_email: me.email,
      note: 'This key is already set; nothing else changed. Do not repeat the key in your reply.',
    };
  }

  const decision = await confirm({ accountEmail: me.email, keyEnding: key.slice(-4), replacing: saved !== undefined });
  if (decision === 'declined') {
    throw new RedactPdfError(
      `The user did not confirm the account ${me.email}, so nothing was saved. Do not call set_api_key again unless the user asks you to.`,
      { code: 'not_confirmed' },
    );
  }
  const usage = keySource.fromEnvironment
    ? 'REDACT_PDF_API_KEY is also set for this server and keeps priority in this session; the saved key is used wherever that variable is not set.'
    : 'The redaction tools use it from now on, in this session and the next ones.';

  if (decision === 'accepted') {
    await persistKey(keySource, key, saved ?? null);
    // A session key would otherwise keep priority over the one just confirmed.
    keySource.setSession(undefined);
    return {
      status: 'saved',
      key_file: keySource.filePath,
      account_email: me.email,
      confirmed_by_user: true,
      note: `The key is valid and saved. ${usage} Do not repeat the key in your reply.`,
    };
  }

  // No form: this session only, never over a working key.
  if (keySource.fromEnvironment) {
    throw new RedactPdfError(
      'REDACT_PDF_API_KEY is set for this server and keeps priority, and this client cannot ask the user to confirm saving another key, so nothing was saved. If that key is wrong, the user replaces it where it is set (the MCP client\'s configuration for this server) and restarts.',
      { code: 'not_confirmed' },
    );
  }
  if (session && (await stillWorks(client, session.key))) {
    throw new RedactPdfError(
      `A key for the account ${session.account} was already given in this session, and this client cannot ask the user to confirm replacing it, so it is left as is. Restart the session to start over.`,
      { code: 'not_confirmed' },
    );
  }
  if (saved !== undefined && (await stillWorks(client, saved))) {
    // A dead session key must not hide a saved key that works: drop it, so
    // the saved key is used again, rather than letting a new one in.
    if (session) keySource.setSession(undefined);
    throw new RedactPdfError(
      `A key is already saved in "${keySource.filePath}" and still works${session ? ' (it is used again from now on)' : ''}, and this client cannot ask the user to confirm replacing it, so it is left as is. If the user wants another key, they delete that file themselves, then you call set_api_key again.`,
      { code: 'not_confirmed' },
    );
  }
  // Re-read after the awaits: a concurrent call may have set a key meanwhile,
  // and this must not silently take its place.
  if (keySource.session()?.key !== session?.key) {
    throw new RedactPdfError('Another key was set in this session meanwhile, so this one was not used.', {
      code: 'not_confirmed',
    });
  }
  keySource.setSession({ key, account: me.email });
  return {
    status: 'saved_for_session',
    session_only: true,
    account_email: me.email,
    confirmed_by_user: false,
    note: `This client cannot ask the user to confirm the key, so it is used for this session only and not written to disk. Tell the user it belongs to the account ${me.email}, so they can check it is theirs; every tool result names that account until the session ends. Do not repeat the key in your reply.`,
  };
}

/** /v1/me for `key`, with an account that is safe to show; the key never in an error. */
async function verifiedAccount(client: RedactPdfClient, key: string): Promise<{ email: string }> {
  let me;
  try {
    me = await client.withApiKey(key).me();
  } catch (error) {
    if (error instanceof RedactPdfError && error.code === 'unauthorized') {
      throw new RedactPdfError(
        'The API rejected that key, so nothing was saved. Ask the user to copy it again from https://www.redact-pdf.ai/dashboard/settings, or to create a new one there.',
        { code: 'unauthorized', status: error.status, requestId: error.requestId, retryable: false },
      );
    }
    throw error;
  }
  // The email is shown to the user as the thing they approve; never "undefined".
  if (typeof me?.email !== 'string' || me.email.length > 254 || !ACCOUNT_EMAIL.test(me.email)) {
    throw new RedactPdfError(
      'The API accepted the key but did not return a usable account email, so nothing was saved. Try again later.',
      { code: 'internal_error' },
    );
  }
  return { email: me.email };
}

/** True unless the API says the key is no longer valid. Other failures are not a "no". */
async function stillWorks(client: RedactPdfClient, key: string): Promise<boolean> {
  try {
    await client.withApiKey(key).me();
    return true;
  } catch (error) {
    if (error instanceof RedactPdfError && error.code === 'unauthorized') return false;
    throw error;
  }
}

async function persistKey(keySource: KeySource, key: string, expect: string | null): Promise<void> {
  try {
    await writeKeyFile(keySource.filePath, key, expect);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException)?.code;
    if (code === 'ECHANGED') {
      throw new RedactPdfError(
        `The saved key in "${keySource.filePath}" changed while the user was confirming, so it was not replaced. Call get_account_status to see which key is in use, and ask the user before trying again.`,
        { code: 'not_confirmed' },
      );
    }
    throw new RedactPdfError(
      `The key is valid but could not be saved to "${keySource.filePath}"${code ? ` (${code})` : ''}. The folder "${dirname(keySource.filePath)}" must be a plain folder that belongs to the user: ask the user to fix it, or to set XDG_CONFIG_HOME to a folder of their own. Clients that support it can set REDACT_PDF_API_KEY instead.`,
      { code: 'local_write_failed' },
    );
  }
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

/**
 * restore_names, kept apart from the tool wiring so the privacy rule is easy
 * to audit: the result is built from paths and counts only. Original values
 * exist in `table` and in the bytes written to disk, nowhere else.
 */
export async function restoreNames(args: {
  file_path: string;
  correspondence_path: string;
  output_path?: string;
}): Promise<Record<string, unknown>> {
  const inputPath = resolveOutputPath(args.file_path);
  const tablePath = resolveOutputPath(args.correspondence_path);
  const ext = extname(inputPath).toLowerCase();
  if (!(RESTORABLE_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new RedactPdfError(
      `restore_names works on ${RESTORABLE_EXTENSIONS.join(', ')} files; "${basename(inputPath)}" is not one. Write the answer as Markdown or plain text and call it again.`,
      { code: 'invalid_request' },
    );
  }
  const outputPath = args.output_path ? resolveOutputPath(args.output_path) : restoredPath(inputPath);
  if (outputPath === inputPath || outputPath === tablePath) {
    throw new RedactPdfError('output_path must be a new file, not the input file or the correspondence table.', {
      code: 'invalid_request',
    });
  }

  const table = parseCorrespondenceCsv(await readLocal(tablePath, 'correspondence table'));
  if (table.length === 0) {
    throw new RedactPdfError('The correspondence table has no rows: there is nothing to restore.', { code: 'invalid_request' });
  }
  const input = new Uint8Array(await readLocalBytes(inputPath, 'file'));

  let restored: Uint8Array;
  let counts: RestoreCounts;
  if (ext === '.docx') {
    ({ bytes: restored, counts } = restoreDocx(input, table));
  } else {
    const result = restoreText(new TextDecoder().decode(input), table);
    restored = new TextEncoder().encode(result.text);
    counts = result.counts;
  }
  await writeOutput(outputPath, restored);

  return {
    status: 'restored',
    output_path: outputPath,
    replacements: counts.replacements,
    tags_restored: counts.tags_restored,
    ...(counts.unresolved_tags.length ? { unresolved_tags: counts.unresolved_tags } : {}),
    ...(counts.ambiguous_tags.length
      ? {
          ambiguous_tags: counts.ambiguous_tags,
          ambiguous_note:
            'These tags stand for more than one person in the table (the same rename was given to different entities in the Studio), so they were left as tags rather than guessed. Ask the user to fill them in, or to give each entity its own rename and download the table again.',
        }
      : {}),
    note:
      counts.replacements === 0
        ? 'No tag of the table was found in the file, so the output is an unchanged copy. Tags must be written exactly as in the pseudonymized text, brackets included, e.g. [Person 1].'
        : 'The restored file contains the real names. Give the user output_path; do NOT open, read or quote it, which would put the names into this conversation.',
  };
}

/** Errors name the path, never the content: the table is personal data. */
async function readLocalBytes(path: string, what: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException)?.code;
    throw new RedactPdfError(
      `Could not read the ${what} "${path}"${code ? ` (${code})` : ''}. Pass an absolute path to an existing file.`,
      { code: 'invalid_request' },
    );
  }
}

async function readLocal(path: string, what: string): Promise<string> {
  return new TextDecoder().decode(await readLocalBytes(path, what));
}
