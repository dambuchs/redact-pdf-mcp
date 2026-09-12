#!/usr/bin/env node
/**
 * stdio entry point — `npx redact-pdf-mcp`.
 *
 * This is the local mode: the process runs on the user's machine, reads their
 * PDFs off disk, and writes redacted output next to them. The API key comes
 * from the environment, which is how every MCP client passes secrets to a
 * stdio server.
 *
 * Nothing may be written to stdout except JSON-RPC frames — stdout IS the
 * transport. Diagnostics go to stderr.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DEFAULT_BASE_URL, RedactPdfClient } from './client.js';
import { createServer, VERSION } from './server.js';

async function main(): Promise<void> {
  const apiKey = process.env.REDACT_PDF_API_KEY?.trim() || undefined;
  const baseUrl = process.env.REDACT_PDF_BASE_URL?.trim() || DEFAULT_BASE_URL;

  // Not fatal: try_demo works without a key, and telling the model the key is
  // missing is more useful than refusing to start.
  if (!apiKey) {
    process.stderr.write(
      '[redact-pdf-mcp] No REDACT_PDF_API_KEY set. try_demo will work (it can redact the first page of a real file); redacting whole documents will not. Get a key at https://www.redact-pdf.ai/sign-up — a free account gets its first document (up to 5 pages) redacted free, no card.\n',
    );
  }

  const client = new RedactPdfClient({ apiKey, baseUrl });
  const server = createServer({ mode: 'stdio', client });

  await server.connect(new StdioServerTransport());
  process.stderr.write(`[redact-pdf-mcp] v${VERSION} ready on stdio (${baseUrl})\n`);

  // Previously there was no signal handling: SIGTERM killed the process
  // instantly, mid-redaction, and because stdout IS the transport the client
  // just saw a dead pipe — no response, no job id, and nothing on stderr, for
  // work that was already created and billed. Say so before going.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      process.stderr.write(
        `[redact-pdf-mcp] ${signal} received. Any redaction still running was already submitted and billed; ` +
          'its job continues server-side and can be recovered with get_job_status.\n',
      );
      void server.close().finally(() => process.exit(0));
    });
  }

  // Never let a stray rejection take the process down silently mid-session.
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(
      `[redact-pdf-mcp] unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}\n`,
    );
  });
}

main().catch((error: unknown) => {
  process.stderr.write(
    `[redact-pdf-mcp] fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exit(1);
});
