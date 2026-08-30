/**
 * writeOutput's filesystem failure branches.
 *
 * The end-to-end tests in server.test.ts cannot reach these: they need link(2)
 * to fail the way it does on a filesystem with no hardlinks. Isolated in its own
 * file so the node:fs/promises mock cannot leak into any other suite.
 *
 * This branch was unexecuted by every previous test while carrying the
 * package's no-overwrite guarantee — the exact shape of the round 2-5
 * regressions, where a fix landed in code nothing exercised.
 */

import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchMock, payload } from './helpers.js';
import { RedactPdfClient } from '../src/client.js';
import { createServer } from '../src/server.js';

/** Flipped per test to make link(2) fail the way an exotic filesystem does. */
const linkFailure = vi.hoisted(() => ({ code: null as string | null }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    link: async (existing: string, target: string) => {
      if (linkFailure.code) {
        const error = new Error(`link failed: ${linkFailure.code}`) as NodeJS.ErrnoException;
        error.code = linkFailure.code;
        throw error;
      }
      return actual.link(existing, target);
    },
  };
});

const REDACTED_PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);

async function stdioClient(): Promise<Client> {
  const fetchImpl = fetchMock(async () => new Response(REDACTED_PDF));
  const client = new Client({ name: 'test', version: '1.0.0' });
  const server = createServer({
    mode: 'stdio',
    client: new RedactPdfClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
    }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const download = (client: Client, output_path: string) =>
  client.callTool({
    name: 'download_redacted',
    arguments: { document_id: 'doc-1', output_path },
  });

const partials = async (dir: string): Promise<string[]> =>
  (await readdir(dir)).filter((name) => name.includes('.partial'));

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'redact-write-'));
});

afterEach(() => {
  linkFailure.code = null;
  vi.restoreAllMocks();
});

describe('writeOutput where link(2) is unavailable', () => {
  // The fallback used to be gated on an enumerated errno list
  // (EPERM/ENOTSUP/EOPNOTSUPP/EXDEV/EMLINK), which meant guessing each
  // platform's answer. Windows maps a CreateHardLinkW failure on a non-NTFS
  // volume to EISDIR and some FUSE mounts answer ENOSYS — so on exactly the
  // filesystems the fallback exists for, the user was told to "pass an absolute
  // output_path inside a directory this process can write to" for a directory
  // plain writeFile handles, after the pages were already billed.
  it.each(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EMLINK', 'EISDIR', 'ENOSYS', 'EINVAL'])(
    'still delivers the file when link() fails with %s',
    async (code) => {
      linkFailure.code = code;
      const target = join(tempDir, 'out.pdf');

      const out = payload(await download(await stdioClient(), target));

      expect(out.status).toBe('downloaded');
      expect(new Uint8Array(await readFile(target))).toEqual(REDACTED_PDF);
      expect(await partials(tempDir)).toEqual([]);
    },
  );

  it('still refuses to overwrite an existing file on the fallback path', async () => {
    // The fallback must keep its 'wx' flag. Relaxing it to 'w' is a one-token
    // change no other test would catch, and it silently destroys the user's
    // file on every filesystem without hardlinks.
    linkFailure.code = 'EPERM';
    const target = join(tempDir, 'taken.pdf');
    await writeFile(target, 'precious');

    const result = await download(await stdioClient(), target);

    expect(result.isError).toBe(true);
    expect(payload(result).error).toMatch(/already exists/);
    expect(await readFile(target, 'utf8')).toBe('precious');
    expect(await partials(tempDir)).toEqual([]);
  });
});

describe('writeOutput on an ordinary filesystem', () => {
  it('leaves no .partial file behind on the happy path', async () => {
    // The existing suite only checks for leftovers on the refusal path, so
    // moving the unlink out of `finally` would leak a full-size temp beside
    // every successful redaction and stay green.
    const target = join(tempDir, 'out.pdf');

    await download(await stdioClient(), target);

    expect(await partials(tempDir)).toEqual([]);
  });

  it('writes to a path whose basename is near the filesystem limit', async () => {
    // The temp name was `${outputPath}.${uuid}.partial`, adding 45 bytes to a
    // basename that may already be close to the 255-byte ceiling — so a legal
    // output_path failed at the temp create, reported as a permissions problem.
    const target = join(tempDir, `${'a'.repeat(240)}.pdf`);

    const out = payload(await download(await stdioClient(), target));

    expect(out.status).toBe('downloaded');
    expect(new Uint8Array(await readFile(target))).toEqual(REDACTED_PDF);
  });
});
