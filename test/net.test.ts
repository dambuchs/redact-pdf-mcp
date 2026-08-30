/**
 * Tests for the SSRF guard.
 *
 * These assert on the REASON a URL was refused, not merely that something
 * failed — a test that only checks `isError` passes even with the guard
 * deleted, because the fetch fails anyway.
 */

import { describe, expect, it, vi } from 'vitest';
import { assertPublicUrl, isPrivateAddress, safeFetchDocument } from '../src/net.js';
import { rejection } from './helpers.js';

const publicDns = async () => ['93.184.216.34'];

describe('isPrivateAddress', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['10.1.2.3', 'RFC1918'],
    ['172.16.0.1', 'RFC1918'],
    ['172.31.255.255', 'RFC1918'],
    ['192.168.1.1', 'RFC1918'],
    ['169.254.169.254', 'cloud metadata'],
    ['100.64.0.1', 'CGNAT'],
    ['0.0.0.0', 'this network'],
    ['224.0.0.1', 'multicast'],
    ['::1', 'IPv6 loopback'],
    ['fd00::1', 'IPv6 unique local'],
    ['fe80::1', 'IPv6 link-local'],
    ['::ffff:10.0.0.1', 'IPv4-mapped private'],
    ['not-an-ip', 'unparseable fails closed'],
  ])('blocks %s (%s)', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  // Every spelling of the same address must get the same answer. Prefix
  // matching on the text form got these wrong: ::ffff:7f00:1 is loopback, and
  // reaching it through the URL path really did read from 127.0.0.1.
  it.each([
    ['0:0:0:0:0:0:0:1', 'expanded loopback'],
    ['::ffff:7f00:1', 'IPv4-mapped loopback, hex form'],
    ['0:0:0:0:0:ffff:7f00:1', 'IPv4-mapped loopback, fully expanded'],
    ['::ffff:0:127.0.0.1', 'IPv4-translated loopback'],
    ['::ffff:a00:1', 'IPv4-mapped 10.0.0.1, hex form'],
    ['::ffff:a9fe:a9fe', 'IPv4-mapped cloud metadata'],
    ['::7f00:1', 'IPv4-compatible loopback'],
    ['64:ff9b::7f00:1', 'NAT64-embedded loopback'],
    ['FE80::1', 'uppercase link-local'],
    ['fe80::1%eth0', 'zone-scoped link-local'],
    ['not-an-ipv6', 'unparseable fails closed'],
    ['ff02::1', 'IPv6 multicast'],
    ['ff05::1:3', 'site-local multicast'],
    ['fec0::1', 'deprecated site-local'],
    ['feff::1', 'top of the site-local range'],
    ['2002:7f00:1::1', '6to4 wrapping 127.0.0.1'],
    ['2002:a9fe:a9fe::1', '6to4 wrapping cloud metadata'],
    ['2001::1', 'Teredo'],
    ['64:ff9b:1::a00:1', 'RFC 8215 local-use NAT64'],
  ])('blocks %s (%s)', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each([
    ['192.0.78.24', 'routable inside 192.0.0.0/16'],
    ['192.1.0.1', 'just outside the reserved /24s'],
  ])('allows %s (%s) — only 192.0.0.0/24 and 192.0.2.0/24 are reserved', (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });

  it.each([['192.0.0.1'], ['192.0.2.1'], ['192.88.99.1'], ['198.18.0.1']])(
    'still blocks the genuinely reserved %s',
    (address) => {
      expect(isPrivateAddress(address)).toBe(true);
    },
  );

  it.each([['93.184.216.34'], ['8.8.8.8'], ['2606:2800:220:1:248:1893:25c8:1946'], ['::ffff:8.8.8.8']])(
    'allows the public address %s',
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    },
  );

  it('allows 172.32.x, just outside the RFC1918 range', () => {
    expect(isPrivateAddress('172.32.0.1')).toBe(false);
  });
});

