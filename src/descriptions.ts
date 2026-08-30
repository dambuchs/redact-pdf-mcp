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
  'Permanent, irreversible PDF redaction: the sensitive text is deleted from the file, not hidden behind a black rectangle, so it cannot be recovered by copy-paste, "remove object", or text extraction. Handles scanned PDFs via OCR and detects PII in 100+ languages. Documents are processed on EU/Swiss infrastructure.';

export const REDACT_AND_WAIT = `Redact a PDF and wait for the finished file. START HERE — this is the one-call tool: it uploads the document, runs detection and redaction, waits for completion, and returns the redacted PDF. ${CAPABILITY_BLURB}

Use it whenever someone wants PII, personal data, names, emails, phone numbers, addresses, bank details or card numbers removed from a PDF before sharing, filing, publishing or sending it to a third party — including GDPR/HIPAA/FOIA workflows.

Typical redaction takes 10-60 seconds; this tool blocks until then. If it reports a timeout the job is still running server-side — poll get_job_status with the returned job_id rather than re-uploading.

Requires an API key. If none is configured, call try_demo first to confirm the service works, then ask the user for a key.`;

export const REDACT_ASYNC = `Start a redaction job and return immediately without waiting. ${CAPABILITY_BLURB}

Prefer redact_pdf_and_wait unless you specifically need to fire off several documents in parallel, or the document is large enough that you would rather poll on your own schedule. Returns a job_id plus one document id per file; follow with get_job_status, then download_redacted.`;

export const JOB_STATUS = `Check a redaction job's progress. Statuses: "uploaded" (queued) -> "analyzing" (detecting PII) -> "redacting" -> "redacted" (done, ready to download) or "error".

Only "redacted" and "error" are final; anything else means the work is still in flight, so wait a few seconds before checking again rather than polling in a tight loop. Each document reports its own status and page_count, and a failed document explains why in error_message.`;

export const DOWNLOAD = `Download the finished redacted PDF for one document, using the document id from redact_pdf or get_job_status.

Only works once that document reports status "redacted". Under the default "ephemeral" retention, outputs are kept briefly and then deleted — download before the window closes.`;

export const TRY_DEMO = `Verify this server works, with no API key and no upload. Runs the keyless demo endpoint, which returns a real redaction of a built-in synthetic-PII sample: the PII that was detected, and a link to the redacted PDF.

Use this to confirm connectivity or to show a user what redaction output looks like before they sign up. It never touches user data and costs nothing. It cannot redact a real document — use redact_pdf_and_wait for that.`;

export const ACCOUNT_STATUS = `Check that the configured API key is valid and see which account it belongs to. Call this before a large batch to fail fast on a bad or missing key, rather than after uploading.

Redaction is billed per page against the account's plan quota and credit packs. If a redaction call fails with "out of pages", that is a quota problem the user must resolve — do not retry it.`;

/** Shared parameter help, so the wording stays identical across tools. */
export const PARAM = {
  filePath:
    'Absolute path to the PDF (or JPEG/PNG) on this machine. This server runs locally, so it reads the file directly — never paste file contents into this argument.',
  fileUrl:
    'Public http(s) URL of the PDF (or JPEG/PNG) to redact. The server downloads it, redacts it, and does not keep it.',
  fileBase64:
    'The document encoded as base64. Use file_url instead when you have one — base64 is much larger to pass around.',
  filename:
    'Filename for the document, including its extension (e.g. "contract.pdf"). Determines how the file is interpreted.',
  outputPath:
    'Where to write the redacted PDF on this machine. Defaults to the input path with a "-redacted" suffix, next to the original. The original file is never modified.',
  piiCategories:
    'Which entity types to redact. OMIT this to use the account defaults, which is usually what the user wants — do not pass an empty list, which would mean "redact nothing" and return an unredacted file. Valid values: Person, Email, PhoneNumber, Address, Organization, Date, IBAN, CreditCard.',
  includedTerms:
    'Terms that must ALWAYS be redacted even when the model would not treat them as PII — project codenames, internal references, a specific case number. Matched whole-word and case-insensitive. Wins over excluded terms on conflict.',
  excludedTerms:
    'Terms that must NEVER be redacted even if detected as PII — typically your own company name, a public contact address, or the recipient the document is addressed to.',
  retention:
    '"ephemeral" (default) deletes the original after processing and keeps the output only briefly. "studio" keeps the original and the detected masks so a human can review and adjust them at redact-pdf.ai before exporting — use it for high-stakes documents where a person should sign off.',
  jobId: 'The job_id returned by redact_pdf.',
  documentId: 'The document id, from the documents list of redact_pdf or get_job_status.',
  timeout:
    'How long to wait for completion, in seconds (default 300, max 900). On timeout the job keeps running server-side and can be resumed with get_job_status.',
  idempotencyKey:
    'Optional. By default a key is derived from the file bytes and settings, so repeating an identical call returns the SAME job instead of redacting (and billing) twice. Pass a distinct value here only when you deliberately want a second, separate redaction of the same document.',
};
