/** Getting bytes in: local paths, inline base64, and remote URLs. */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  contentTypeForFilename,
  fileFromBase64,
  fileFromPath,
  fileFromUrl,
} from '../src/inputs.js';
import { rejection } from './helpers.js';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'redact-inputs-'));
});

describe('contentTypeForFilename', () => {
  it.each([
    ['a.pdf', 'application/pdf'],
    ['a.PDF', 'application/pdf'],
    ['a.jpg', 'image/jpeg'],
    ['a.jpeg', 'image/jpeg'],
    ['a.png', 'image/png'],
  ])('maps %s', (name, expected) => {
    expect(contentTypeForFilename(name)).toBe(expected);
  });

  it.each([['a.docx'], ['a.tiff'], ['a.heic'], ['noextension']])(
    'refuses %s with a message naming what is accepted',
    (name) => {
      expect(() => contentTypeForFilename(name)).toThrow(/PDF, JPEG and PNG/);
    },
  );
});

describe('fileFromPath', () => {
  it('reads a local PDF', async () => {
    const path = join(dir, 'ok.pdf');
    await writeFile(path, Buffer.from('%PDF-1.4 hello'));
    const file = await fileFromPath(path);
    expect(file.filename).toBe('ok.pdf');
    expect(file.contentType).toBe('application/pdf');
  });

  it('says "no such file" rather than leaking an errno', async () => {
    const error = await rejection(fileFromPath(join(dir, 'missing.pdf')));
    expect(error.message).toMatch(/no such file/);
  });

  it('rejects an empty file instead of uploading zero bytes', async () => {
    const path = join(dir, 'empty.pdf');
    await writeFile(path, '');
    await expect(fileFromPath(path)).rejects.toThrow(/is empty/);
  });
});

describe('fileFromBase64', () => {
  it('decodes a valid payload', () => {
    const file = fileFromBase64('a.pdf', Buffer.from('%PDF-1.4').toString('base64'));
    expect(new TextDecoder().decode(file.bytes)).toBe('%PDF-1.4');
  });

  it('tolerates whitespace, which wrapped base64 carries', () => {
    const raw = Buffer.from('%PDF-1.4').toString('base64');
    const file = fileFromBase64('a.pdf', `${raw.slice(0, 4)}\n  ${raw.slice(4)}`);
    expect(new TextDecoder().decode(file.bytes)).toBe('%PDF-1.4');
  });

  it('diagnoses invalid base64 as such, not as an empty file', () => {
    // Node's decoder silently drops unknown characters instead of throwing, so
    // without an explicit check the agent is told the document is "empty" and
    // retries the same broken payload.
    expect(() => fileFromBase64('a.pdf', '!!!not base64!!!')).toThrow(/not valid base64/);
  });

  it('names base64url as the likely mistake', () => {
    const urlSafe = Buffer.from('%PDF-1.4 ?? ~~').toString('base64url');
    expect(() => fileFromBase64('a.pdf', urlSafe)).toThrow(/base64url/);
  });

  it('rejects invalid characters even when the length is a multiple of four', () => {
    // The base64url test passes via the length check, so the charset check was
    // never exercised. Node silently drops unknown characters: 'ab!!cd@@'
    // decodes to the same bytes as 'abcd' rather than failing.
    expect(() => fileFromBase64('a.pdf', 'ab!!cd@@')).toThrow(/not valid base64/);
  });

  it('rejects an empty payload', () => {
    expect(() => fileFromBase64('a.pdf', '')).toThrow(/carried no data/);
  });

  it('still enforces the file type', () => {
    expect(() => fileFromBase64('a.docx', Buffer.from('x').toString('base64'))).toThrow(
      /PDF, JPEG and PNG/,
    );
  });
});

describe('fileFromUrl', () => {
  // Stub DNS so the offline suite never leaves the machine.
  const publicDns = async () => ['93.184.216.34'];
  const pdf = () =>
    new Response(Buffer.from('%PDF-1.4'), {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
    });

  it('takes the filename from the URL path', async () => {
    const file = await fileFromUrl(
      'https://example.com/docs/contract.pdf',
      vi.fn(async () => pdf()) as unknown as typeof fetch,
      publicDns,
    );
    expect(file.filename).toBe('contract.pdf');
  });

  it('prefers a Content-Disposition filename', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(Buffer.from('%PDF-1.4'), {
          status: 200,
          headers: {
            'content-type': 'application/pdf',
            'content-disposition': 'attachment; filename="invoice-2026.pdf"',
          },
        }),
    );
    const file = await fileFromUrl(
      'https://example.com/download?id=42',
      fetchImpl as unknown as typeof fetch,
      publicDns,
    );
    expect(file.filename).toBe('invoice-2026.pdf');
  });

  it('trusts a supported served content-type over a missing extension', async () => {
    const fetchImpl = vi.fn(async () => pdf());
    const file = await fileFromUrl(
      'https://example.com/download?id=42',
      fetchImpl as unknown as typeof fetch,
      publicDns,
    );
    expect(file.contentType).toBe('application/pdf');
    expect(file.filename).toBe('document.pdf');
  });

  it('falls back to the extension when the served type is unhelpful', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(Buffer.from('%PDF-1.4'), {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        }),
    );
    const file = await fileFromUrl(
      'https://example.com/a.pdf',
      fetchImpl as unknown as typeof fetch,
      publicDns,
    );
    expect(file.contentType).toBe('application/pdf');
  });

  it('reports a non-2xx download with its status', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 404 }));
    const error = await rejection(
      fileFromUrl(
      'https://example.com/a.pdf',
      fetchImpl as unknown as typeof fetch,
      publicDns,
    ),
    );
    expect(error.message).toMatch(/returned 404/);
  });

  it('rejects a malformed URL', async () => {
    const error = await rejection(fileFromUrl(
      'http://',
      vi.fn() as unknown as typeof fetch,
      publicDns,
    ));
    expect(error.message).toMatch(/not a valid URL/);
  });
});
