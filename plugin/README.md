# Redact PDF AI

Redact or anonymize PDFs, scans, photos and screenshots on your own machine, before Claude or anyone else reads them.

- **Redact**: personal data is blacked out, and the text is deleted from the file rather than covered, so it can't be copied out or recovered.
- **Anonymize**: every person, company and address becomes a consistent tag such as `[Person 1]`, so the document stays readable. Claude works on the tagged version, and the real names are put back on your machine afterwards. Claude never sees them.

## What's in the plugin

- The **Redact PDF AI MCP server** ([`redact-pdf-mcp`](https://www.npmjs.com/package/redact-pdf-mcp), pinned to 0.4.1, MIT licensed, source at [github.com/dambuchs/redact-pdf-mcp](https://github.com/dambuchs/redact-pdf-mcp)). It runs locally through `npx`. Tools: `redact_pdf_and_wait`, `redact_pdf`, `get_job_status`, `download_redacted`, `download_correspondence`, `try_demo`, `restore_names`, `get_account_status`, `set_api_key`.
- The **anonymize-before-ai** skill: pseudonymize a document without opening it, work on the tagged text, then restore the names locally with `restore_names`.
- The **redact-before-sharing** skill: black out personal data before a document is sent, filed or published.

It works in Claude Code, and in Cowork sessions that run on your computer, because the server reads files from your disk. claude.ai chat doesn't start local servers. A file you have already uploaded to a chat has already been shared, and no tool can take that back.

## Install

In Claude Code:

```
/plugin install redact-pdf-ai --marketplace dambuchs/redact-pdf-mcp
```

In Cowork, add it from **Customize → Plugins**. It runs in Cowork sessions on your computer.

## Use it

Ask, for example:

- "Anonymize `lease.pdf` and summarize the tenant's obligations, then give me the version with the real names."
- "Redact everything personal in `scan.jpg` before I send it to the landlord."
- "Black out the names in every PDF in this folder, but keep our company name."

## API key

You need an API key from [redact-pdf.ai](https://www.redact-pdf.ai/sign-up) to redact whole documents. It's optional: without one, `try_demo` redacts the first page of a real file for free. A free account gets its first document (up to 5 pages) done in full, with no card.

The plugin has no key setting: Cowork doesn't start a plugin's server that asks for one. Instead, paste the key into the conversation and ask Claude to use it. It calls the `set_api_key` tool, which first checks the key with the Redact PDF AI API:

- **Where the app can show a confirmation form**, you approve the account: its email and the key's last four characters. The key is then saved to `~/.config/redact-pdf-mcp/key` (or `$XDG_CONFIG_HOME/redact-pdf-mcp/key`), a file only your user can read (mode 0600), and used in later sessions too. A saved key is never replaced without that confirmation.
- **Where the app can't ask** (Cowork, as of October 2026), the key is used for that session only, never written to disk, and every result names the account it goes to. That way a key slipped into a document you process can't quietly send your files to someone else's account.

The tool never returns the key to Claude. A pasted key stays in that chat's history, so if you'd rather not paste it each session, save it once yourself instead. Copy the key from your [dashboard](https://www.redact-pdf.ai/dashboard/settings), then run this in Terminal (macOS):

```bash
mkdir -p ~/.config/redact-pdf-mcp && chmod 700 ~/.config/redact-pdf-mcp && (umask 077 && pbpaste | tr -d '[:space:]' > ~/.config/redact-pdf-mcp/key) && chmod 600 ~/.config/redact-pdf-mcp/key
```

On Windows, in PowerShell:

```powershell
$d = "$HOME\.config\redact-pdf-mcp"; New-Item -ItemType Directory -Force $d | Out-Null; (Get-Clipboard).Trim() | Set-Content -NoNewline "$d\key"
```

The key never appears on screen or in your shell history. Delete the file to remove the key.

## What it sends, and where

- **To the Redact PDF AI API (`https://www.redact-pdf.ai`)**: the document you ask it to process, your redaction options and your API key. Documents are processed on Microsoft Azure in the EU and Switzerland, encrypted in transit and at rest, and never used to train AI models.
- **To npm**: `npx` downloads `redact-pdf-mcp@0.4.1` and its dependencies from the public npm registry the first time it runs.
- **Kept on your machine**: the API key, if you confirm saving it with `set_api_key` (see above). The redacted PDF, the correspondence table that maps tags to real names, and the restored file. `restore_names` runs entirely locally and uploads nothing.
- The plugin and the MCP server collect no telemetry.

## Privacy Policy

The full policy is at [redact-pdf.ai/privacy](https://www.redact-pdf.ai/privacy). It covers the website, the app and the API this plugin calls. In short:

- **What is collected.** The documents you send, their processing metadata (status, page count, selected PII categories) and the redaction masks. Your account identifier and email if you use an API key, and billing data if you pay.
- **How it is used.** To run the redaction you asked for, and to operate, secure and bill your account. Documents are processed for OCR and PII detection only, and are never used to train AI models.
- **Where it is stored.** Microsoft Azure in the EU and Switzerland, encrypted in transit (TLS 1.2+) and at rest (AES-256).
- **Who it is shared with.** Documents go only to Microsoft Azure (storage, OCR and PII detection). Account and billing data go to Clerk and Stripe. Internal operational alerts, which can include a file name, go to the team's Slack. The policy lists every subprocessor.
- **How long it is kept.** Under the default `ephemeral` retention, the original is deleted after processing. The redacted output follows your account's retention window (14 days by default) and can be deleted at any time. Files sent to the keyless `try_demo` are deleted once the first page is redacted, and that page is kept for 14 days.
- **Contact.** info@redact-pdf.ai for privacy requests and questions.

## Support

Open an issue at [github.com/dambuchs/redact-pdf-mcp/issues](https://github.com/dambuchs/redact-pdf-mcp/issues) or email info@redact-pdf.ai.
