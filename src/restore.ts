/**
 * Re-identification, on the user's machine only: put the real names back into
 * a file the agent wrote from a pseudonymized document.
 *
 * The whole point of pseudonymizing first is that the model never sees the
 * names. So everything here is shaped around one rule: an original value from
 * the correspondence table never leaves this module, not in a result, not in
 * an error message. Callers get the output path and counts, nothing else.
 */

import { basename, dirname, extname, join } from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { RedactPdfError } from './errors.js';

/** One tag -> original pair, from either column of the table. */
export interface Correspondence {
  /** Tag as drawn when not renamed, e.g. "[Person 1]". */
  placeholder: string;
  /** The user's rename as drawn, e.g. "[Seller]", or "" if none. */
  label: string;
  /** The real text. Personal data: never returned, never logged. */
  original: string;
}

export const RESTORABLE_EXTENSIONS = ['.md', '.markdown', '.txt', '.docx'] as const;

/** `/a/answer.md` -> `/a/answer-restored.md` */
export function restoredPath(inputPath: string): string {
  const ext = extname(inputPath);
  return join(dirname(inputPath), `${basename(inputPath, ext)}-restored${ext}`);
}

/**
 * Parse the CSV the API serves (placeholder,label,category,original), RFC 4180
 * quoting, optional BOM. Errors name the line, never its content.
 */
