# Redact PDF MCP server

**An MCP server that permanently redacts PII from PDFs.** Give an agent a PDF, get back a
PDF with the sensitive text *removed from the file* — not covered with a black rectangle
that anyone can select, copy, or delete.

Most "redaction" MCP servers scrub PII out of prompt text. This one takes a real document
and returns a real redacted document.

[![npm](https://img.shields.io/npm/v/redact-pdf-mcp?color=cb3837&logo=npm)](https://www.npmjs.com/package/redact-pdf-mcp)
[![MCP registry](https://img.shields.io/badge/MCP%20registry-io.github.dambuchs%2Fredact--pdf--mcp-blue)](https://registry.modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

<a href="https://glama.ai/mcp/servers/dambuchs/redact-pdf-mcp"><img width="380" height="200" src="https://glama.ai/mcp/servers/dambuchs/redact-pdf-mcp/badges/card.svg" alt="redact-pdf-mcp MCP server" /></a>

```bash
claude mcp add redact-pdf -- npx -y redact-pdf-mcp
```

Then ask: *"Redact the personal data in ~/Documents/contract.pdf"*.

---

## Try it with no API key

The server ships a keyless tool, `try_demo`, so you can verify the whole path — client,
server, API — before signing up for anything:

> **You:** Use the redact-pdf server's try_demo tool.
>
> **Claude:** The demo redacted a synthetic sample and removed 5 entities: Person
> (`Jane Sample`), Email (`jane.sample@example.com`), PhoneNumber (`+1 415 555 0142`),
> Organization (`Globex Demo Inc.`), Date (`2026-03-14`).

Same thing from a terminal, no install:

```bash
curl https://www.redact-pdf.ai/v1/demo
```

## What it does

- **Permanent, irreversible redaction.** The underlying text is deleted, not masked. It
  cannot be recovered by copy-paste, text extraction, or "remove object" in a PDF editor.
- **Scanned documents.** OCR handles image-only PDFs and photos of documents.
- **100+ languages** for entity detection.
- **Eight entity types**: Person, Email, PhoneNumber, Address, Organization, Date, IBAN,
  CreditCard — plus your own always-redact and never-redact term lists.
- **EU/Swiss processing.**
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

Get an API key at [redact-pdf.ai/sign-up](https://www.redact-pdf.ai/sign-up). Without one,
`try_demo` still works; everything else will tell the agent to ask you for a key.

## Tools

| Tool | What it does |
| --- | --- |
| `redact_pdf_and_wait` | **Start here.** Upload, redact, wait, return the finished PDF. One call. |
| `redact_pdf` | Start a job and return immediately, for redacting several documents in parallel. |
| `get_job_status` | Poll a job: `uploaded` → `analyzing` → `redacting` → `redacted` \| `error`. |
| `download_redacted` | Fetch the redacted output for one document. |
| `try_demo` | Keyless. Verify the server works with zero configuration. |
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

## Privacy

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

## Limits

- 50 MB per PDF, 10 MB per image, 100 files per job.
- PDF, JPEG and PNG. Convert other formats to PDF first.
- On the remote server, base64 inflates a document by about a third, so prefer `file_url`
  for anything large.
- Passing an empty `pii_categories` list is rejected: to the API an empty list means
  "redact nothing", which would return an untouched file reported as redacted. Omit the
  argument to use your account defaults.
- Billed per page against your plan quota and credit packs. A `quota_exceeded` error means
  top up — the tools tell the agent not to retry it.

## Development

```bash
npm install
npm run build
npm test                 # offline unit + tool tests
npm run test:integration # hits the live keyless demo endpoint; no key needed
```

## Links

- API docs: [redact-pdf.ai/developers](https://www.redact-pdf.ai/developers)
- OpenAPI spec: [redact-pdf.ai/openapi.yaml](https://www.redact-pdf.ai/openapi.yaml)
- LLM index: [redact-pdf.ai/llms.txt](https://www.redact-pdf.ai/llms.txt)

Support questions about redaction quality, billing, or your account go to
info@redact-pdf.ai — GitHub issues here are for the MCP server itself.

MIT licensed.
