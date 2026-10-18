/**
 * writeKeyFile against a hostile folder: one owned by someone else, and a
 * symlink planted at the temporary name. Both need the filesystem calls
 * faked: a test can't chown to another user, and the temporary name is random.
 */
import { lstat, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ otherOwner: false, linkError: undefined as string | undefined }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    link: async (...args: Parameters<typeof real.link>) => {
      if (fake.linkError) throw Object.assign(new Error('no hard links here'), { code: fake.linkError });
      return real.link(...args);
    },
    lstat: async (...args: Parameters<typeof real.lstat>) => {
      const info = await real.lstat(...args);
      return fake.otherOwner ? Object.assign(info, { uid: Number(info.uid) + 1 }) : info;
    },
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    fstatSync: (...args: Parameters<typeof real.fstatSync>) => {
      const info = real.fstatSync(...args);
      return fake.otherOwner ? Object.assign(info, { uid: Number(info.uid) + 1 }) : info;
    },
  };
});

vi.mock('node:crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:crypto')>()),
  randomUUID: () => 'fixed',
}));

const { inspectKeyFile, readKeyFile, writeKeyFile } = await import('../src/key.js');

const KEY = 'rpk_abcdefghijklmnopqrstuvwxyz0123456789-_';

afterEach(() => {
  fake.otherOwner = false;
  fake.linkError = undefined;
});

describe('writeKeyFile in a hostile folder', () => {
  it('refuses a folder that belongs to another user, and writes nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'redact-key-'));
    const file = join(dir, 'redact-pdf-mcp', 'key');
    fake.otherOwner = true;
    await expect(writeKeyFile(file, KEY)).rejects.toMatchObject({ code: 'ENOTOWNER' });
    fake.otherOwner = false;
    expect(readKeyFile(file)).toBeUndefined();
  });

  it('ignores a key file that belongs to another user', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'redact-key-'));
    const file = join(dir, 'key');
    await writeFile(file, `${KEY}\n`, { mode: 0o600 });
    expect(readKeyFile(file)).toBe(KEY);
    fake.otherOwner = true;
    expect(readKeyFile(file)).toBeUndefined();
    expect(inspectKeyFile(file).ignored).toMatch(/another user/);
  });

  it.each(['EPERM', 'ENOTSUP', 'ENOSYS', 'EISDIR'])(
    'falls back to a checked rename where the filesystem has no hard links (%s)',
    async (code) => {
      const dir = await mkdtemp(join(tmpdir(), 'redact-key-'));
      const file = join(dir, 'key');
      fake.linkError = code;
      await writeKeyFile(file, KEY, null);
      expect(readKeyFile(file)).toBe(KEY);
      // Still refuses to replace a usable key that is already there.
      await expect(writeKeyFile(file, 'rpk_second_key_1', null)).rejects.toMatchObject({ code: 'ECHANGED' });
      expect(readKeyFile(file)).toBe(KEY);
    },
  );

  it('does not fall back on any other link failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'redact-key-'));
    fake.linkError = 'EIO';
    await expect(writeKeyFile(join(dir, 'key'), KEY, null)).rejects.toMatchObject({ code: 'EIO' });
    expect(readKeyFile(join(dir, 'key'))).toBeUndefined();
  });

  it('never writes the key through a symlink planted at the temporary name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'redact-key-'));
    const file = join(dir, 'key');
    const victim = join(dir, 'attacker-readable');
    await writeFile(victim, 'untouched');
    await symlink(victim, `${file}.${process.pid}.fixed.tmp`);
    await expect(writeKeyFile(file, KEY)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(victim, 'utf8')).toBe('untouched');
    await expect(lstat(file)).rejects.toThrow();
  });
});