export function parseCorrespondenceCsv(csv: string): Correspondence[] {
  const rows = parseCsvRows(csv.replace(/^﻿/, ''));
  const header = rows.shift()?.map((cell) => cell.trim().toLowerCase());
  const at = (name: string) => header?.indexOf(name) ?? -1;
  const [iPlaceholder, iLabel, iOriginal] = [at('placeholder'), at('label'), at('original')];
  if (iPlaceholder < 0 || iOriginal < 0) {
    throw new RedactPdfError(
      'This is not a correspondence table: the first line must name the columns placeholder,label,category,original. Pass the correspondence_path a pseudonymize run returned.',
      { code: 'invalid_request' },
    );
  }
  return rows
    .filter((row) => row.some((cell) => cell !== ''))
    .map((row) => ({
      placeholder: unCsvSafe(row[iPlaceholder] ?? ''),
      label: iLabel >= 0 ? unCsvSafe(row[iLabel] ?? '') : '',
      original: unCsvSafe(row[iOriginal] ?? ''),
    }));
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (quoted) {
    throw new RedactPdfError(
      `The correspondence table is malformed (an unclosed quote on line ${rows.length + 1}). Download it again with download_correspondence.`,
      { code: 'invalid_request' },
    );
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** The API prefixes values starting with = + - @ tab CR with "'" (Excel formula guard). */
function unCsvSafe(value: string): string {
  return /^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value;
}

export interface RestoreCounts {
  /** Tag occurrences replaced by a real name. */
  replacements: number;
  /** Distinct tags of the table found and restored. */
  tags_restored: number;
  /** Tags found in the file that the table cannot restore (unknown, or no stored original). Tags only. */
  unresolved_tags: string[];
  /**
   * Tags found in the file that the table maps to MORE than one original (two
   * people both renamed "[Witness]" in the Studio). Left in place: picking one
   * would silently put the wrong name on the other. Tags only.
   */
  ambiguous_tags: string[];
}

/** The table, prepared once per restore: what to replace, and what to report. */
interface Restorer {
  /** Tag text -> original; both the placeholder and the rename restore. */
  lookup: Map<string, string>;
  /** Tags with more than one distinct original: never restored. */
  ambiguous: Set<string>;
  /** Every tag the table's tag columns name. */
  known: Set<string>;
  originals: string[];
  pattern: RegExp | null;
}

function prepare(table: Correspondence[]): Restorer {
  const candidates = new Map<string, Set<string>>();
  for (const row of table) {
    if (!row.original) continue;
    for (const tag of [row.placeholder, row.label]) {
      if (!tag || !isTag(tag)) continue;
      const originals = candidates.get(tag) ?? new Set<string>();
      originals.add(row.original);
      candidates.set(tag, originals);
    }
  }
  const lookup = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const [tag, originals] of candidates) {
    if (originals.size === 1) lookup.set(tag, [...originals][0] as string);
    else ambiguous.add(tag);
  }
  return {
    lookup,
    ambiguous,
    known: new Set(table.flatMap((row) => [row.placeholder, row.label]).filter(isTag)),
    originals: table.map((row) => row.original).filter(Boolean),
    pattern: tagPattern(lookup.keys()),
  };
}

const emptyCounts = (): RestoreCounts => ({ replacements: 0, tags_restored: 0, unresolved_tags: [], ambiguous_tags: [] });

function isTag(text: string): boolean {
  return text.length > 2 && text.startsWith('[') && text.endsWith(']');
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A tag as written: "[Person 1]", or Markdown-escaped "\[Person 1\]". The
 * inner text must match exactly, so "[Person 1]" never eats "[Person 10]".
 */
function tagPattern(tags: Iterable<string>): RegExp | null {
  const alternatives = [...tags]
    .sort((a, b) => b.length - a.length)
    .map((tag) => `\\\\?\\[${escapeRegExp(tag.slice(1, -1))}\\\\?\\]`);
  return alternatives.length ? new RegExp(alternatives.join('|'), 'gu') : null;
}

/** What a default tag looks like ("[Person 1]", "[Personne 12]"), for reporting leftovers. */
const TAG_SHAPE = /\\?\[(\p{L}[\p{L}\p{M}.' -]{0,40}? \d{1,4})\\?\]/gu;

function normalizeTag(match: string): string {
  return match.replace(/\\/g, '');
}

/** Replace every tag in a plain string. */
export function restoreText(text: string, table: Correspondence[]): { text: string; counts: RestoreCounts } {
  const restorer = prepare(table);
  const counts = emptyCounts();
  const restored = new Set<string>();
  const out = restorer.pattern
    ? text.replace(restorer.pattern, (match) => {
        const tag = normalizeTag(match);
        const original = restorer.lookup.get(tag);
        if (original === undefined) return match;
        counts.replacements++;
        restored.add(tag);
        return original;
      })
    : text;
  counts.tags_restored = restored.size;
  addUnresolved(text, restorer, counts);
  return { text: out, counts };
}

/**
 * Tags in the agent's own text that the table cannot restore. Scanned on the
 * INPUT, never the output, and never anything that occurs inside an original:
 * the input can itself hold names (an already-restored file passed back in),
 * and an original shaped like a tag ("[Unit 7] Keller") must not be reported
 * to the model.
 */
function addUnresolved(text: string, restorer: Restorer, counts: RestoreCounts): void {
  const unresolved = new Set(counts.unresolved_tags);
  const ambiguous = new Set(counts.ambiguous_tags);
  const consider = (tag: string) => {
    if (restorer.lookup.has(tag)) return;
    if (restorer.originals.some((original) => original.includes(tag))) return;
    (restorer.ambiguous.has(tag) ? ambiguous : unresolved).add(tag);
  };
  // Only tag-shaped leftovers, and tags the table's own columns name: never
  // arbitrary bracketed text.
  for (const match of text.matchAll(TAG_SHAPE)) consider(normalizeTag(match[0]));
  for (const tag of restorer.known) if (text.includes(tag)) consider(tag);
  counts.unresolved_tags = [...unresolved].sort();
  counts.ambiguous_tags = [...ambiguous].sort();
}

// ---- .docx ------------------------------------------------------------------

/**
 * Ceiling on one inflated text part. A real document.xml is a few MB even for
 * a long contract; a crafted entry (a zip bomb) could inflate to gigabytes and
 * take the local server down with it.
 */
export const MAX_DOCX_PART_BYTES = 64 * 1024 * 1024;

/** The parts of a .docx that hold body text a user would read. */
const DOCX_TEXT_PART = /^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/;

/**
 * Restore tags inside a .docx (Office Open XML).
 *
 * Word splits text into runs freely, so "[Person 1]" can arrive as
 * `<w:t>[Person </w:t>…<w:t>1]</w:t>`. Matching runs over the concatenated
 * text of a part and writing each name into the run where its tag started
 * handles that; untouched runs keep their bytes.
 */
export function restoreDocx(
  bytes: Uint8Array,
  table: Correspondence[],
  { maxPartBytes = MAX_DOCX_PART_BYTES }: { maxPartBytes?: number } = {},
): { bytes: Uint8Array; counts: RestoreCounts } {
  const entries = readZip(bytes);
  const restorer = prepare(table);
  const restored = new Set<string>();
  const counts = emptyCounts();
  let sawDocument = false;

  const out = entries.map((entry) => {
    if (!DOCX_TEXT_PART.test(entry.name)) return entry;
    if (entry.name === 'word/document.xml') sawDocument = true;
    const xml = new TextDecoder().decode(entryData(entry, maxPartBytes));
    const { xml: replaced, text } = restoreWordXml(xml, restorer, counts, restored);
    addUnresolved(text, restorer, counts);
    return replaced === xml ? entry : withData(entry, new TextEncoder().encode(replaced));
  });
  if (!sawDocument) {
    throw new RedactPdfError('This .docx has no word/document.xml: it is not a Word document.', { code: 'invalid_request' });
  }
  counts.tags_restored = restored.size;
  return { bytes: writeZip(out), counts };
}

const W_T = /<w:t(\s[^>]*)?>([^<]*)<\/w:t>/g;

function restoreWordXml(
  xml: string,
  { lookup, pattern }: Restorer,
  counts: RestoreCounts,
  restored: Set<string>,
): { xml: string; text: string } {
  // `text` is the part's text as the agent wrote it (before any restore), for
  // addUnresolved.
  const nodes = [...xml.matchAll(W_T)].map((m) => ({
    index: m.index,
    length: m[0].length,
    attrs: m[1] ?? '',
    text: decodeXml(m[2] ?? ''),
  }));
  const joined = nodes.map((n) => n.text).join('');
  if (!pattern || nodes.length === 0) return { xml, text: joined };

  // Where each node's text starts in `joined`.
  const starts: number[] = [];
  let offset = 0;
  for (const node of nodes) {
    starts.push(offset);
    offset += node.text.length;
  }
  const nodeAt = (pos: number) => {
    let lo = 0;
    let hi = nodes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] as number) <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const texts = nodes.map((n) => n.text);
  const changed = new Set<number>();
  // Right to left, so earlier offsets stay valid while later text is rewritten.
  const matches = [...joined.matchAll(pattern)].reverse();
  for (const match of matches) {
    const tag = normalizeTag(match[0]);
    const original = lookup.get(tag);
    if (original === undefined) continue;
    const start = match.index;
    const end = start + match[0].length;
    const first = nodeAt(start);
    const last = nodeAt(end - 1);
    const head = (texts[first] as string).slice(0, start - (starts[first] as number));
    const tail = (texts[last] as string).slice(end - (starts[last] as number));
    if (first === last) {
      texts[first] = head + original + tail;
    } else {
      texts[first] = head + original;
      for (let i = first + 1; i < last; i++) texts[i] = '';
      texts[last] = tail;
    }
    for (let i = first; i <= last; i++) changed.add(i);
    counts.replacements++;
    restored.add(tag);
  }
  if (changed.size === 0) return { xml, text: joined };

  let result = '';
  let cursor = 0;
  nodes.forEach((node, i) => {
    if (!changed.has(i)) return;
    result += xml.slice(cursor, node.index);
    // Edits can leave a run starting or ending in a space, which Word drops
    // unless told to keep it.
    const attrs = /xml:space=/.test(node.attrs) ? node.attrs : `${node.attrs} xml:space="preserve"`;
    result += `<w:t${attrs}>${encodeXml(texts[i] as string)}</w:t>`;
    cursor = node.index + node.length;
  });
  result += xml.slice(cursor);
  return { xml: result, text: joined };
}

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, ref: string) => {
    if (ref === 'amp') return '&';
    if (ref === 'lt') return '<';
    if (ref === 'gt') return '>';
    if (ref === 'quot') return '"';
    if (ref === 'apos') return "'";
    const code = ref.startsWith('#x') ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    return String.fromCodePoint(code);
  });
}

function encodeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---- Minimal zip (stored + deflate, no zip64, no encryption) ----------------
// Enough for a .docx, without adding a dependency to a package users run via
// npx. Entries we do not change are copied byte for byte, compressed data and
// CRC included.

interface ZipEntry {
  name: string;
  nameBytes: Uint8Array;
  flags: number;
  method: number;
  time: number;
  date: number;
  crc: number;
  compressed: Uint8Array;
  size: number;
  internalAttrs: number;
  externalAttrs: number;
}

const notADocx = (why: string) =>
  new RedactPdfError(`Could not read this .docx (${why}). Save it again from Word, or write the answer as .md or .txt instead.`, {
    code: 'invalid_request',
  });

export function readZip(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw notADocx('not a zip archive');
  const count = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  if (count === 0xffff || cursor === 0xffffffff) throw notADocx('zip64 archives are not supported');

  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== 0x02014b50) throw notADocx('corrupt central directory');
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const csize = view.getUint32(cursor + 20, true);
    const nameLen = view.getUint16(cursor + 28, true);
    const extraLen = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);
    const local = view.getUint32(cursor + 42, true);
    const nameBytes = bytes.slice(cursor + 46, cursor + 46 + nameLen);
    if (flags & 0x1) throw notADocx('it is encrypted');
    if (method !== 0 && method !== 8) throw notADocx(`unsupported compression method ${method}`);
    if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) throw notADocx('corrupt entry');
    const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (dataStart + csize > bytes.length) throw notADocx('truncated entry');
    entries.push({
      name: new TextDecoder().decode(nameBytes),
      nameBytes,
      flags,
      method,
      time: view.getUint16(cursor + 12, true),
      date: view.getUint16(cursor + 14, true),
      crc: view.getUint32(cursor + 16, true),
      compressed: bytes.slice(dataStart, dataStart + csize),
      size: view.getUint32(cursor + 24, true),
      internalAttrs: view.getUint16(cursor + 36, true),
      externalAttrs: view.getUint32(cursor + 38, true),
    });
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function entryData(entry: ZipEntry, maxBytes: number = MAX_DOCX_PART_BYTES): Uint8Array {
  // The declared size first, then a hard cap on inflation, since the declared
  // size is the attacker's to lie about.
  if (entry.size > maxBytes || (entry.method === 0 && entry.compressed.length > maxBytes)) {
    throw notADocx(`a part is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
  }
  let data: Uint8Array;
  try {
    data =
      entry.method === 8
        ? new Uint8Array(inflateRawSync(entry.compressed, { maxOutputLength: maxBytes }))
        : entry.compressed;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code === 'ERR_BUFFER_TOO_LARGE') {
      throw notADocx(`a part is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
    }
    throw notADocx('corrupt compressed data');
  }
  if (crc32(data) !== entry.crc) throw notADocx('checksum mismatch');
  return data;
}

