/**
 * One structured line per tool call, on stderr.
 *
 * Measured before this existed: twenty tool calls against a completely dead
 * upstream produced ZERO log lines, every call returned HTTP 200 (the MCP
 * error is in the body), and /health answered "ok" throughout. A total outage
 * of the API was indistinguishable from an idle healthy server from every
 * signal this package emitted.
 *
 * stderr specifically: in stdio mode stdout IS the JSON-RPC transport, so
 * anything written there corrupts the protocol.
 *
 * What is deliberately NOT logged: the API key, file contents, filenames, and
 * document text. The upstream `request_id` is included because it is the handle
 * support needs to correlate with the API's own logs.
 */

export interface ToolCallLog {
  tool: string;
  outcome: 'ok' | 'error';
  durationMs: number;
  code?: string | undefined;
  httpStatus?: number | undefined;
  jobId?: string | undefined;
  documentId?: string | undefined;
  requestId?: string | undefined;
}

let sink: (line: string) => void = (line) => process.stderr.write(line);

/** Redirect the log sink. Test-only. */
export function setLogSink(next: (line: string) => void): void {
  sink = next;
}

export function logToolCall(entry: ToolCallLog): void {
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    svc: 'redact-pdf-mcp',
    ...entry,
  };
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) delete record[key];
  }
  try {
    sink(`${JSON.stringify(record)}\n`);
  } catch {
    /* logging must never break a tool call */
  }
}
