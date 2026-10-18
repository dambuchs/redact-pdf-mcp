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

  it('references no user_config anywhere, or Cowork drops the server', async () => {
    // Measured 2026-10-18 in Cowork (desktop 2.42304.0): any ${user_config.*}
    // in a plugin MCP server's config, default or not, is logged as "user_config
    // is not supported on the desktop host bridge; dropping server". The key
    // comes from set_api_key or the key file instead (see src/key.ts).
    const raw = await readFile(new URL('../plugin/.mcp.json', import.meta.url), 'utf8');
    expect(raw).not.toMatch(/user_config/);
    const mcp = await read('../plugin/.mcp.json');
    expect(mcp.mcpServers['redact-pdf'].env).toBeUndefined();
    const plugin = await read('../plugin/.claude-plugin/plugin.json');
    expect(plugin.userConfig).toBeUndefined();
  });
});
