/**
 * Guarded outbound fetching for caller-supplied URLs.
 *
 * `file_url` is an argument chosen by a model, on a server that may be hosted
 * and reachable by anyone. Fetching it naively turns this process into an SSRF
 * proxy: the request leaves from inside our network, so `http://169.254.169.254/`
 * or `http://10.0.0.5:6379/` are reachable in a way they are not from the
 * caller. Redirects make it worse — validating only the URL the caller typed is
 * pointless when a public host can 302 to a private one.
 *
 * So: resolve every hop's hostname, refuse any address that is not public,
 * follow redirects manually so each hop gets the same treatment, and bound both
 * the time and the number of bytes.
 *
 * Residual risk, stated plainly: this resolves the hostname and judges the
 * addresses it gets back, but the socket resolves the name AGAIN when it
 * connects. A DNS-rebinding attacker with a short TTL can therefore have us
 * validate a public address and connect to a private one — the verdict this
 * module produces never reaches the socket. Closing it requires pinning the
 * connection to the validated address (a dispatcher with a fixed `lookup`),
 * which is not implemented.
 *
 * Because of that gap, the hosted server does not accept URL input at all
 * unless an operator sets REDACT_PDF_ENABLE_URL_INPUT=1 (see server.ts). This
 * module is still the right guard for stdio, where the fetch happens on the
 * user's own machine, and for operators who opt in behind their own egress
 * controls. REDACT_PDF_ALLOW_PRIVATE_URLS=1 additionally permits private
 * addresses for self-hosters fetching from internal storage.
 */

import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { RedactPdfError } from './errors.js';

/** Redirect hops to follow before giving up. */
const MAX_REDIRECTS = 3;

/**
 * Escape hatch for self-hosted deployments whose documents legitimately live on
 * an internal host. Off by default: the hosted server must never set it.
 */
function privateUrlsAllowed(): boolean {
  return process.env.REDACT_PDF_ALLOW_PRIVATE_URLS === '1';
}

/**
 * True for addresses that are not routable on the public internet, and so must
 * not be reachable through a caller-supplied URL: loopback, RFC1918, CGNAT,
 * link-local (including the cloud metadata endpoint at 169.254.169.254),
 * multicast, broadcast, and the IPv6 equivalents.
 */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateIPv4(address);
  if (version === 6) return isPrivateIPv6(address);
  return true; // Unparseable: fail closed.
}

function isPrivateIPv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  return isPrivateIPv4Bytes(parts as [number, number, number, number]);
}

