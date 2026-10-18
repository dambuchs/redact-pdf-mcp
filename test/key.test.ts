/**
 * Where the local server's key comes from: the environment when it holds a
 * real value, else a session key, else the file set_api_key writes. Launchers
 * such as the .mcpb bundle pass `${user_config.api_key}`, which can arrive
 * empty or as that literal text in a client that doesn't substitute.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { inspectKeyFile, isWellFormedKey, keyFilePath, keySource, readKeyFile, usableKey, writeKeyFile } from '../src/key.js';

const KEY = 'rpk_abcdefghijklmnopqrstuvwxyz0123456789-_';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'redact-key-'));
  file = join(dir, 'redact-pdf-mcp', 'key');
});

describe('usableKey', () => {
  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['whitespace', '  \n'],
    ['the unsubstituted plugin placeholder', '${user_config.api_key}'],
    ['any other placeholder, padded', '  ${REDACT_PDF_API_KEY} '],
    ['a placeholder inside other text', 'key-${user_config.api_key}'],
  ])('treats %s as unset', (_label, value) => {
    expect(usableKey(value)).toBeUndefined();
  });

  it('keeps a real key, trimmed', () => {
    expect(usableKey(`  ${KEY}\n`)).toBe(KEY);
  });

  it('does not mistake a lone dollar sign or brace for a placeholder', () => {
    expect(usableKey('abc$def{ghi}')).toBe('abc$def{ghi}');
  });
});

describe('isWellFormedKey', () => {
  it('accepts a key, with surrounding whitespace', () => {
    expect(isWellFormedKey(` ${KEY} `)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['a placeholder', '${user_config.api_key}'],
    ['two words', 'rpk_abc defghijk'],
    ['too short', 'rpk_abc'],
    ['too long', `rpk_${'a'.repeat(600)}`],
    ['a newline inside', 'rpk_abcdef\nghijkl'],
  ])('rejects %s', (_label, value) => {
    expect(isWellFormedKey(value)).toBe(false);
  });
});

describe('keyFilePath', () => {
  it('uses an absolute XDG_CONFIG_HOME', () => {
    expect(keyFilePath({ XDG_CONFIG_HOME: '/x/config' })).toBe(join('/x/config', 'redact-pdf-mcp', 'key'));
  });

  it('ignores a relative XDG_CONFIG_HOME, as the spec says', () => {
    expect(keyFilePath({ XDG_CONFIG_HOME: 'relative' })).toBe(join(homedir(), '.config', 'redact-pdf-mcp', 'key'));
  });

  it('falls back to ~/.config', () => {
    expect(keyFilePath({})).toBe(join(homedir(), '.config', 'redact-pdf-mcp', 'key'));
  });
});

describe('writeKeyFile / readKeyFile', () => {
  it('writes the key readable by the user only, in a user-only folder', async () => {
    await writeKeyFile(file, ` ${KEY} `);
    expect(await readFile(file, 'utf8')).toBe(`${KEY}\n`);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'redact-pdf-mcp'))).mode & 0o777).toBe(0o700);
    expect(readKeyFile(file)).toBe(KEY);
  });

  it('tightens an existing, wider file and leaves no temporary file behind', async () => {
    await writeKeyFile(file, 'rpk_old_key_value');
    await chmod(file, 0o644);
    await writeKeyFile(file, KEY);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(readKeyFile(file)).toBe(KEY);
    expect(await readdir(join(dir, 'redact-pdf-mcp'))).toEqual(['key']);
  });

  it('closes an existing folder that others can read', async () => {
    await mkdir(join(dir, 'redact-pdf-mcp'), { mode: 0o755 });
    await chmod(join(dir, 'redact-pdf-mcp'), 0o755);
    await writeKeyFile(file, KEY);
    expect((await stat(join(dir, 'redact-pdf-mcp'))).mode & 0o777).toBe(0o700);
  });

  it('leaves no temporary copy of the key when the save fails', async () => {
    // The key path is a non-empty folder, so the rename over it fails.
    await mkdir(join(file, 'occupied'), { recursive: true });
    await expect(writeKeyFile(file, KEY)).rejects.toThrow();
    expect(await readdir(join(dir, 'redact-pdf-mcp'))).toEqual(['key']);
  });

  it('lets two saves in one process run at once', async () => {
    await Promise.all([writeKeyFile(file, KEY), writeKeyFile(file, 'rpk_second_key_1')]);
    expect([KEY, 'rpk_second_key_1']).toContain(readKeyFile(file));
    expect(await readdir(join(dir, 'redact-pdf-mcp'))).toEqual(['key']);
  });

  it('reads a key file others can write, a symlink, a FIFO or an oversized file as no key', async () => {
    await writeKeyFile(file, KEY);
    await chmod(file, 0o666);
    expect(readKeyFile(file)).toBeUndefined();
    await chmod(file, 0o644);
    expect(readKeyFile(file)).toBe(KEY);

    const link = join(dir, 'link');
    await symlink(file, link);
    expect(readKeyFile(link)).toBeUndefined();

    const fifo = join(dir, 'fifo');
    execFileSync('mkfifo', [fifo]);
    expect(readKeyFile(fifo)).toBeUndefined(); // and does not hang

    const big = join(dir, 'big');
    await writeFile(big, `${KEY}${' '.repeat(2000)}`);
    expect(readKeyFile(big)).toBeUndefined();
  });

  it('says why an existing key file is ignored, and nothing for a missing one', async () => {
    expect(inspectKeyFile(file)).toEqual({});
    await writeKeyFile(file, KEY);
    expect(inspectKeyFile(file)).toEqual({ key: KEY });
    await chmod(file, 0o664);
    expect(inspectKeyFile(file).ignored).toMatch(/other users can write/);
    await chmod(file, 0o600);
    await writeFile(file, 'two words');
    expect(inspectKeyFile(file).ignored).toMatch(/exactly one key/);
    await writeFile(file, 'x'.repeat(2000));
    expect(inspectKeyFile(file).ignored).toMatch(/too large/);
    const link = join(dir, 'link');
    await symlink(file, link);
    expect(inspectKeyFile(link).ignored).toMatch(/symlink/);
    expect(inspectKeyFile(dir).ignored).toMatch(/not a regular file/);
  });

  it('closes the file it opens', async () => {
    await writeKeyFile(file, KEY);
    const open = () => readdirSync('/dev/fd').length;
    const before = open();
    for (let i = 0; i < 50; i += 1) readKeyFile(file);
    expect(open()).toBeLessThan(before + 5);
  });

  it('refuses to write through a symlinked folder', async () => {
    const real = join(dir, 'elsewhere');
    await mkdir(real, { mode: 0o755 });
    await chmod(real, 0o755);
    await writeFile(join(real, 'key'), 'IMPORTANT FILE');
    await symlink(real, join(dir, 'redact-pdf-mcp'));
    await expect(writeKeyFile(file, KEY)).rejects.toMatchObject({ code: 'ENOTDIR' });
    expect(await readFile(join(real, 'key'), 'utf8')).toBe('IMPORTANT FILE');
    expect((await stat(real)).mode & 0o777).toBe(0o755);
  });

  it('expect=null publishes only where no usable key is saved', async () => {
    await writeKeyFile(file, KEY, null);
    expect(readKeyFile(file)).toBe(KEY);
    await expect(writeKeyFile(file, 'rpk_second_key_1', null)).rejects.toMatchObject({ code: 'ECHANGED' });
    expect(readKeyFile(file)).toBe(KEY);
    // An unusable file is not a saved key, so it may be replaced.
    await writeFile(file, 'garbage with spaces');
    await writeKeyFile(file, 'rpk_second_key_1', null);
    expect(readKeyFile(file)).toBe('rpk_second_key_1');
    expect(await readdir(join(dir, 'redact-pdf-mcp'))).toEqual(['key']);
  });

  it('expect=<key> replaces only while that key is still the one saved', async () => {
    await writeKeyFile(file, KEY);
    await expect(writeKeyFile(file, 'rpk_third_key_1', 'rpk_not_this_one')).rejects.toMatchObject({ code: 'ECHANGED' });
    expect(readKeyFile(file)).toBe(KEY);
    await writeKeyFile(file, 'rpk_third_key_1', KEY);
    expect(readKeyFile(file)).toBe('rpk_third_key_1');
    expect(await readdir(join(dir, 'redact-pdf-mcp'))).toEqual(['key']);
  });

  it('reads a hand-edited file with a second line as no key, so it is never sent', async () => {
    await writeKeyFile(file, KEY);
    await writeFile(file, `${KEY}\nrpk_second_key_1\n`);
    expect(readKeyFile(file)).toBeUndefined();
    expect(keySource({}, file).saved()).toBeUndefined();
  });

  it('reads a missing or placeholder file as no key, without throwing', async () => {
    expect(readKeyFile(file)).toBeUndefined();
    expect(readKeyFile(dir)).toBeUndefined(); // a directory: EISDIR
    await writeKeyFile(file, KEY);
    await writeFile(file, '${user_config.api_key}\n');
    expect(readKeyFile(file)).toBeUndefined();
  });
});

describe('keySource', () => {
  it.each([
    ['empty', ''],
    ['the unsubstituted placeholder', '${user_config.api_key}'],
  ])('treats an %s REDACT_PDF_API_KEY as unset and falls back to the file', async (_label, value) => {
    const keys = keySource({ REDACT_PDF_API_KEY: value }, file);
    expect(keys.fromEnvironment).toBe(false);
    expect(keys.current()).toBeUndefined();
    await writeKeyFile(file, KEY);
    expect(keys.current()).toBe(KEY);
  });

  it('puts a session key between the environment and the file', async () => {
    await writeKeyFile(file, KEY);
    const keys = keySource({}, file);
    keys.setSession({ key: 'rpk_session_key_1', account: 'a@b.c' });
    expect(keys.current()).toBe('rpk_session_key_1');
    expect(keys.saved()).toBe(KEY);
    keys.setSession(undefined);
    expect(keys.current()).toBe(KEY);
    const withEnv = keySource({ REDACT_PDF_API_KEY: 'rpk_from_env_123' }, file);
    withEnv.setSession({ key: 'rpk_session_key_1', account: 'a@b.c' });
    expect(withEnv.current()).toBe('rpk_from_env_123');
  });

  it('prefers a real environment key over the file', async () => {
    await writeKeyFile(file, KEY);
    const keys = keySource({ REDACT_PDF_API_KEY: ' rpk_from_env_123 ' }, file);
    expect(keys.fromEnvironment).toBe(true);
    expect(keys.current()).toBe('rpk_from_env_123');
  });

  it('reads the file on every call, so a key saved elsewhere applies without a restart', async () => {
    const keys = keySource({}, file);
    expect(keys.current()).toBeUndefined();
    await writeKeyFile(file, KEY);
    expect(keys.current()).toBe(KEY);
    await writeKeyFile(file, 'rpk_rotated_key_1');
    expect(keys.current()).toBe('rpk_rotated_key_1');
  });

  it('saved() reads the file even when the environment supplies the key', async () => {
    await writeKeyFile(file, KEY);
    const keys = keySource({ REDACT_PDF_API_KEY: 'rpk_from_env_123' }, file);
    expect(keys.current()).toBe('rpk_from_env_123');
    expect(keys.saved()).toBe(KEY);
  });

  it('defaults the file to keyFilePath(env)', () => {
    expect(keySource({ XDG_CONFIG_HOME: dir }).filePath).toBe(file);
  });
});
