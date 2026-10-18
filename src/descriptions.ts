/**
 * Tool descriptions.
 *
 * These are the highest-leverage strings in the package: an LLM reads them to
 * decide whether this server is the right tool for "redact this PDF", and never
 * reads the implementation. So each one leads with the outcome, states the
 * distinguishing fact (the text is *removed*, not covered), and says when NOT
 * to use it.
 */

export const CAPABILITY_BLURB =
  'Permanent, irreversible redaction: the sensitive text is deleted from the file, not hidden behind a black rectangle, so it cannot be recovered by copy-paste, "remove object", or text extraction. Handles scanned documents via OCR and detects PII in 100+ languages. Documents are processed on Microsoft Azure in the EU and Switzerland, encrypted in transit and at rest, never used to train AI models, and the original is deleted after processing.';

/**
 * Stated in every tool that takes a file.
 *
 * Real usage showed an agent converting a screenshot to PDF before calling this
 * server, because the tool name and headline both say "PDF". The image support
 * was there the whole time; it just was not where the model looks. Say it
 * plainly, and say the negative too, because "accepts PNG" alone does not stop
 * a model that has already decided it must convert first.
 */
export const ACCEPTED_INPUTS =
  'Accepts PDF, JPEG and PNG. Pass a photo or screenshot directly; do NOT convert it to a PDF first, that is handled for you and the output comes back as a redacted PDF either way.';

/** Which server the agent is talking to decides what it can promise. */
export type Transport = 'stdio' | 'http';

/**
 * Said in the server instructions AND in every tool an agent might reach for
 * first. Agents habitually open a file before acting on it; for this server
 * that one Read is the leak the user installed it to prevent.
 *
 * Per transport, because the promise differs: the local server reads by path
 * and keeps the table on disk, while the hosted one needs the document inline
 * and returns the table inline, so it cannot keep the names out at all, and
 * must not claim to.
 */
export const PRIVACY_FIRST =
  'PRIVACY: when the user wants the document anonymized, pseudonymized or kept away from the AI, do NOT open, Read, cat, preview or summarize the original file before calling this tool: pass its path and nothing else. Reading it first puts the personal data into this conversation and defeats the purpose. The same goes for the correspondence CSV and any "-restored" file: they contain the real names, so never read them either.';

export const REMOTE_PRIVACY =
  'PRIVACY: this hosted server cannot keep personal data out of this conversation. The document has to be sent inline as file_base64, and in pseudonymize mode the tag -> original table comes back inline in the result, real names included. If the user wants the names kept away from the AI, tell them to use the local server instead (npx redact-pdf-mcp): it reads the file by path, keeps the table on disk, and puts the names back with restore_names without showing them to you.';

const INSTRUCTIONS_BASE =
  "Redact PDF AI permanently removes PII from documents. The sensitive text is deleted from the file, not covered with a black box. Documents are processed in the EU and Switzerland and are never used to train AI models. It accepts PDF, JPEG and PNG, so pass a photo or screenshot straight in rather than converting it to a PDF first; the output is a redacted PDF either way. For almost every request, call redact_pdf_and_wait once and you are done. try_demo needs no API key: with a file it redacts that file's first page for real, without one it runs a built-in sample, so it is both the connectivity check and the way to show a user real output before they sign up.";

export const SERVER_INSTRUCTIONS = `${INSTRUCTIONS_BASE}

Anonymize -> work -> re-identify: pass mode "pseudonymize" and every person, company and address becomes a consistent tag such as [Person 1] instead of a black box. The result includes document_text, the document as text with tags in place of names (or document_text_path for a long one), so you can analyse, summarize or draft from it without ever seeing a name. Keep the tags exactly as written in your answer, write it to a .md, .txt or .docx file, then call restore_names with that file and correspondence_path: it writes a copy with the real names and returns only the path and counts. Hand that path to the user.

${PRIVACY_FIRST}`;