function isPrivateIPv4Bytes(bytes: [number, number, number, number]): boolean {
  const [a, b] = bytes;
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  // Only these two /24s inside 192.0.0.0/16 are reserved; the rest of the /16 is
  // globally routable and must stay reachable.
  if (a === 192 && b === 0 && (bytes[2] === 0 || bytes[2] === 2)) return true;
  if (a === 192 && b === 88 && bytes[2] === 99) return true; // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/**
 * Expand an IPv6 address to its 16 bytes.
 *
 * Prefix matching on the textual form is not good enough: the same address has
 * many spellings, and `::ffff:7f00:1` (loopback) shares no prefix with
 * `::ffff:127.0.0.1`. Judging the bytes is the only way to be sure two
 * spellings of one address get the same answer.
 */
export function ipv6ToBytes(address: string): number[] | null {
  const zoneParts = address.toLowerCase().split('%');
  // At most one zone id, and the address itself must be non-empty.
  if (zoneParts.length > 2 || !zoneParts[0]) return null;
  let text = zoneParts[0];
  // A single leading or trailing colon is only legal as part of "::"; the
  // permissive strips below would otherwise turn ":::" and ":1:2:..." into
  // valid addresses that isIP rejects.
  if (/^:[^:]/.test(text) || /[^:]:$/.test(text) || /^:::/.test(text) || /:::$/.test(text)) {
    return null;
  }

  // A trailing dotted quad (::ffff:127.0.0.1) becomes two hextets.
  const dotted = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (dotted?.[1]) {
    const quad = dotted[1].split('.').map((n) => Number.parseInt(n, 10));
    if (quad.length !== 4 || quad.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = ((quad[0] as number) << 8) | (quad[1] as number);
    const lo = ((quad[2] as number) << 8) | (quad[3] as number);
    text = `${text.slice(0, dotted.index)}:${hi.toString(16)}:${lo.toString(16)}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;

  const parseGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const groups: number[] = [];
    for (const chunk of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(chunk)) return null;
      groups.push(Number.parseInt(chunk, 16));
    }
    return groups;
  };

  const head = parseGroups(halves[0]?.replace(/^:/, '') ?? '');
  const tail = halves.length === 2 ? parseGroups(halves[1]?.replace(/:$/, '') ?? '') : [];
  if (!head || !tail) return null;

  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const group of groups) {
    bytes.push((group >> 8) & 0xff, group & 0xff);
  }
  return bytes;
}

function isPrivateIPv6(address: string): boolean {
  const bytes = ipv6ToBytes(address);
  if (!bytes) return true; // Unparseable: fail closed.

  const isZeroPrefix = (upTo: number): boolean => bytes.slice(0, upTo).every((b) => b === 0);

  // ::  and ::1
  if (isZeroPrefix(15)) return true;
  // ::ffff:a.b.c.d and ::ffff:0:a.b.c.d — IPv4-mapped / translated. Judge the
  // embedded IPv4 address, whichever spelling it arrived in.
  if (isZeroPrefix(10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPrivateIPv4Bytes(bytes.slice(12, 16) as [number, number, number, number]);
  }
  // ::ffff:0:a.b.c.d — IPv4-translated (RFC 2765); the ffff marker sits two
  // bytes earlier than in the mapped form, so it needs its own test.
  if (
    isZeroPrefix(8) && bytes[8] === 0xff && bytes[9] === 0xff &&
    bytes[10] === 0 && bytes[11] === 0
  ) {
    return isPrivateIPv4Bytes(bytes.slice(12, 16) as [number, number, number, number]);
  }
  // ::a.b.c.d — deprecated IPv4-compatible, same treatment.
  if (isZeroPrefix(12)) {
    return isPrivateIPv4Bytes(bytes.slice(12, 16) as [number, number, number, number]);
  }
  // 64:ff9b::/96 — NAT64, forwards to the embedded IPv4 address.
  if (
    bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((b) => b === 0)
  ) {
    return isPrivateIPv4Bytes(bytes.slice(12, 16) as [number, number, number, number]);
  }

  const first = bytes[0] as number;
  const second = bytes[1] as number;

  // 2002::/16 — 6to4. Bytes 2-5 are the IPv4 address the relay forwards to, so
  // 2002:7f00:1:: is a spelling of 127.0.0.1. Note the v4 half of this same
  // mechanism (192.88.99.0/24) is already blocked; this is the other half.
  if (first === 0x20 && second === 0x02) {
    return isPrivateIPv4Bytes(bytes.slice(2, 6) as [number, number, number, number]);
  }
  // 64:ff9b:1::/48 — RFC 8215 local-use NAT64. Reserved specifically for
  // on-premise NAT64, i.e. exactly the deployments sitting next to internal
  // storage. RFC 6052 allows several prefix lengths, so rather than decode each
  // offset, refuse the whole range: it is never a legitimate document host.
  if (first === 0x00 && second === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) return true;
  // 2001::/32 — Teredo; bytes 8-11 hold an obfuscated client IPv4.
  if (first === 0x20 && second === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return true;

  if (first === 0xfe && (second & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (first === 0xfe && (second & 0xc0) === 0xc0) return true; // fec0::/10 site-local (deprecated, still routed on-link)
  if ((first & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (first === 0xff) return true; // ff00::/8 multicast
  return false;
}

/**
 * Reject a URL that resolves anywhere non-public.
 *
 * Every address the hostname resolves to is checked, not just the first — a
 * hostname with both a public and a private A record must not be usable to
 * reach the private one.
 */
export async function assertPublicUrl(
  url: URL,
  resolveHost: (hostname: string) => Promise<string[]> = defaultResolve,
): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RedactPdfError(
      `Only http(s) URLs are supported, got "${url.protocol}".`,
      { code: 'invalid_request' },
    );
  }
  if (privateUrlsAllowed()) return;

  const hostname = url.hostname.replace(/^\[|\]$/g, '');

  // A literal IP needs no DNS round trip.
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw blockedHostError(url);
    return;
  }

  let addresses: string[];
  try {
    addresses = await resolveHost(hostname);
  } catch {
    throw new RedactPdfError(
      `Could not resolve the host in "${redactUrl(url)}".`,
      { code: 'invalid_request' },
    );
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) throw blockedHostError(url);
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((entry) => entry.address);
}

/**
 * One message for every blocked-host case.
 *
 * Deliberately uniform: a message that distinguished "refused" from "no such
 * host" from "404" would turn this tool into an internal-network scanner with
 * a convenient oracle.
 */
function blockedHostError(url: URL): RedactPdfError {
  return new RedactPdfError(
    `Refusing to fetch "${redactUrl(url)}": the URL must point at a public internet host. Provide a publicly reachable document URL, or send the file inline as base64.`,
    { code: 'invalid_request' },
  );
}

/** Host + path only — a caller-supplied URL may carry a token in its query. */
function redactUrl(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname}`;
}

export interface SafeFetchOptions {
  maxBytes: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  resolveHost?: (hostname: string) => Promise<string[]>;
}

export interface SafeFetchResult {
  bytes: Uint8Array;
  response: Response;
  finalUrl: URL;
}

/**
 * Fetch a caller-supplied URL with every hop validated and hard caps on time
 * and size.
 *
 * Redirects are followed manually (`redirect: 'manual'`) precisely so each
 * `Location` is re-validated — otherwise a public URL that redirects to
 * 169.254.169.254 would sail through the initial check.
 */
export async function safeFetchDocument(
  rawUrl: string,
  options: SafeFetchOptions,
): Promise<SafeFetchResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const signal = AbortSignal.timeout(options.timeoutMs);

  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    throw new RedactPdfError(`"${rawUrl}" is not a valid URL.`, { code: 'invalid_request' });
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicUrl(current, options.resolveHost);

    let response: Response;
    try {
      response = await fetchImpl(current.toString(), { redirect: 'manual', signal });
    } catch (cause) {
      throw new RedactPdfError(
        `Could not download "${redactUrl(current)}": ${describeFetchFailure(cause, options.timeoutMs)}`,
        { code: 'network_error', retryable: true },
      );
    }

    if (isRedirect(response.status)) {
      const location = response.headers.get('location');
      if (!location) {
        throw new RedactPdfError(
          `Could not download "${redactUrl(current)}": redirect with no target.`,
          { code: 'invalid_request' },
        );
      }
      try {
        current = new URL(location, current);
      } catch {
        throw new RedactPdfError(
          `Could not download "${redactUrl(current)}": invalid redirect target.`,
          { code: 'invalid_request' },
        );
      }
      continue;
    }

    if (!response.ok) {
      throw new RedactPdfError(
        `Could not download "${redactUrl(current)}": the server returned ${response.status}.`,
        { code: 'invalid_request' },
      );
    }

    return {
      bytes: await readCapped(response, options.maxBytes, current),
      response,
      finalUrl: current,
    };
  }

  throw new RedactPdfError(
    `Could not download "${redactUrl(current)}": too many redirects (limit ${MAX_REDIRECTS}).`,
    { code: 'invalid_request' },
  );
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Read a body, refusing to buffer more than `maxBytes`.
 *
 * `Content-Length` is checked first so an oversized-but-honest response costs
 * nothing, then the stream is counted as it arrives — a response with no
 * Content-Length, or a lying one, must not be able to grow the heap without
 * bound. This is the difference between a size limit and a suggestion.
 */
async function readCapped(response: Response, maxBytes: number, url: URL): Promise<Uint8Array> {
  const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge(url, maxBytes);

  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw tooLarge(url, maxBytes);
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) throw tooLarge(url, maxBytes);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function tooLarge(url: URL, maxBytes: number): RedactPdfError {
  return new RedactPdfError(
    `The document at "${redactUrl(url)}" is larger than the ${Math.floor(maxBytes / 1024 / 1024)} MB limit.`,
    { code: 'payload_too_large' },
  );
}

function describeFetchFailure(cause: unknown, timeoutMs: number): string {
  if (cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError')) {
    return `timed out after ${Math.round(timeoutMs / 1000)}s.`;
  }
  return cause instanceof Error ? `${cause.message}.` : `${String(cause)}.`;
}
