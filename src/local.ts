/**
 * The stdio server as `npx redact-pdf-mcp` builds it, apart from the process
 * plumbing in stdio.ts so the key wiring can be tested: the client reads its
 * key from the same source that set_api_key writes to.
 */

import { DEFAULT_BASE_URL, RedactPdfClient } from './client.js';
import { keySource, type KeySource } from './key.js';
import { createServer } from './server.js';

/** No key, or a saved key the API rejected: set_api_key can fix both. */
export const LOCAL_KEY_HELP =
  'Ask the user for a key from https://www.redact-pdf.ai/dashboard/settings (free account: https://www.redact-pdf.ai/sign-up; the first document, up to 5 pages, is redacted free with no card) and call set_api_key with it, or set REDACT_PDF_API_KEY.';

/**
 * A key from REDACT_PDF_API_KEY that the API rejected. set_api_key can't help:
 * the environment keeps priority, so a saved key would change nothing and the
 * user would have pasted a secret into the chat for no effect.
 */
export const ENV_KEY_HELP =
  'The key comes from REDACT_PDF_API_KEY, set in this MCP client\'s configuration for the server. Ask the user to replace it there with a current key from https://www.redact-pdf.ai/dashboard/settings and restart the session; set_api_key would not take priority over it.';

export function createLocalServer(
  env: NodeJS.ProcessEnv,
  overrides: { fetchImpl?: typeof fetch; keyFile?: string } = {},
) {
  // An empty or unsubstituted `${user_config.api_key}` (the .mcpb bundle, or
  // a client that doesn't substitute) counts as unset.
  const keys: KeySource = overrides.keyFile ? keySource(env, overrides.keyFile) : keySource(env);
  const baseUrl = env.REDACT_PDF_BASE_URL?.trim() || DEFAULT_BASE_URL;
  const client = new RedactPdfClient({
    apiKey: keys.current,
    baseUrl,
    keyHelp: keys.fromEnvironment ? ENV_KEY_HELP : LOCAL_KEY_HELP,
    ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl, sleep: async () => {} } : {}),
  });
  const server = createServer({
    mode: 'stdio',
    client,
    keySource: keys,
    ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
  });
  return { server, client, keys, baseUrl };
}
