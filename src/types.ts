/** Wire types for the Redact PDF AI `/v1` API (mirrors apps/web/public/openapi.yaml). */

/** The eight entity classes the analysis pipeline understands. */
export const PII_CATEGORIES = [
  'Person',
  'Email',
  'PhoneNumber',
  'Address',
  'Organization',
  'Date',
  'IBAN',
  'CreditCard',
] as const;

export type PiiCategory = (typeof PII_CATEGORIES)[number];

export type RetentionMode = 'ephemeral' | 'studio';

/** `redacted` and `error` are terminal; everything else means "still working". */
export type DocumentStatus = 'uploading' | 'uploaded' | 'analyzing' | 'redacting' | 'redacted' | 'error';

export interface JobDocument {
  id: string;
  file_name: string | null;
  status: DocumentStatus;
  page_count: number;
  error_message: string | null;
}

export interface Job {
  job_id: string;
  status: DocumentStatus;
  retention: RetentionMode;
  created_at: string;
  documents: JobDocument[];
}

export interface Me {
  user_id: string;
  email: string;
}

export interface UploadSlot {
  document_id: string;
  filename: string | null;
  upload_url: string;
}

export interface JobUploadInit {
  job_id: string;
  uploads: UploadSlot[];
}

export interface DemoResult {
  status: string;
  message: string;
  sample_input: string;
  detected_pii: Array<{ category: string; example: string; masked: boolean }>;
  redacted_pdf_path: string;
  redaction_rules?: string;
  next_steps?: Record<string, string>;
}

/** Redaction rules applied to one job. Omitted fields fall back to account defaults. */
export interface RedactionRules {
  pii_categories?: string[];
  pii_included_terms?: string[];
  pii_excluded_terms?: string[];
  retention?: RetentionMode;
}

/** One file to redact, already in memory. */
export interface InputFile {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

/** Server-side limits, mirrored from packages/pii_core/config.py. */
export const MAX_PDF_BYTES = 50 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_PER_JOB = 100;

export const TERMINAL_STATUSES: ReadonlySet<DocumentStatus> = new Set<DocumentStatus>([
  'redacted',
  'error',
]);
