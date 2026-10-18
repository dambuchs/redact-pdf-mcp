/**
 * restore_names: the re-identify end of anonymize -> AI works -> re-identify.
 *
 * The rule this whole tool exists to keep: the model never sees a name. Every
 * call below, success or failure, goes through `call()`, which fails the test
 * if any original value from the table appears anywhere in the result.
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { RedactPdfClient } from '../src/client.js';
import {
  crc32,
  entryData,
  parseCorrespondenceCsv,
  readZip,
  restoreDocx,
  restoredPath,
  restoreText,
  writeZip,
} from '../src/restore.js';
import { createServer } from '../src/server.js';
import { fetchMock, payload } from './helpers.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

// As the API serves it: BOM, RFC 4180 quoting, the Excel formula guard ("'=").
const CSV =
  '﻿placeholder,label,category,original\n' +
  '[Person 1],[Seller],Person,Anna Keller\n' +
  '[Person 2],,Person,"Keller, Jean ""JK"""\n' +
  '[Org 1],,Organization,Acme & Söhne AG\n' +
  "[Org 2],,Organization,'=Evil Corp\n" +
  '[Person 3],,Person,\n';

/** Every original in CSV, plus the fragments a partial leak would show. */
const ORIGINALS = [
  'Anna Keller', 'Keller, Jean', '"JK"', 'Acme & Söhne', 'Acme &amp; Söhne', 'Söhne', '=Evil Corp', 'Evil Corp', 'Keller', 'Anna', 'Acme',
  // From the tables some tests write themselves.
  'Unit 7', 'Bob Marsh', 'Carla Diaz',
];

function assertNoOriginal(result: unknown): void {
  const text = JSON.stringify(result);
  for (const original of ORIGINALS) {
    expect(text, `result leaked "${original}"`).not.toContain(JSON.stringify(original).slice(1, -1));
  }
}

let dir: string;
let csvPath: string;
let client: Client;

async function call(args: Record<string, unknown>) {
  const result = await client.callTool({ name: 'restore_names', arguments: args });
  assertNoOriginal(result);
  return result;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'restore-'));
  csvPath = join(dir, 'contract-correspondence.csv');
  await writeFile(csvPath, CSV);
  client = new Client({ name: 'test', version: '1.0.0' });
  const server = createServer({
    mode: 'stdio',
    client: new RedactPdfClient({ apiKey: 'k', fetchImpl: fetchMock() as unknown as typeof fetch }),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
});

describe('the correspondence table', () => {
  it('parses quotes, the BOM and the formula guard back to the real values', () => {
    expect(parseCorrespondenceCsv(CSV)).toEqual([
      { placeholder: '[Person 1]', label: '[Seller]', original: 'Anna Keller' },
      { placeholder: '[Person 2]', label: '', original: 'Keller, Jean "JK"' },
      { placeholder: '[Org 1]', label: '', original: 'Acme & Söhne AG' },
      { placeholder: '[Org 2]', label: '', original: '=Evil Corp' },
      { placeholder: '[Person 3]', label: '', original: '' },
    ]);
  });

  it('keeps an apostrophe that is not the formula guard', () => {
    const [row] = parseCorrespondenceCsv("placeholder,label,category,original\n[Person 1],,Person,'t Hooft\n");
    expect(row?.original).toBe("'t Hooft");
  });

  it('reads CRLF line ends', () => {
    expect(parseCorrespondenceCsv('placeholder,label,category,original\r\n[Person 1],,Person,Anna\r\n')).toHaveLength(1);
  });

  it('refuses a file that is not a table, and an unclosed quote, without quoting the content', () => {
    expect(() => parseCorrespondenceCsv('name,email\nAnna Keller,a@k.ch\n')).toThrow(/not a correspondence table/);
    expect(() => parseCorrespondenceCsv('placeholder,label,category,original\n[Person 1],,Person,"Anna Keller\n'))
      .toThrow(/unclosed quote on line 2/);
    try {
      parseCorrespondenceCsv('placeholder,label,category,original\n[Person 1],,Person,"Anna Keller\n');
    } catch (error) {
      expect(String(error)).not.toContain('Anna');
    }
  });
});