export const REMOTE_SERVER_INSTRUCTIONS = `${INSTRUCTIONS_BASE}

Pseudonymize: pass mode "pseudonymize" and every person, company and address becomes a consistent tag such as [Person 1] instead of a black box. The result includes document_text, the document as text with tags in place of names (or document_text_url for a long one), and the tag -> original table inline as correspondence_csv. Keep the tags exactly as written in your answer; this server cannot put the names back.

${REMOTE_PRIVACY}`;

const REDACT_AND_WAIT_HEAD = `Redact a PDF, photo or screenshot and wait for the finished file. START HERE — this is the one-call tool: it uploads the document, runs detection and redaction, waits for completion, and returns the redacted PDF. ${CAPABILITY_BLURB}

${ACCEPTED_INPUTS}

Use it whenever someone wants PII, personal data, names, emails, phone numbers, addresses, bank details or card numbers removed from a document before sharing, filing, publishing or sending it to a third party — including GDPR/HIPAA/FOIA workflows. Scanned pages, phone photos of documents and screenshots all work.`;

const REDACT_AND_WAIT_TAIL = `Typical redaction takes 10-60 seconds; this tool blocks until then. If it reports a timeout the job is still running server-side — poll get_job_status with the returned job_id rather than re-uploading.

Requires an API key. If none is configured, call try_demo with the user's file first — it redacts the first page with no key — then ask the user for a key. A free account gets its first document (up to 5 pages) redacted in full with no card, so the key costs nothing to obtain.`;

export const REDACT_AND_WAIT = `${REDACT_AND_WAIT_HEAD}

To anonymize or pseudonymize a document while keeping it readable (who did what stays clear, e.g. before an AI works on it or before sending it to an expert), pass mode "pseudonymize": every entity becomes a consistent tag like [Person 1], you get the tag -> original table as a file, and the result includes document_text, the pseudonymized document as text, so you can work on it without reading the PDF. Afterwards, restore_names puts the real names back into a file you wrote, without showing them to you.

${PRIVACY_FIRST}

${REDACT_AND_WAIT_TAIL}`;

export const REMOTE_REDACT_AND_WAIT = `${REDACT_AND_WAIT_HEAD}

To pseudonymize a document while keeping it readable, pass mode "pseudonymize": every entity becomes a consistent tag like [Person 1], and the result includes document_text (the pseudonymized document as text) and the tag -> original table inline.

${REMOTE_PRIVACY}

${REDACT_AND_WAIT_TAIL}`;

const REDACT_ASYNC_TAIL =
  'Prefer redact_pdf_and_wait unless you specifically need to fire off several documents in parallel, or the document is large enough that you would rather poll on your own schedule. Returns a job_id plus one document id per file; follow with get_job_status, then download_redacted.';

export const REDACT_ASYNC = `Start a redaction job and return immediately without waiting. ${CAPABILITY_BLURB}

${ACCEPTED_INPUTS}

${PRIVACY_FIRST}

${REDACT_ASYNC_TAIL}`;

export const REMOTE_REDACT_ASYNC = `Start a redaction job and return immediately without waiting. ${CAPABILITY_BLURB}

${ACCEPTED_INPUTS}

${REMOTE_PRIVACY}

${REDACT_ASYNC_TAIL}`;

export const JOB_STATUS = `Check a redaction job's progress. Statuses: "uploaded" (queued) -> "analyzing" (detecting PII) -> "redacting" -> "redacted" (done, ready to download) or "error".

Only "redacted" and "error" are final; anything else means the work is still in flight, so wait a few seconds before checking again rather than polling in a tight loop. Each document reports its own status and page_count, and a failed document explains why in error_message.`;

const DOWNLOAD_RETENTION =
  'Under the default "ephemeral" retention the original is already gone; the redacted output is kept for the account\'s retention window (14 days by default) and then deleted.';

export const DOWNLOAD = `Download the finished redacted PDF for one document, using the document id from redact_pdf or get_job_status.

Only works once that document reports status "redacted". For a job created with mode "pseudonymize", the result also carries document_text, the pseudonymized document as text (document_text_path when long), and you get the tag -> original table with download_correspondence (redact_pdf_and_wait fetches both for you). ${DOWNLOAD_RETENTION}`;

