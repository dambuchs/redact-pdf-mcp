/**
 * saveApiKey and the confirmation form below the MCP layer: the races between
 * checking a key and storing it, and how the form is asked.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { fetchMock, jsonResponse, rejection } from './helpers.js';
import { RedactPdfClient } from '../src/client.js';
import { keySource, readKeyFile, writeKeyFile, type KeySource } from '../src/key.js';
import { CONFIRM_TIMEOUT_MS, elicitConfirmSave, saveApiKey, type ConfirmSave } from '../src/server.js';

const KEY = 'rpk_abcdefghijklmnopqrstuvwxyz0123456789-_';
const OTHER = 'rpk_other_key_value_1';

let keys: KeySource;
let file: string;

beforeEach(async () => {
  file = join(await mkdtemp(join(tmpdir(), 'redact-save-')), 'redact-pdf-mcp', 'key');
  keys = keySource({}, file);
});

/** Every key is valid and belongs to user@example.com. */
const client = () =>
  new RedactPdfClient({
    fetchImpl: fetchMock(async () => jsonResponse({ user_id: 'u', email: 'user@example.com' })) as unknown as typeof fetch,
    sleep: async () => {},
  });

describe('saveApiKey races', () => {
  it('a confirmed first save does not overwrite a key saved while the user was answering', async () => {
    const confirm: ConfirmSave = async () => {
      await writeKeyFile(file, OTHER);
      return 'accepted';
    };
    const error = await rejection(saveApiKey(client(), keys, KEY, confirm));
    expect(error.code).toBe('not_confirmed');
    expect(error.message).toMatch(/changed while the user was confirming/);
    expect(readKeyFile(file)).toBe(OTHER);
  });

  it('a confirmed replacement does not overwrite a key changed while the user was answering', async () => {
    await writeKeyFile(file, 'rpk_first_saved_1');
    const confirm: ConfirmSave = async () => {
      await writeKeyFile(file, OTHER);
      return 'accepted';
    };
    await expect(saveApiKey(client(), keys, KEY, confirm)).rejects.toMatchObject({ code: 'not_confirmed' });
    expect(readKeyFile(file)).toBe(OTHER);
  });

  it('a confirmed save ends the session key, which would otherwise keep priority', async () => {
    await saveApiKey(client(), keys, OTHER);
    expect(keys.current()).toBe(OTHER);
    await saveApiKey(client(), keys, KEY, async () => 'accepted');
    expect(keys.session()).toBeUndefined();
    expect(keys.current()).toBe(KEY);
  });

  it('of two unconfirmed keys given at once, only one is used, and the other says so', async () => {
    const results = await Promise.allSettled([saveApiKey(client(), keys, KEY), saveApiKey(client(), keys, OTHER)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason.message).toMatch(/set in this session meanwhile|already given in this session/);
    expect([KEY, OTHER]).toContain(keys.current());
  });
});

describe('saveApiKey without a form, around a dead session key', () => {
  /** Valid keys are whatever is in `valid` at the time of the request. */
  const valid = new Set<string>();
  const mutableClient = () =>
    new RedactPdfClient({
      fetchImpl: fetchMock(async (_input, init) =>
        valid.has(new Headers(init?.headers).get('X-API-Key') ?? '')
          ? jsonResponse({ user_id: 'u', email: 'user@example.com' })
          : jsonResponse({ error: 'invalid', code: 'unauthorized' }, 401),
      ) as unknown as typeof fetch,
      sleep: async () => {},
    });

  beforeEach(() => valid.clear());

  it('does not let a new key in past a working saved key that a dead session key was hiding', async () => {
    const SESSION = 'rpk_session_key_1';
    const ATTACKER = 'rpk_attacker_key_1';
    valid.add(SESSION).add(KEY).add(ATTACKER);
    await saveApiKey(mutableClient(), keys, SESSION); // no file yet: session key
    await writeKeyFile(file, KEY); // later, a working key reaches the file
    valid.delete(SESSION); // and the session key is revoked
    const error = await rejection(saveApiKey(mutableClient(), keys, ATTACKER));
    expect(error.code).toBe('not_confirmed');
    expect(error.message).toMatch(/used again from now on/);
    expect(keys.session()).toBeUndefined();
    expect(keys.current()).toBe(KEY);
  });

  it('giving the saved key again ends a session key that was hiding it', async () => {
    valid.add(OTHER).add(KEY);
    await saveApiKey(mutableClient(), keys, OTHER);
    await writeKeyFile(file, KEY);
    const out = await saveApiKey(mutableClient(), keys, KEY);
    expect(out.status).toBe('already_saved');
    expect(keys.current()).toBe(KEY);
  });
});

describe('saveApiKey account check', () => {
  it.each([
    ['a right-to-left override', 'user@exa\u202Emple.com'],
    ['a zero-width space', 'us\u200Ber@example.com'],
    ['a control character', 'user@example.com\u0007'],
  ])('refuses an account email with %s, which could disguise it in the form', async (_label, email) => {
    const sneaky = new RedactPdfClient({
      fetchImpl: fetchMock(async () => jsonResponse({ user_id: 'u', email })) as unknown as typeof fetch,
      sleep: async () => {},
    });
    let asked = false;
    const error = await rejection(
      saveApiKey(sneaky, keys, KEY, async () => {
        asked = true;
        return 'accepted';
      }),
    );
    expect(error.message).toMatch(/usable account email/);
    expect(asked).toBe(false);
  });
});

/** A stand-in for McpServer: only what elicitConfirmSave touches. */
function fakeServer(elicitInput: (params: unknown, options: unknown) => Promise<unknown>, capabilities: unknown = { elicitation: {} }) {
  return { server: { getClientCapabilities: () => capabilities, elicitInput } } as unknown as McpServer;
}

describe('elicitConfirmSave', () => {
  const request = { accountEmail: 'user@example.com', keyEnding: 'ab-_', replacing: false };

  it('gives the user ten minutes, not the 60 s request default', async () => {
    let seen: unknown;
    await elicitConfirmSave(
      fakeServer(async (_params, options) => {
        seen = options;
        return { action: 'accept', content: { confirm: true } };
      }),
    )(request);
    expect(seen).toEqual({ timeout: CONFIRM_TIMEOUT_MS });
    expect(CONFIRM_TIMEOUT_MS).toBe(600_000);
  });

  it('says the user did not answer in time, rather than that they could not be asked', async () => {
    const confirm = elicitConfirmSave(
      fakeServer(async () => {
        throw new McpError(ErrorCode.RequestTimeout, 'Request timed out');
      }),
    );
    const error = await rejection(confirm(request));
    expect(error.code).toBe('not_confirmed');
    expect(error.message).toMatch(/did not answer the confirmation in time/);
  });

  it('reports any other failure as not asked', async () => {
    const confirm = elicitConfirmSave(
      fakeServer(async () => {
        throw new McpError(ErrorCode.InternalError, 'broken');
      }),
    );
    expect((await rejection(confirm(request))).message).toMatch(/Could not ask the user/);
  });

  it('does not ask a client without elicitation', async () => {
    let asked = false;
    const confirm = elicitConfirmSave(
      fakeServer(async () => {
        asked = true;
        return { action: 'accept' };
      }, {}),
    );
    expect(await confirm(request)).toBe('unsupported');
    expect(asked).toBe(false);
  });
});
