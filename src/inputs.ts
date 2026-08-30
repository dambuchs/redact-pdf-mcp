/**
 * Getting bytes into the server.
 *
 * The two transports have genuinely different reach: a stdio server runs on the
 * user's machine and can open their files; a remote HTTP server cannot, and has
 * to be handed a URL or inline base64. Each mode therefore advertises only the
 * inputs it can actually honour — an agent that sees `file_path` on a remote
 * server would just fail on every call.
 */

import { readFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, resolve } from 'node:path';
import { RedactPdfError } from './errors.js';
import { safeFetchDocument } from './net.js';
import { MAX_IMAGE_BYTES, MAX_PDF_BYTES, type InputFile } from './types.js';

/** A URL fetch must not outlive an agent's patience, nor buffer more than a max-size PDF. */
export const URL_FETCH_TIMEOUT_MS = 30_000;

/** What the ingest pipeline accepts. Anything else is refused before upload. */
const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

export const SUPPORTED_CONTENT_TYPES = new Set(Object.values(CONTENT_TYPE_BY_EXTENSION));

const UNSUPPORTED_HINT =
  'Redact PDF AI takes PDF, JPEG and PNG. Convert other formats (DOCX, TIFF, HEIC) to PDF first.';

export function contentTypeForFilename(filename: string): string {
  const type = CONTENT_TYPE_BY_EXTENSION[extname(filename).toLowerCase()];
  if (!type) {
    throw new RedactPdfError(
      `Unsupported file type for "${basename(filename)}". ${UNSUPPORTED_HINT}`,
      { code: 'invalid_request' },
    );
  }
  return type;
}

/**
 * The single per-file size/emptiness check.
 *
 * Exported and shared with the client's batch validation: two independent
 * implementations of "is this file acceptable" drift, and had already produced
 * different wording for the identical condition depending on which path a
 * caller took.
 */
export function assertFileWithinLimits(file: InputFile): InputFile {
  if (file.bytes.byteLength === 0) {
    throw new RedactPdfError(`"${file.filename}" is empty.`, { code: 'invalid_request' });
  }
  const isPdf = file.contentType === 'application/pdf';
  const limit = isPdf ? MAX_PDF_BYTES : MAX_IMAGE_BYTES;
  if (file.bytes.byteLength > limit) {
    throw new RedactPdfError(
      `"${file.filename}" is ${(file.bytes.byteLength / 1024 / 1024).toFixed(1)} MB, over the ${limit / 1024 / 1024} MB limit for ${isPdf ? 'PDFs' : 'images'}. Split the document and redact it in parts.`,
      { code: 'payload_too_large' },
    );
  }
  return file;
}

/** @deprecated internal alias kept for readability at the call sites below. */
const assertSize = assertFileWithinLimits;

/** stdio only: read a file off the local disk. */
export async function fileFromPath(path: string): Promise<InputFile> {
  const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(absolute));
  } catch (cause) {
    const reason = (cause as NodeJS.ErrnoException)?.code === 'ENOENT'
      ? 'no such file'
      : cause instanceof Error
        ? cause.message
        : String(cause);
    throw new RedactPdfError(
      `Cannot read "${path}" (${reason}). Pass an absolute path to a PDF on this machine.`,
      { code: 'invalid_request' },
    );
  }
  return assertSize({
    filename: basename(absolute),
    contentType: contentTypeForFilename(absolute),
    bytes,
  });
}

/**
 * Remote only: inline bytes, for agents that already hold the document.
 *
 * Node's base64 decoder never throws — it silently drops characters it does not
 * recognise — so invalid input has to be detected before decoding. Without this
 * a truncated or URL-safe-encoded payload decodes to garbage and gets reported
 * as "empty" or "not a PDF", and the agent retries the same broken bytes.
 */
export function fileFromBase64(filename: string, base64: string): InputFile {
  const compact = base64.replace(/\s+/g, '');
  if (compact.length === 0) {
    throw new RedactPdfError(`"${filename}" carried no data.`, { code: 'invalid_request' });
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    throw new RedactPdfError(
      `"${filename}" was not valid base64. Send standard base64 (not URL-safe base64url), unpadded characters removed, and make sure the payload was not truncated.`,
      { code: 'invalid_request' },
    );
  }
  const bytes = new Uint8Array(Buffer.from(compact, 'base64'));
  return assertSize({ filename, contentType: contentTypeForFilename(filename), bytes });
}

/**
 * Remote only: fetch a document the agent points at.
 *
 * Delegates to safeFetchDocument, which enforces the http(s) scheme, refuses
 * hosts that resolve to non-public addresses (re-checked on every redirect
 * hop), and bounds both the time and the bytes. See net.ts for why each of
 * those is load-bearing on a hosted server.
 */
export async function fileFromUrl(
  url: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  /** Injectable so tests can exercise this path without a real DNS lookup. */
  resolveHost?: (hostname: string) => Promise<string[]>,
): Promise<InputFile> {
  const { bytes, response, finalUrl } = await safeFetchDocument(url, {
    // A PDF is the largest thing worth accepting; anything bigger is refused
    // mid-stream rather than buffered and then rejected.
    maxBytes: MAX_PDF_BYTES,
    timeoutMs: URL_FETCH_TIMEOUT_MS,
    fetchImpl,
    ...(resolveHost ? { resolveHost } : {}),
  });

  const filename = filenameFromUrl(finalUrl, response);
  // Trust the served Content-Type when it is one we support; a URL like
  // /download?id=42 carries no usable extension.
  const served = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
  const contentType = SUPPORTED_CONTENT_TYPES.has(served)
    ? served
    : contentTypeForFilename(filename);

  return assertSize({ filename, contentType, bytes });
}

function filenameFromUrl(parsed: URL, response: Response): string {
  const disposition = response.headers.get('content-disposition') ?? '';
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  if (match?.[1]) {
    // The header comes from whatever host the caller pointed us at, so a
    // malformed escape ("%zz") is attacker-controlled input, not a bug.
    // decodeURIComponent throws a bare URIError on those, which would escape
    // the tool's error taxonomy entirely — fall back to the raw value.
    let decoded = match[1];
    try {
      decoded = decodeURIComponent(match[1]);
    } catch {
      /* keep the undecoded name */
    }
    return basename(decoded);
  }

  const fromPath = basename(parsed.pathname);
  if (fromPath && extname(fromPath)) return fromPath;
  return 'document.pdf';
}