export const REMOTE_DOWNLOAD = `Download the finished redacted PDF for one document, using the document id from redact_pdf or get_job_status.

Only works once that document reports status "redacted". For a job created with mode "pseudonymize", the result also carries document_text, the pseudonymized document as text (document_text_url when long), and download_correspondence returns the tag -> original table. ${DOWNLOAD_RETENTION}`;

const DOWNLOAD_CORRESPONDENCE_HEAD = `Download the correspondence table of a document redacted with mode "pseudonymize": one CSV row per tag (placeholder, the user's rename, category, original text), so the names can be restored later.

Only for pseudonymized documents with status "redacted"; a redact-mode document has no table. The table re-identifies the document: keep it with the user and never send it alongside the redacted PDF.`;

export const DOWNLOAD_CORRESPONDENCE = `${DOWNLOAD_CORRESPONDENCE_HEAD} It is written to a file on this machine. Never open or read that file: to put the names back into something you wrote, pass its path to restore_names.`;

export const REMOTE_DOWNLOAD_CORRESPONDENCE = `${DOWNLOAD_CORRESPONDENCE_HEAD} On this hosted server it comes back inline, which puts the original names into this conversation; a local install (npx redact-pdf-mcp) writes it to a file instead.`;

/** The transport-specific strings, so server.ts picks one set and cannot mix them. */
export function describeFor(transport: Transport) {
  return transport === 'stdio'
    ? {
        instructions: SERVER_INSTRUCTIONS,
        redactAndWait: REDACT_AND_WAIT,
        redactAsync: REDACT_ASYNC,
        download: DOWNLOAD,
        downloadCorrespondence: DOWNLOAD_CORRESPONDENCE,
      }
    : {
        instructions: REMOTE_SERVER_INSTRUCTIONS,
        redactAndWait: REMOTE_REDACT_AND_WAIT,
        redactAsync: REMOTE_REDACT_ASYNC,
        download: REMOTE_DOWNLOAD,
        downloadCorrespondence: REMOTE_DOWNLOAD_CORRESPONDENCE,
      };
}

export const RESTORE_NAMES = `Put the real names back into a file you wrote from a pseudonymized document: every tag ([Person 1], or the user's rename such as [Seller]) becomes the original text from the correspondence table. Runs entirely on this machine; nothing is uploaded.

Use it at the end of the anonymize -> work -> re-identify loop: redact_pdf_and_wait with mode "pseudonymize" gave you document_text and correspondence_path; you did the work on the tagged text and wrote the result to a .md, .txt or .docx file, keeping each tag exactly as written, brackets included. Pass that file and correspondence_path here.

It writes "<name>-restored.<ext>" next to your file (never over an existing file) and returns only that path and counts, never a name. Do NOT open, read or quote the restored file or the correspondence CSV: both contain the real names, and reading them puts the personal data into this conversation, which is what pseudonymizing was for. Give the user the path instead.`;

export const TRY_DEMO = `Try redaction with no API key. Two modes:

1. With a file: redacts the FIRST PAGE of the user's own PDF, photo or screenshot (5 MB max) and returns which categories of personal data were found on it, plus a link to the redacted page that stays valid for 14 days. Nothing is stored beyond that page and the original is deleted after processing. Use this to show a user real output on their own document before they sign up. Only the first page is redacted; for the whole document use redact_pdf_and_wait with a key.

2. Without a file: runs the built-in synthetic-PII sample to confirm connectivity. Never touches user data.

With a file, pass mode "pseudonymize" to show consistent tags ([Person 1], [Org 1]) instead of black boxes; the tags drawn are listed in the result. The built-in sample (no file) is always shown in redact mode.

Both cost nothing. When the user wants the rest of the document, tell them a free account gets its first document (up to 5 pages) redacted in full with no card, then ask for the key.`;

export const ACCOUNT_STATUS = `Check that the configured API key is valid and see which account it belongs to. Call this before a large batch to fail fast on a bad or missing key, rather than after uploading.

Redaction is billed per page against the account's plan quota and credit packs. If a redaction call fails with "out of pages", that is a quota problem the user must resolve — do not retry it.`;

