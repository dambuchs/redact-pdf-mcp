/**
 * The Claude plugin in ./plugin launches this package through npx at a pinned
 * version (the directory blocks unpinned launchers). Nothing else ties that pin
 * to package.json, so a release that forgets it ships a plugin still running
 * the previous server.
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const read = async (path: string) =>
  JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8')) as Record<string, any>;

describe('claude plugin', () => {
  it('pins the server and its own version to the package version', async () => {
    const pkg = await read('../package.json');
    const plugin = await read('../plugin/.claude-plugin/plugin.json');
    const mcp = await read('../plugin/.mcp.json');
    const server = mcp.mcpServers['redact-pdf'];
    expect(plugin.version).toBe(pkg.version);
    expect(server.command).toBe('npx');
    expect(server.args).toEqual(['-y', `${pkg.name}@${pkg.version}`]);
  });

  it('passes the API key only through a sensitive userConfig entry', async () => {
    const plugin = await read('../plugin/.claude-plugin/plugin.json');
    const mcp = await read('../plugin/.mcp.json');
    expect(mcp.mcpServers['redact-pdf'].env).toEqual({
      REDACT_PDF_API_KEY: '${user_config.api_key}',
    });
    expect(plugin.userConfig.api_key.sensitive).toBe(true);
  });
});