describe('restoring text', () => {
  const table = parseCorrespondenceCsv(CSV);

  it('restores the placeholder AND the rename, and counts', () => {
    const { text, counts } = restoreText('[Seller] sold to [Org 1]; [Person 1] signed. [Person 2] too.', table);
    expect(text).toBe('Anna Keller sold to Acme & Söhne AG; Anna Keller signed. Keller, Jean "JK" too.');
    expect(counts).toEqual({ replacements: 4, tags_restored: 4, unresolved_tags: [], ambiguous_tags: [] });
  });

  it('never lets [Person 1] eat [Person 10]', () => {
    const { text, counts } = restoreText('[Person 1] and [Person 10]', table);
    expect(text).toBe('Anna Keller and [Person 10]');
    expect(counts.unresolved_tags).toEqual(['[Person 10]']);
  });

  it('restores Markdown-escaped tags', () => {
    expect(restoreText('\\[Person 1\\] wrote', table).text).toBe('Anna Keller wrote');
  });

  it('leaves a tag with no stored original in place and reports it', () => {
    const { text, counts } = restoreText('[Person 3] was there', table);
    expect(text).toBe('[Person 3] was there');
    expect(counts.replacements).toBe(0);
    expect(counts.unresolved_tags).toEqual(['[Person 3]']);
  });

  it('never reports an original back, even one shaped like a tag', () => {
    const [row] = parseCorrespondenceCsv('placeholder,label,category,original\n[Org 1],,Organization,[Unit 7]\n');
    const { text, counts } = restoreText('[Org 1] replied', row ? [row] : []);
    expect(text).toBe('[Unit 7] replied');
    expect(counts.unresolved_tags).toEqual([]);
  });

  it('never restores a rename two people share, and says which', () => {
    const shared = parseCorrespondenceCsv(
      'placeholder,label,category,original\n[Person 1],[Witness],Person,Bob Marsh\n[Person 2],[Witness],Person,Carla Diaz\n',
    );
    const { text, counts } = restoreText('[Witness] saw [Person 1] and [Person 2].', shared);
    expect(text).toBe('[Witness] saw Bob Marsh and Carla Diaz.');
    expect(counts.ambiguous_tags).toEqual(['[Witness]']);
    expect(counts.unresolved_tags).toEqual([]);
    expect(counts.replacements).toBe(2);
  });

  it('two rows naming the same original are not ambiguous', () => {
    const same = parseCorrespondenceCsv(
      'placeholder,label,category,original\n[Person 1],[Seller],Person,Bob Marsh\n[Person 2],[Seller],Person,Bob Marsh\n',
    );
    const { text, counts } = restoreText('[Seller]', same);
    expect(text).toBe('Bob Marsh');
    expect(counts.ambiguous_tags).toEqual([]);
  });

  it('a file that already holds names never gets one reported back', () => {
    // Restoring twice: the second input is the first output.
    const [row] = parseCorrespondenceCsv('placeholder,label,category,original\n[Org 1],,Organization,[Unit 7] Keller\n');
    const table = row ? [row] : [];
    const once = restoreText('[Org 1] replied', table);
    expect(once.text).toBe('[Unit 7] Keller replied');
    const twice = restoreText(once.text, table);
    expect(twice.counts.unresolved_tags).toEqual([]);
    expect(twice.counts.ambiguous_tags).toEqual([]);
  });

  it('reports a renamed tag that has no stored original', () => {
    const [row] = parseCorrespondenceCsv('placeholder,label,category,original\n[Person 4],[Buyer],Person,\n');
    const { text, counts } = restoreText('[Buyer] paid', row ? [row] : []);
    expect(text).toBe('[Buyer] paid');
    expect(counts.unresolved_tags).toEqual(['[Buyer]']);
  });

  it('does not report ordinary bracketed text as a tag', () => {
    expect(restoreText('see [the annex] and [1]', table).counts.unresolved_tags).toEqual([]);
  });

  it('writes the original literally, even with $ patterns', () => {
    const [row] = parseCorrespondenceCsv('placeholder,label,category,original\n[Person 1],,Person,$& Co $1\n');
    expect(restoreText('[Person 1]', row ? [row] : []).text).toBe('$& Co $1');
  });
});

