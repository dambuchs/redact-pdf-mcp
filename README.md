# Redact PDF MCP server

**An MCP server that permanently redacts PII from PDFs.** Give an agent a PDF, get back a
PDF with the sensitive text *removed from the file* — not covered with a black rectangle
that anyone can select, copy, or delete.

Most "redaction" MCP servers scrub PII out of prompt text. This one takes a real document
and returns a real redacted document.

[![npm](https://img.shields.io/npm/v/redact-pdf-mcp?color=cb3837&logo=npm)](https://www.npmjs.com/package/redact-pdf-mcp)
[![npm downloads](https://img.shields.io/npm/dm/redact-pdf-mcp?color=cb3837)](https://www.npmjs.com/package/redact-pdf-mcp)
[![No AI training](https://img.shields.io/badge/your%20documents-never%20used%20for%20AI%20training-2ea44f)](https://www.redact-pdf.ai/security)
[![EU & Swiss hosted](https://img.shields.io/badge/processed%20in-EU%20%26%20Switzerland-003399)](https://www.redact-pdf.ai/security)
[![MCP registry](https://img.shields.io/badge/MCP%20registry-io.github.dambuchs%2Fredact--pdf--mcp-blue)](https://registry.modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

<a href="https://glama.ai/mcp/servers/dambuchs/redact-pdf-mcp"><img width="380" height="200" src="https://glama.ai/mcp/servers/dambuchs/redact-pdf-mcp/badges/card.svg" alt="redact-pdf-mcp MCP server" /></a>

```bash
claude mcp add redact-pdf -- npx -y redact-pdf-mcp
```

Then ask: *"Redact the personal data in ~/Documents/contract.pdf"*.

---

## Your data

You are sending the document the agent is meant to protect, so this comes first.

- **Never used to train AI models** — not ours, not Microsoft's, not anyone's. The Azure
  AI services used for OCR and PII detection run with content logging disabled, so
  document content is not retained or used for model improvement.
- **Processed in the EU and Switzerland** on Microsoft Azure.
- **Encrypted** with TLS 1.2+ in transit and AES-256 at rest.
- **The original is deleted after processing** under the default `ephemeral` retention.
  The redacted output is kept for your account's retention window (14 days by default,
  configurable) and can be purged at any time with `DELETE /v1/jobs/{job_id}`.
- **Certified infrastructure.** Azure holds SOC 2 Type II, ISO 27001, ISO 27017 and
  ISO 27018 certifications and is HIPAA-eligible under Microsoft's BAA. Redact PDF AI
  itself is not independently audited for these frameworks; it is built so legal, medical
  and finance teams can use it inside their own compliance posture.
- **The MCP server sends no telemetry of its own** — see
  [what the server does locally](#what-the-server-does-locally).

Details: [redact-pdf.ai/security](https://www.redact-pdf.ai/security) ·
[privacy policy](https://www.redact-pdf.ai/privacy)

## Why not let the agent redact it itself?

An agent can find names in text. It cannot make a PDF safe on its own:

- **A black box is not a redaction.** Drawing a rectangle over text leaves the text layer
  underneath; anyone can select, copy or extract it. This server rasterizes each page and
  drops the text layer and metadata, so there is nothing left to recover.
- **Scans have no text to search.** Contracts, IDs and statements are often images. OCR
  runs first, in 100+ languages, then PII detection runs over what it read.
- **Detection is a model, not a regex.** Names, addresses and organizations do not follow a
  pattern. The detector is purpose-built for PII, and your always-redact and never-redact
  lists cover the rest.

## Examples

Prompts that work as-is once the server is installed:

- *"Redact the personal data in ~/Documents/lease.pdf before I send it to the agency."*
- *"Redact names, emails and IBANs in every PDF in ~/Downloads/statements, keep our company
  name visible."* — the agent passes `pii_excluded_terms` for the company name and fans
  out with `redact_pdf`.
- *"Here is a screenshot of a customer ticket. Remove the phone number and address, then
  give me a PDF I can attach."* — images go in directly, no conversion.
- *"Try the redact-pdf demo on ~/Documents/contract.pdf so I can see what it does."* —
  keyless, first page only.

## Try it with no API key

The server ships a keyless tool, `try_demo`. Give it a file and it redacts the first
page for real — no key, no account — and tells the agent what it found:

> **You:** Use the redact-pdf server's try_demo tool on ~/Documents/contract.pdf.
>
> **Claude:** Redacted the first page of contract.pdf (4 pages). Personal data removed
> on that page: Person, Email. Here is the redacted page (link valid 14 days). To redact
> all 4 pages, a free account gets the first document (up to 5 pages) done in full, no card.

Call it with no file and it runs a built-in synthetic sample instead, which is the
zero-configuration connectivity check. Same thing from a terminal, no install:

```bash
curl https://www.redact-pdf.ai/v1/demo
curl -F file=@contract.pdf https://www.redact-pdf.ai/v1/demo/redact
```

## What it does

- **Permanent, irreversible redaction.** The underlying text is deleted, not masked. It
  cannot be recovered by copy-paste, text extraction, or "remove object" in a PDF editor.
- **PDFs and images.** Pass a PDF, JPEG or PNG. Photos and screenshots do not need converting
  first; the output is a redacted PDF either way.
- **Scanned documents.** OCR handles image-only PDFs and photos of documents.
- **100+ languages** for entity detection.
- **Eight entity types**: Person, Email, PhoneNumber, Address, Organization, Date, IBAN,
  CreditCard — plus your own always-redact and never-redact term lists.
- **EU/Swiss processing**, never used for AI training — see [Your data](#your-data).
- **Human review when it matters.** `retention: "studio"` keeps the detected masks so a
  person can check and adjust them before export.

## Install

### Claude Code

```bash
claude mcp add redact-pdf --env REDACT_PDF_API_KEY=your_key -- npx -y redact-pdf-mcp
```

### Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "redact-pdf": {
      "command": "npx",
      "args": ["-y", "redact-pdf-mcp"],
      "env": { "REDACT_PDF_API_KEY": "your_key" }
    }
  }
}
```

### Cursor

`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "redact-pdf": {
      "command": "npx",
      "args": ["-y", "redact-pdf-mcp"],
      "env": { "REDACT_PDF_API_KEY": "your_key" }
    }
  }
}
```

### VS Code

```bash
code --add-mcp '{"name":"redact-pdf","command":"npx","args":["-y","redact-pdf-mcp"],"env":{"REDACT_PDF_API_KEY":"your_key"}}'
```

Get an API key at [redact-pdf.ai/sign-up](https://www.redact-pdf.ai/sign-up). A free account
gets its first document (up to 5 pages) redacted in full, no card. Without a key,
`try_demo` still works; everything else will tell the agent to ask you for one.

## Tools

| Tool | What it does |
| --- | --- |
| `redact_pdf_and_wait` | **Start here.** Upload, redact, wait, return the finished PDF. One call. |
| `redact_pdf` | Start a job and return immediately, for redacting several documents in parallel. |
| `get_job_status` | Poll a job: `uploaded` → `analyzing` → `redacting` → `redacted` \| `error`. |
| `download_redacted` | Fetch the redacted output for one document. |
| `try_demo` | Keyless. With a file: redact its first page for real. Without: run the built-in sample. |
| `get_account_status` | Check the API key is valid and see the account, before a big batch. |

Redaction rules, on either redact tool:

| Argument | Effect |
| --- | --- |
| `pii_categories` | Restrict to specific entity types. Omit for account defaults. |
| `pii_included_terms` | Always redact these, even if not detected as PII (codenames, case numbers). |
| `pii_excluded_terms` | Never redact these, even if detected (your own company name). |
| `retention` | `ephemeral` (default) deletes the original after processing. `studio` keeps masks for human review. |

## Remote server

The package also ships a streamable-HTTP server for hosted use, where the API key travels
per request instead of in the environment:

```bash
npx redact-pdf-mcp-http     # listens on :8080/mcp
```

```
POST /mcp
X-API-Key: your_key          (or: Authorization: Bearer your_key)
```

It is **stateless** — no sessions, no stored keys, nothing kept between requests — so each
request gets its own short-lived server instance and one caller's key can never leak into
another's tool call.

The handshake, `tools/list`, and `try_demo` work without a key, so a client can connect and
verify the server before anyone signs up; every other tool returns `401` with a
`WWW-Authenticate` challenge.

Documents are supplied as `file_base64` (the remote server has no access to your
filesystem).

Fetching a document by URL is **off by default** on the remote server. The address check
is real — URLs resolving to loopback, private, or link-local addresses are refused, and
every redirect hop is re-checked — but the socket resolves the hostname a second time
after that check, so a DNS-rebinding attacker with a short TTL can still have the server
validate one address and connect to another. Closing that requires pinning the connection
to the validated address, which is not implemented yet, so an internet-reachable server
does not offer the surface at all.

Set `REDACT_PDF_ENABLE_URL_INPUT=1` to accept `file_url`, and only where you have your own
egress controls (a network policy or allowlisting proxy) in front of the server.
`REDACT_PDF_ALLOW_PRIVATE_URLS=1` additionally permits private addresses, for a
self-hosted instance fetching from internal storage.

stdio mode is unaffected: it runs on your own machine, where fetching a URL carries no
privilege you do not already have.

| Variable | Default | Purpose |
| --- | --- | --- |
| `REDACT_PDF_API_KEY` | — | API key (stdio mode only; remote takes it per request). |
| `REDACT_PDF_BASE_URL` | `https://www.redact-pdf.ai` | Point at a different API host. |
| `PORT` | `8080` | HTTP server port. |
| `REDACT_PDF_MCP_PATH` | `/mcp` | HTTP endpoint path. |
| `REDACT_PDF_ENABLE_URL_INPUT` | unset | Accept `file_url` on the remote server. Off by default — see the DNS-rebinding note above. |
| `REDACT_PDF_ALLOW_PRIVATE_URLS` | unset | Self-hosted only: permit `file_url` to reach private addresses. Never set this on a publicly reachable server. |

## What the server does locally

- **No telemetry.** The server makes exactly the API calls its tools describe, and nothing
  else. No analytics, no error reporting, no phone-home.
- **Stateless.** No database, no cache, no disk writes except the redacted PDF you asked
  for, at the path you asked for.
- **Your originals stay yours.** In stdio mode the input file is read and never modified.
  Under the default `ephemeral` retention the API deletes the original after processing.
- **Idempotent by default.** The idempotency key is derived from the file bytes and the
  redaction settings, so an agent that retries the same call gets the *same* job back
  instead of redacting — and billing — twice. That cache lasts 24 hours; pass an explicit
  `idempotency_key` when you genuinely want a second, separate redaction of the same file.
- **Never overwrites.** In stdio mode the redacted PDF is written atomically and the tool
  refuses to clobber an existing file.

## Privacy Policy

The full policy is at [redact-pdf.ai/privacy](https://www.redact-pdf.ai/privacy). It covers
the website, the app and the API this server calls. In short:

- **What is collected.** The documents you send, their processing metadata (status, page
  count, selected PII categories) and the redaction masks; your account identifier and
  email if you use an API key; billing data if you pay. This MCP server itself collects
  nothing and sends no telemetry.
- **How it is used.** To run the redaction you asked for, and to operate, secure and bill
  your account. Documents are processed for OCR and PII detection only and are never used
  to train AI models.
- **Where it is stored.** Microsoft Azure in the EU and Switzerland, encrypted in transit
  (TLS 1.2+) and at rest (AES-256).
- **Who it is shared with.** Documents go only to Microsoft Azure (storage, OCR and PII
  detection). Account and billing data go to Clerk and Stripe. Internal operational alerts,
  which can include a file name, go to the team's Slack. The policy lists every
  subprocessor.
- **How long it is kept.** Under the default `ephemeral` retention the original is deleted
  after processing; the redacted output follows your account's retention window (14 days
  by default) and can be deleted at any time. Files sent to the keyless `try_demo` are
  deleted after the first page is redacted; that page is kept 14 days.
- **Contact.** info@redact-pdf.ai for privacy requests and questions.

## Limits

- 50 MB per PDF, 10 MB per image, 100 files per job.
- PDF, JPEG and PNG in; always a PDF out. Convert other formats (DOCX, TIFF, HEIC) to PDF first.
- On the remote server, base64 inflates a document by about a third, so prefer `file_url`
  for anything large.
- Passing an empty `pii_categories` list is rejected: to the API an empty list means
  "redact nothing", which would return an untouched file reported as redacted. Omit the
  argument to use your account defaults.
- Billed per page against your plan quota and credit packs, after the free first document.
  A `quota_exceeded` error means top up — the tools tell the agent not to retry it.

## Development

```bash
npm install
npm run build
npm test                 # offline unit + tool tests
npm run test:integration # hits the live keyless demo endpoint; no key needed
```

## Links

- API docs: [redact-pdf.ai/developers](https://www.redact-pdf.ai/developers)
- Security and data handling: [redact-pdf.ai/security](https://www.redact-pdf.ai/security)
- OpenAPI spec: [redact-pdf.ai/openapi.yaml](https://www.redact-pdf.ai/openapi.yaml)
- LLM index: [redact-pdf.ai/llms.txt](https://www.redact-pdf.ai/llms.txt)

Support questions about redaction quality, billing, or your account go to
info@redact-pdf.ai — GitHub issues here are for the MCP server itself.

MIT licensed.