function withData(entry: ZipEntry, data: Uint8Array): ZipEntry {
  return {
    ...entry,
    // Sizes and CRC are written in the local header below, so no data descriptor.
    flags: entry.flags & ~0x8,
    method: 8,
    crc: crc32(data),
    compressed: new Uint8Array(deflateRawSync(data)),
    size: data.length,
  };
}

export function writeZip(entries: ZipEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const flags = entry.flags & ~0x8;
    const local = new Uint8Array(30 + entry.nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, entry.method, true);
    lv.setUint16(10, entry.time, true);
    lv.setUint16(12, entry.date, true);
    lv.setUint32(14, entry.crc, true);
    lv.setUint32(18, entry.compressed.length, true);
    lv.setUint32(22, entry.size, true);
    lv.setUint16(26, entry.nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(entry.nameBytes, 30);

    const cd = new Uint8Array(46 + entry.nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, entry.method, true);
    cv.setUint16(12, entry.time, true);
    cv.setUint16(14, entry.date, true);
    cv.setUint32(16, entry.crc, true);
    cv.setUint32(20, entry.compressed.length, true);
    cv.setUint32(24, entry.size, true);
    cv.setUint16(28, entry.nameBytes.length, true);
    cv.setUint16(36, entry.internalAttrs, true);
    cv.setUint32(38, entry.externalAttrs, true);
    cv.setUint32(42, offset, true);
    cd.set(entry.nameBytes, 46);

    chunks.push(local, entry.compressed);
    central.push(cd);
    offset += local.length + entry.compressed.length;
  }
  const cdSize = central.reduce((sum, c) => sum + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  return Buffer.concat([...chunks, ...central, end]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