describe('assertPublicUrl', () => {
  it('rejects a non-http scheme by name, not by incidental fetch failure', async () => {
    const error = await rejection(assertPublicUrl(new URL('file:///etc/passwd'), publicDns));
    expect(error.message).toMatch(/Only http\(s\) URLs are supported/);
  });

  it('rejects the cloud metadata IP given literally', async () => {
    const error = await rejection(assertPublicUrl(new URL('http://169.254.169.254/'), publicDns));
    expect(error.message).toMatch(/must point at a public internet host/);
  });

  it('rejects a hostname that resolves to a private address', async () => {
    const error = await rejection(
      assertPublicUrl(new URL('https://internal.example.com/x.pdf'), async () => ['10.0.0.5']),
    );
    expect(error.message).toMatch(/must point at a public internet host/);
  });

  it('rejects a hostname with any private address among several', async () => {
    // A split-horizon record must not be usable to reach the private half.
    const error = await rejection(
      assertPublicUrl(new URL('https://mixed.example.com/x.pdf'), async () => [
        '93.184.216.34',
        '127.0.0.1',
      ]),
    );
    expect(error.message).toMatch(/must point at a public internet host/);
  });

  it('does not leak the query string, which may carry a token', async () => {
    const error = await rejection(
      assertPublicUrl(new URL('http://10.0.0.1/doc.pdf?token=supersecret'), publicDns),
    );
    expect(error.message).not.toContain('supersecret');
  });

  it('allows a genuinely public host', async () => {
    await expect(
      assertPublicUrl(new URL('https://example.com/a.pdf'), publicDns),
    ).resolves.toBeUndefined();
  });
});

describe('safeFetchDocument', () => {
  const opts = { maxBytes: 1024, timeoutMs: 1000, resolveHost: publicDns };

  it('re-validates the target of a redirect, so a public URL cannot bounce inward', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/creds' } }),
    );

    const error = await rejection(
      safeFetchDocument('https://example.com/a.pdf', {
        ...opts,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    );
    expect(error.message).toMatch(/must point at a public internet host/);
    // The redirect target was never fetched.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('stops after too many redirects', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: 'https://example.com/next' } }),
    );
    const error = await rejection(
      safeFetchDocument('https://example.com/a.pdf', {
        ...opts,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    );
    expect(error.message).toMatch(/too many redirects/);
  });

  it('refuses an oversized body declared up front, without reading it', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('x', { status: 200, headers: { 'content-length': '99999999' } }),
    );
    const error = await rejection(
      safeFetchDocument('https://example.com/a.pdf', {
        ...opts,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    );
    expect(error.code).toBe('payload_too_large');
  });

  it('aborts a body that lies about its size, rather than buffering it', async () => {
    // No content-length: the cap has to be enforced while streaming or it is
    // not a cap at all.
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(512));
      },
    });
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 200 }));

    const error = await rejection(
      safeFetchDocument('https://example.com/a.pdf', {
        ...opts,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    );
    expect(error.code).toBe('payload_too_large');
  });

  it.each([
    ['exactly at the limit', 1024, false],
    ['one byte over', 1025, true],
  ])('enforces the streaming cap %s', async (_label, size, shouldReject) => {
    // A finite body: the infinite-stream test passes for ANY cap, so it cannot
    // detect the limit being wrong by a factor of a thousand.
    const chunks = [new Uint8Array(size)];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    });
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 200 }));
    const call = safeFetchDocument('https://example.com/a.pdf', {
      ...opts,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    if (shouldReject) {
      expect((await rejection(call)).code).toBe('payload_too_large');
    } else {
      expect((await call).bytes.byteLength).toBe(size);
    }
  });

  it('refuses a hostname that resolves to nothing rather than allowing it', async () => {
    const error = await rejection(
      safeFetchDocument('https://example.com/a.pdf', {
        ...opts,
        resolveHost: async () => [],
        fetchImpl: vi.fn() as unknown as typeof fetch,
      }),
    );
    expect(error.message).toMatch(/must point at a public internet host/);
  });

  it.each([[301], [302], [303], [307], [308]])('re-validates a %i redirect', async (status) => {
    const fetchImpl = vi.fn(async () =>
      new Response(null, { status, headers: { location: 'http://127.0.0.1/x' } }),
    );
    const error = await rejection(
      safeFetchDocument('https://example.com/a.pdf', {
        ...opts,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    );
    expect(error.message).toMatch(/must point at a public internet host/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns the bytes for a well-behaved public document', async () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
    const result = await safeFetchDocument('https://example.com/a.pdf', {
      ...opts,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.bytes).toEqual(body);
  });

  it('passes an abort signal so a hung server cannot pin the request forever', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      // Manual redirect handling is what makes per-hop validation possible.
      expect(init?.redirect).toBe('manual');
      return new Response(new Uint8Array([1]), { status: 200 });
    });
    await safeFetchDocument('https://example.com/a.pdf', {
      ...opts,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalled();
  });
});