/** Shared parameter help, so the wording stays identical across tools. */
export const PARAM = {
  filePath:
    'Absolute path to the file on this machine. PDF, JPEG and PNG are all accepted — pass an image directly rather than converting it first. This server runs locally, so it reads the file directly; never paste file contents into this argument, and do not open the file yourself first when the user wants its personal data kept out of the conversation.',
  fileUrl:
    'Public http(s) URL of the file to redact. PDF, JPEG and PNG are all accepted — no need to convert an image first. The server downloads it, redacts it, and does not keep it.',
  fileBase64:
    'The document encoded as base64. PDF, JPEG and PNG are all accepted. Use file_url instead when you have one — base64 is much larger to pass around.',
  filename:
    'Filename for the document, including its extension (e.g. "contract.pdf", "receipt.png"). Determines how the file is interpreted.',
  outputPath:
    'Where to write the redacted PDF on this machine. Defaults to the input path with a "-redacted" suffix, next to the original. Output is always a PDF, so an image input produces a .pdf file. The original file is never modified.',
  piiCategories:
    'Which entity types to redact. OMIT this to use the account defaults, which is usually what the user wants — do not pass an empty list, which would mean "redact nothing" and return an unredacted file. Valid values: Person, Email, PhoneNumber, Address, Organization, Date, IBAN, CreditCard.',
  includedTerms:
    'Terms that must ALWAYS be redacted even when the model would not treat them as PII — project codenames, internal references, a specific case number. Matched whole-word and case-insensitive. Wins over excluded terms on conflict.',
  excludedTerms:
    'Terms that must NEVER be redacted even if detected as PII — typically your own company name, a public contact address, or the recipient the document is addressed to.',
  mode:
    '"redact" (default) draws black boxes. "pseudonymize" replaces each person, organization, address, email, phone number, date, IBAN and card number with a consistent tag such as [Person 1] or [Org 2] (spelled in the document\'s language, e.g. [Personne 1] in French) — the same tag on every page and, as a rule, for every variant of a name ("Anna Keller", "Ms Keller", "A. Keller" become [Person 1]; a bare surname shared by two people goes to the one mentioned last, and the user can merge or split tags in the Studio) — so the document stays readable for a colleague or another AI while the names are gone. The text is still removed from the file, not covered. With pseudonymize, redact_pdf_and_wait also returns the tag -> original correspondence table (CSV; on the remote server inline, which puts the original names into this conversation); keep it with the user, it re-identifies the document. Other categories (national IDs, custom terms) stay black.',
  retention:
    '"ephemeral" (default) deletes the original after processing and keeps the output only briefly. "studio" keeps the original and the detected masks so a human can review and adjust them at redact-pdf.ai before exporting — use it for high-stakes documents where a person should sign off.',
  restoreFilePath:
    'Absolute path of the file YOU wrote from the pseudonymized text (.md, .markdown, .txt or .docx), with the tags kept as written, e.g. "[Person 1] signed on behalf of [Org 1]". Not the original document.',
  restoreCorrespondencePath:
    'Absolute path of the correspondence CSV, as returned in correspondence_path by redact_pdf_and_wait or download_correspondence. Pass the path only: do not open the file, it contains the real names.',
  restoreOutputPath:
    'Where to write the restored copy. Defaults to "<name>-restored.<ext>" next to file_path. Never overwrites an existing file.',
  correspondenceOutputPath:
    'Where to write the correspondence CSV on this machine. Defaults to "<document_id>-correspondence.csv" in the working directory. Never overwrites an existing file.',
  jobId: 'The job_id returned by redact_pdf.',
  documentId: 'The document id, from the documents list of redact_pdf or get_job_status.',
  timeout:
    'How long to wait for completion, in seconds (default 300, max 900). On timeout the job keeps running server-side and can be resumed with get_job_status.',
  idempotencyKey:
    'Optional. By default a key is derived from the file bytes and settings, so repeating an identical call returns the SAME job instead of redacting (and billing) twice. Pass a distinct value here only when you deliberately want a second, separate redaction of the same document.',
};