describe('restoring a .docx', () => {
  const table = parseCorrespondenceCsv(CSV);

  async function restoredFixture() {
    const input = new Uint8Array(await readFile(join(FIXTURES, 'tagged.docx')));
    return { input, ...restoreDocx(input, table) };
  }

  function part(bytes: Uint8Array, name: string): string {
    const entry = readZip(bytes).find((e) => e.name === name);
    if (!entry) throw new Error(`no ${name}`);
    return new TextDecoder().decode(entryData(entry));
  }

  it('restores tags in the body and headers, including a tag split across runs', async () => {
    const { bytes, counts } = await restoredFixture();
    const body = part(bytes, 'word/document.xml');
    // An edited run keeps its formatting (the bold) and is told to keep spaces.
    expect(body).toContain('<w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Anna Keller</w:t>');
    expect(body).toContain(' sold the flat to Acme &amp; Söhne AG.');
    // "[Per" + "son 1" + "]" in three runs: the name lands in the first one.
    expect(body).toContain('<w:t xml:space="preserve">Signed by Anna Keller</w:t>');
    expect(body).toContain(' and Anna Keller &amp; witnesses; see [Person 10].');
    expect(part(bytes, 'word/header1.xml')).toContain('Case of Anna Keller');
    // What Word shows: the runs' text, in order. Nothing of a split tag survives.
    const shown = [...body.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('');
    expect(shown).toBe(
      'Summary: Anna Keller sold the flat to Acme &amp; Söhne AG.Signed by Anna Keller and Anna Keller &amp; witnesses; see [Person 10].',
    );
    expect(counts.replacements).toBe(5);
    expect(counts.tags_restored).toBe(3);
    expect(counts.unresolved_tags).toEqual(['[Person 10]']);
  });

  it('copies the parts it does not touch byte for byte', async () => {
    const { input, bytes } = await restoredFixture();
    const before = readZip(input);
    const after = readZip(bytes);
    expect(after.map((e) => e.name)).toEqual(before.map((e) => e.name));
    // The footer is a text part too, but has no tag: it must not be re-deflated.
    for (const name of ['[Content_Types].xml', '_rels/.rels', 'word/media/image1.png', 'word/footer1.xml']) {
      const a = before.find((e) => e.name === name);
      const b = after.find((e) => e.name === name);
      expect(Buffer.from(b?.compressed ?? []).equals(Buffer.from(a?.compressed ?? [0]))).toBe(true);
      expect(b?.method).toBe(a?.method);
      expect(b?.crc).toBe(a?.crc);
    }
  });

  it('writes a zip whose CRCs check out, in the central directory and every local header', async () => {
    const { bytes } = await restoredFixture();
    const entries = readZip(bytes);
    for (const entry of entries) expect(crc32(entryData(entry))).toBe(entry.crc);
    // Walk the local headers as a streaming reader (and Word) would.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;
    for (const entry of entries) {
      expect(view.getUint32(offset, true)).toBe(0x04034b50);
      expect(view.getUint32(offset + 14, true)).toBe(entry.crc);
      expect(view.getUint32(offset + 18, true)).toBe(entry.compressed.length);
      expect(view.getUint32(offset + 22, true)).toBe(entry.size);
      offset += 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true) + entry.compressed.length;
    }
  });

  it('a .docx with no tag comes back unchanged in content', async () => {
    const input = new Uint8Array(await readFile(join(FIXTURES, 'tagged.docx')));
    const { bytes, counts } = restoreDocx(input, []);
    expect(counts.replacements).toBe(0);
    expect(part(bytes, 'word/document.xml')).toBe(part(input, 'word/document.xml'));
  });

  it('refuses a file that is not a zip, and a zip that is not a Word document', () => {
    expect(() => restoreDocx(new TextEncoder().encode('Anna Keller, not a zip'), table)).toThrow(/not a zip archive/);
    expect(() => restoreDocx(writeZip([]), table)).toThrow(/no word\/document.xml/);
  });

  it('refuses a corrupt entry instead of writing garbage', async () => {
    const input = new Uint8Array(await readFile(join(FIXTURES, 'tagged.docx')));
    const entries = readZip(input).map((e) => (e.name === 'word/document.xml' ? { ...e, crc: (e.crc + 1) >>> 0 } : e));
    expect(() => restoreDocx(writeZip(entries), table)).toThrow(/checksum mismatch/);
  });

  it('refuses an encrypted entry and an unknown compression method', async () => {
    const input = new Uint8Array(await readFile(join(FIXTURES, 'tagged.docx')));
    const tweak = (change: Record<string, number>) =>
      writeZip(readZip(input).map((e) => (e.name === 'word/document.xml' ? { ...e, ...change } : e)));
    expect(() => restoreDocx(tweak({ flags: 0x1 }), table)).toThrow(/encrypted/);
    expect(() => restoreDocx(tweak({ method: 12 }), table)).toThrow(/compression method 12/);
  });

  describe('the size cap', () => {
    /** The fixture with word/document.xml replaced, and a cap that only that part can hit. */
    async function withDocument(change: (entry: ReturnType<typeof readZip>[number], data: Uint8Array) => object) {
      const input = new Uint8Array(await readFile(join(FIXTURES, 'tagged.docx')));
      const entries = readZip(input);
      const doc = entries.find((e) => e.name === 'word/document.xml');
      if (!doc) throw new Error('fixture has no document.xml');
      const data = entryData(doc);
      const others = entries.filter((e) => e !== doc).map((e) => Math.max(e.size, e.compressed.length));
      const cap = Math.max(...others) + 1;
      expect(data.length).toBeGreaterThan(cap);
      return { bytes: writeZip(entries.map((e) => (e === doc ? { ...e, ...change(e, data) } : e))), cap };
    }

    it('refuses a part whose declared size is over the cap, before inflating', async () => {
      const { bytes, cap } = await withDocument(() => ({}));
      expect(() => restoreDocx(bytes, table, { maxPartBytes: cap })).toThrow(/larger than/);
    });

    it('stops a part that declares a small size and inflates past the cap', async () => {
      const { bytes, cap } = await withDocument(() => ({ size: 10 }));
      expect(() => restoreDocx(bytes, table, { maxPartBytes: cap })).toThrow(/larger than/);
    });

    it('holds a stored part that lies about its size to the same cap', async () => {
      const { bytes, cap } = await withDocument((_, data) => ({ method: 0, compressed: data, size: 10 }));
      expect(() => restoreDocx(bytes, table, { maxPartBytes: cap })).toThrow(/larger than/);
    });

    it('leaves a real document alone at the default cap', async () => {
      const input = new Uint8Array(await readFile(join(FIXTURES, 'tagged.docx')));
      expect(restoreDocx(input, table).counts.replacements).toBe(5);
    });
  });

  it('crc32 matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('the restore_names tool', () => {
  it('writes <name>-restored.<ext> and returns only the path and counts', async () => {
    const answer = join(dir, 'answer.md');
    await writeFile(answer, '# Summary\n\n[Seller] sold to [Org 1]. [Person 9] is unknown.\n');
    const result = await call({ file_path: answer, correspondence_path: csvPath });
    const out = payload(result);

    expect(result.isError).toBeFalsy();
    expect(out.status).toBe('restored');
    expect(out.output_path).toBe(join(dir, 'answer-restored.md'));
    expect(out.replacements).toBe(2);
    expect(out.tags_restored).toBe(2);
    expect(out.unresolved_tags).toEqual(['[Person 9]']);
    expect(String(out.note)).toMatch(/do NOT open/);
    expect(Object.keys(out).sort()).toEqual(['note', 'output_path', 'replacements', 'status', 'tags_restored', 'unresolved_tags']);
    expect(await readFile(out.output_path as string, 'utf8')).toBe(
      '# Summary\n\nAnna Keller sold to Acme & Söhne AG. [Person 9] is unknown.\n',
    );
    // The input is left as the agent wrote it.
    expect(await readFile(answer, 'utf8')).toContain('[Seller]');
  });

  it('restores a .docx through the tool', async () => {
    const answer = join(dir, 'memo.docx');
    await writeFile(answer, await readFile(join(FIXTURES, 'tagged.docx')));
    const out = payload(await call({ file_path: answer, correspondence_path: csvPath }));

    expect(out.output_path).toBe(join(dir, 'memo-restored.docx'));
    expect(out.replacements).toBe(5);
    const restored = new Uint8Array(await readFile(out.output_path as string));
    expect(readZip(restored).some((e) => e.name === 'word/document.xml')).toBe(true);
  });

  it('says so when no tag was found, and omits unresolved_tags when there are none', async () => {
    const answer = join(dir, 'plain.txt');
    await writeFile(answer, 'Nothing tagged here.');
    const out = payload(await call({ file_path: answer, correspondence_path: csvPath }));

    expect(out.replacements).toBe(0);
    expect(out.unresolved_tags).toBeUndefined();
    expect(String(out.note)).toMatch(/brackets included/);
  });

  it('never overwrites an existing file', async () => {
    const answer = join(dir, 'answer.txt');
    await writeFile(answer, '[Person 1]');
    await writeFile(join(dir, 'answer-restored.txt'), 'mine');
    const result = await call({ file_path: answer, correspondence_path: csvPath });

    expect(result.isError).toBe(true);
    expect(String(payload(result).error)).toMatch(/already exists/);
    expect(await readFile(join(dir, 'answer-restored.txt'), 'utf8')).toBe('mine');
  });

  it('honours output_path, but never onto the input or the table', async () => {
    const answer = join(dir, 'answer.txt');
    await writeFile(answer, '[Person 1]');
    const target = join(dir, 'final.txt');
    expect(payload(await call({ file_path: answer, correspondence_path: csvPath, output_path: target })).output_path).toBe(target);
    expect(await readFile(target, 'utf8')).toBe('Anna Keller');

    for (const output_path of [answer, csvPath]) {
      const result = await call({ file_path: answer, correspondence_path: csvPath, output_path });
      expect(result.isError).toBe(true);
      expect(String(payload(result).error)).toMatch(/must be a new file/);
    }
    expect(await readFile(csvPath, 'utf8')).toBe(CSV);
  });

  it('refuses a format it cannot rewrite safely', async () => {
    const answer = join(dir, 'answer.json');
    await writeFile(answer, '{"who": "[Person 1]"}');
    const result = await call({ file_path: answer, correspondence_path: csvPath });
    expect(result.isError).toBe(true);
    expect(String(payload(result).error)).toMatch(/\.md, \.markdown, \.txt, \.docx/);
  });

  it('a missing file or table is an error naming the path only', async () => {
    const answer = join(dir, 'answer.md');
    await writeFile(answer, '[Person 1]');
    const noTable = await call({ file_path: answer, correspondence_path: join(dir, 'nope.csv') });
    expect(noTable.isError).toBe(true);
    expect(String(payload(noTable).error)).toMatch(/correspondence table .*nope\.csv.*ENOENT/);

    const noFile = await call({ file_path: join(dir, 'gone.md'), correspondence_path: csvPath });
    expect(noFile.isError).toBe(true);
    expect(String(payload(noFile).error)).toMatch(/gone\.md/);
  });

  it('a table that is the wrong file, or empty, is refused without echoing it', async () => {
    const answer = join(dir, 'answer.md');
    await writeFile(answer, '[Person 1]');
    const wrong = join(dir, 'contacts.csv');
    await writeFile(wrong, 'name,email\nAnna Keller,anna@keller.ch\n');
    const result = await call({ file_path: answer, correspondence_path: wrong });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('anna@keller.ch');

    const empty = join(dir, 'empty.csv');
    await writeFile(empty, 'placeholder,label,category,original\n');
    const none = await call({ file_path: answer, correspondence_path: empty });
    expect(none.isError).toBe(true);
    expect(String(payload(none).error)).toMatch(/no rows/);
  });

  it('a broken .docx is an error, not a half-written file', async () => {
    const answer = join(dir, 'broken.docx');
    await writeFile(answer, 'Anna Keller, not a zip');
    const result = await call({ file_path: answer, correspondence_path: csvPath });
    expect(result.isError).toBe(true);
    await expect(readFile(join(dir, 'broken-restored.docx'))).rejects.toThrow();
  });

  it('reports ambiguous tags through the tool, names never', async () => {
    const shared = join(dir, 'shared.csv');
    await writeFile(shared, 'placeholder,label,category,original\n[Person 1],[Witness],Person,Bob Marsh\n[Person 2],[Witness],Person,Carla Diaz\n');
    const answer = join(dir, 'w.md');
    await writeFile(answer, '[Witness] testified.');
    const out = payload(await call({ file_path: answer, correspondence_path: shared }));

    expect(out.ambiguous_tags).toEqual(['[Witness]']);
    expect(String(out.ambiguous_note)).toMatch(/more than one person/);
    expect(await readFile(out.output_path as string, 'utf8')).toBe('[Witness] testified.');
  });

  it('restoring an already-restored file reports no original', async () => {
    const table = join(dir, 'unit.csv');
    await writeFile(table, 'placeholder,label,category,original\n[Org 1],,Organization,[Unit 7] Keller\n');
    const answer = join(dir, 'u.md');
    await writeFile(answer, '[Org 1] replied.');
    const first = payload(await call({ file_path: answer, correspondence_path: table }));
    const second = payload(await call({ file_path: first.output_path as string, correspondence_path: table }));
    expect(second.unresolved_tags).toBeUndefined();
  });

  it('restoredPath keeps the extension', () => {
    expect(restoredPath('/a/b/answer.md')).toBe('/a/b/answer-restored.md');
    expect(restoredPath('/a/b/memo.docx')).toBe('/a/b/memo-restored.docx');
  });
});
