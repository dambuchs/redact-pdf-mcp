/**
 * The local server as `npx redact-pdf-mcp` builds it, and its key path:
 * placeholder guard, set_api_key, and the saved key reaching the other tools.
 *
 * The rule throughout: no tool result and no error contains the key.
 */
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { callAt, fetchMock, jsonResponse, payload, type FetchMock } from './helpers.js';
import { RedactPdfClient } from '../src/client.js';
import { KEY_SETUP_NOTE } from '../src/descriptions.js';
import { readKeyFile, writeKeyFile } from '../src/key.js';
import { createLocalServer } from '../src/local.js';
import { createServer } from '../src/server.js';

const KEY = 'rpk_abcdefghijklmnopqrstuvwxyz0123456789-_';
const ME = { user_id: 'user-1', email: 'user@example.com' };

let dir: string;
let keyFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'redact-local-'));
  keyFile = join(dir, 'redact-pdf-mcp', 'key');
});

/** /v1/me answers `me` for the `good` keys, 401 for anything else; demo answers 200. */
function api(good: string[] = [KEY], me: unknown = ME): FetchMock {
  return fetchMock(async (input, init) => {
    const url = String(input);
    if (url.endsWith('/v1/me')) {
      const sent = new Headers(init?.headers).get('X-API-Key') ?? '';
      return good.includes(sent) ? jsonResponse(me) : jsonResponse({ error: 'invalid key', code: 'unauthorized' }, 401);
    }
    if (url.endsWith('/v1/demo')) {
      return jsonResponse({ message: 'ok', sample_input: 'x', detected_pii: [], redacted_pdf_path: '/demo.pdf' });
    }
    throw new Error(`unexpected request ${url}`);
  });
}

async function connect(env: NodeJS.ProcessEnv, fetchImpl: FetchMock) {
  const { server } = createLocalServer(env, { fetchImpl: fetchImpl as unknown as typeof fetch, keyFile });
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}

type Answer = { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> } | Error;
const YES: Answer = { action: 'accept', content: { confirm: true } };

/** A client that can show forms, answering each elicitation with `answer`. */
async function connectWithForms(
  answer: Answer,
  { env = {}, fetchImpl = api(), capability = {} }: { env?: NodeJS.ProcessEnv; fetchImpl?: FetchMock; capability?: Record<string, unknown> } = {},
) {
  const { server } = createLocalServer(env, { fetchImpl: fetchImpl as unknown as typeof fetch, keyFile });
  const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: { elicitation: capability } });
  const asked: string[] = [];
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    asked.push(JSON.stringify(request.params));
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return { client, asked };
}

const call = (client: Client, name: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name, arguments: args });

function text(result: unknown): string {
  return JSON.stringify(result);
}

describe('placeholder guard', () => {
  it.each([
    ['empty', ''],
    ['the unsubstituted placeholder', '${user_config.api_key}'],
  ])('an %s REDACT_PDF_API_KEY gets the no-key hint, not a 401 from the API', async (_label, value) => {
    const fetchImpl = api();
    const client = await connect({ REDACT_PDF_API_KEY: value }, fetchImpl);
    const result = await call(client, 'get_account_status');
    const out = payload(result);
    expect(result.isError).toBe(true);
    expect(out.code).toBe('unauthorized');
    expect(out.error).toMatch(/No API key configured/);
    expect(out.error).toMatch(/set_api_key/);
    // Nothing was sent: the placeholder never reached the API as a key.
    expect(fetchImpl).not.toHaveBeenCalled();

    const demo = payload(await call(client, 'try_demo'));
    expect(demo.api_key_configured).toBe(false);
    expect(demo.next_step).toMatch(/call set_api_key/);
  });

  it('a real REDACT_PDF_API_KEY is sent as is', async () => {
    const fetchImpl = api();
    const client = await connect({ REDACT_PDF_API_KEY: KEY }, fetchImpl);
    expect(payload(await call(client, 'get_account_status')).email).toBe(ME.email);
    expect(new Headers(callAt(fetchImpl, 0)[1].headers).get('X-API-Key')).toBe(KEY);
  });
});

describe('set_api_key', () => {
  it('is offered by the local server, last, and announced in the instructions', async () => {
    const client = await connect({}, api());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).at(-1)).toBe('set_api_key');
    // A client may skip confirmation for idempotent, non-destructive tools.
    expect(tools.at(-1)?.annotations).toMatchObject({ destructiveHint: true, idempotentHint: false, readOnlyHint: false });
    expect(client.getInstructions()).toContain(KEY_SETUP_NOTE);
  });

  it('is not offered without a key source, nor ever on the hosted server', async () => {
    for (const options of [
      { mode: 'stdio' as const },
      { mode: 'http' as const, keySource: createLocalServer({}, { keyFile }).keys },
    ]) {
      const server = createServer({ ...options, client: new RedactPdfClient({ fetchImpl: api() as unknown as typeof fetch }) });
      const client = new Client({ name: 'test', version: '1.0.0' });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(b), client.connect(a)]);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).not.toContain('set_api_key');
      expect(client.getInstructions()).not.toContain(KEY_SETUP_NOTE);
      const demo = payload(await call(client, 'try_demo'));
      expect(demo.next_step).toMatch(/set REDACT_PDF_API_KEY/);
      expect(demo.next_step).not.toMatch(/set_api_key/);
    }
  });

  it('with the user\'s yes: checks the key, saves it user-only, and the other tools use it at once', async () => {
    const fetchImpl = api();
    const { client } = await connectWithForms(YES, { env: { REDACT_PDF_API_KEY: '${user_config.api_key}' }, fetchImpl });
    const result = await call(client, 'set_api_key', { api_key: `  ${KEY}\n` });
    const out = payload(result);
    expect(result.isError).toBeFalsy();
    expect(out).toMatchObject({ status: 'saved', key_file: keyFile, account_email: ME.email, confirmed_by_user: true });
    expect(out.note).toMatch(/from now on/);
    expect(text(result)).not.toContain(KEY);
    expect(new Headers(callAt(fetchImpl, 0)[1].headers).get('X-API-Key')).toBe(KEY);
    expect(await readFile(keyFile, 'utf8')).toBe(`${KEY}\n`);
    expect((await stat(keyFile)).mode & 0o777).toBe(0o600);

    const status = await call(client, 'get_account_status');
    expect(payload(status).email).toBe(ME.email);
    // A confirmed key needs no account warning on every result.
    expect(status.content).toHaveLength(1);
    expect(new Headers(callAt(fetchImpl, 1)[1].headers).get('X-API-Key')).toBe(KEY);
    expect(payload(await call(client, 'try_demo')).api_key_configured).toBe(true);
  });

  it('with the user\'s yes and an environment key: saves, and says the environment keeps priority', async () => {
    const { client } = await connectWithForms(YES, { env: { REDACT_PDF_API_KEY: 'rpk_env_key_value' } });
    const result = await call(client, 'set_api_key', { api_key: KEY });
    const out = payload(result);
    expect(out.status).toBe('saved');
    expect(out.note).toMatch(/keeps priority/);
    expect(readKeyFile(keyFile)).toBe(KEY);
    expect(text(result)).not.toContain(KEY);
  });

  it('checks the key against the configured API host', async () => {
    const fetchImpl = api();
    const { client } = await connectWithForms(YES, { env: { REDACT_PDF_BASE_URL: 'https://api.test' }, fetchImpl });
    await call(client, 'set_api_key', { api_key: KEY });
    expect(callAt(fetchImpl, 0)[0]).toBe('https://api.test/v1/me');
  });

  it('saves nothing when the API rejects the key, and does not echo it', async () => {
    const wrong = 'rpk_wrong_key_value_123';
    const client = await connect({}, api());
    const result = await call(client, 'set_api_key', { api_key: wrong });
    const out = payload(result);
    expect(result.isError).toBe(true);
    expect(out.code).toBe('unauthorized');
    expect(out.error).toMatch(/nothing was saved/);
    expect(text(result)).not.toContain(wrong);
    await expect(stat(keyFile)).rejects.toThrow();
  });

  it('keeps an already saved key when a new one is rejected', async () => {
    await writeKeyFile(keyFile, KEY);
    const client = await connect({}, api());
    await call(client, 'set_api_key', { api_key: 'rpk_wrong_key_value_123' });
    expect(await readFile(keyFile, 'utf8')).toBe(`${KEY}\n`);
  });

  it.each([
    ['a placeholder', '${user_config.api_key}'],
    ['a sentence', 'my key is rpk_abcdefgh'],
    ['nothing', '   '],
  ])('refuses %s before any request, and does not echo it', async (_label, value) => {
    const fetchImpl = api();
    const client = await connect({}, fetchImpl);
    const result = await call(client, 'set_api_key', { api_key: value });
    expect(result.isError).toBe(true);
    expect(payload(result).code).toBe('invalid_request');
    expect(fetchImpl).not.toHaveBeenCalled();
    if (value.trim()) expect(text(result)).not.toContain(value);
    await expect(stat(keyFile)).rejects.toThrow();
  });

  it('reports a key it cannot save by path, not by value', async () => {
    // The key file's folder is a regular file, so mkdir fails.
    await writeFile(join(dir, 'redact-pdf-mcp'), 'not a folder');
    const { client } = await connectWithForms(YES);
    const result = await call(client, 'set_api_key', { api_key: KEY });
    const out = payload(result);
    expect(result.isError).toBe(true);
    expect(out.error).toMatch(/could not be saved/);
    expect(out.error).toContain(keyFile);
    expect(out.error).toMatch(/XDG_CONFIG_HOME/);
    expect(out.code).toBe('local_write_failed');
    expect(text(result)).not.toContain(KEY);
  });

  it.each([
    ['no email', { user_id: 'u' }],
    ['an email with a space', { user_id: 'u', email: 'a b@example.com' }],
    ['something that is not an email', { user_id: 'u', email: 'nobody' }],
  ])('refuses an account with %s, which the user could not recognise', async (_label, me) => {
    const { client, asked } = await connectWithForms(YES, { fetchImpl: api([KEY], me) });
    const result = await call(client, 'set_api_key', { api_key: KEY });
    expect(result.isError).toBe(true);
    expect(payload(result).error).toMatch(/usable account email/);
    expect(asked).toHaveLength(0);
    expect(readKeyFile(keyFile)).toBeUndefined();
  });

  it('passes a non-auth failure through without saving', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse({ error: 'down' }, 503));
    const { server } = createLocalServer({}, { fetchImpl: fetchImpl as unknown as typeof fetch, keyFile });
    const client = new Client({ name: 'test', version: '1.0.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    const result = await call(client, 'set_api_key', { api_key: KEY });
    expect(result.isError).toBe(true);
    expect(payload(result).code).not.toBe('unauthorized');
    expect(text(result)).not.toContain(KEY);
    await expect(stat(keyFile)).rejects.toThrow();
  });
});

describe('local key help', () => {
  it('points a rejected saved key at set_api_key', async () => {
    await writeKeyFile(keyFile, 'rpk_revoked_key_1');
    const client = await connect({}, api());
    const out = payload(await call(client, 'get_account_status'));
    expect(out.code).toBe('unauthorized');
    expect(out.error).toMatch(/call set_api_key/);
  });

  it('points a rejected environment key at its setting, not at set_api_key', async () => {
    const client = await connect({ REDACT_PDF_API_KEY: 'rpk_revoked_key_1' }, api());
    const out = payload(await call(client, 'get_account_status'));
    expect(out.code).toBe('unauthorized');
    expect(out.error).toMatch(/replace it there/);
    expect(out.error).not.toMatch(/call set_api_key/);
  });
});

describe('a key that cannot be sent as a header', () => {
  it('fails without quoting the key (environment value with a line break)', async () => {
    const bad = 'rpk_first_line_1\nrpk_second_line_2';
    const fetchImpl = api();
    const client = await connect({ REDACT_PDF_API_KEY: bad }, fetchImpl);
    const result = await call(client, 'get_account_status');
    expect(result.isError).toBe(true);
    expect(payload(result).error).toMatch(/cannot be sent/);
    expect(text(result)).not.toContain('rpk_first_line_1');
    expect(text(result)).not.toContain('rpk_second_line_2');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('ignores a hand-edited key file with two lines instead of sending it', async () => {
    await writeKeyFile(keyFile, KEY);
    await writeFile(keyFile, `${KEY}\nrpk_second_line_2\n`);
    const fetchImpl = api();
    const client = await connect({}, fetchImpl);
    const result = await call(client, 'get_account_status');
    expect(payload(result).error).toMatch(/No API key configured/);
    expect(text(result)).not.toContain(KEY);
    expect(fetchImpl).not.toHaveBeenCalled();
    // And set_api_key may take over: an unusable file is not a working key.
    expect(payload(await call(client, 'set_api_key', { api_key: KEY })).status).toBe('saved_for_session');
  });
});

describe('set_api_key confirmation', () => {
  it('asks the user to approve the account, and saves on yes', async () => {
    const { client, asked } = await connectWithForms({ action: 'accept', content: { confirm: true } });
    const result = await call(client, 'set_api_key', { api_key: KEY });
    const out = payload(result);
    expect(out).toMatchObject({ status: 'saved', confirmed_by_user: true });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(ME.email);
    expect(asked[0]).toContain(`Save the Redact PDF AI API key ending in \\"${KEY.slice(-4)}\\"`);
    expect(asked[0]).not.toContain(KEY);
    expect(readKeyFile(keyFile)).toBe(KEY);
  });

  it.each([
    ['declines', { action: 'decline' as const }],
    ['declines, even with the box ticked', { action: 'decline' as const, content: { confirm: true } }],
    ['cancels', { action: 'cancel' as const }],
    ['accepts without ticking the box', { action: 'accept' as const, content: { confirm: false } }],
    ['cannot be asked', new Error('client went away')],
  ])('saves nothing when the user %s', async (_label, answer) => {
    const { client } = await connectWithForms(answer);
    const result = await call(client, 'set_api_key', { api_key: KEY });
    expect(result.isError).toBe(true);
    expect(payload(result).code).toBe('not_confirmed');
    expect(text(result)).not.toContain(KEY);
    expect(readKeyFile(keyFile)).toBeUndefined();
    // Not even for the session: the user said no.
    expect(payload(await call(client, 'get_account_status')).error).toMatch(/No API key configured/);
  });

  it('replaces a saved key only with the user\'s approval, and says it is a replacement', async () => {
    await writeKeyFile(keyFile, 'rpk_previous_key_1');
    const { client, asked } = await connectWithForms(YES);
    expect(payload(await call(client, 'set_api_key', { api_key: KEY })).status).toBe('saved');
    expect(asked[0]).toMatch(/Replace the saved/);
    expect(readKeyFile(keyFile)).toBe(KEY);
  });

  it('treats a client that only supports URL elicitation as unable to ask', async () => {
    const { client, asked } = await connectWithForms(YES, { capability: { url: {} } });
    const out = payload(await call(client, 'set_api_key', { api_key: KEY }));
    expect(out).toMatchObject({ status: 'saved_for_session', confirmed_by_user: false });
    expect(asked).toHaveLength(0);
  });

  it('without forms: the key is kept for this session only, and every result names its account', async () => {
    const fetchImpl = api();
    const client = await connect({}, fetchImpl);
    const out = payload(await call(client, 'set_api_key', { api_key: KEY }));
    expect(out).toMatchObject({ status: 'saved_for_session', session_only: true, confirmed_by_user: false });
    expect(out.note).toContain(`belongs to the account ${ME.email}`);
    await expect(stat(keyFile)).rejects.toThrow();

    const status = await call(client, 'get_account_status');
    expect(payload(status).email).toBe(ME.email);
    expect(new Headers(callAt(fetchImpl, 1)[1].headers).get('X-API-Key')).toBe(KEY);
    const blocks = status.content as Array<{ text: string }>;
    expect(blocks).toHaveLength(2);
    expect(blocks[1]?.text).toContain(`account ${ME.email}`);
    expect(blocks[1]?.text).toMatch(/not confirmed/);
    // Errors too: the account shows whatever the call did.
    const failed = await call(client, 'get_job_status', { job_id: 'job-x' });
    expect(failed.isError).toBe(true);
    expect((failed.content as unknown[]).length).toBe(2);
  });

  it('without forms: a session key ends with the session', async () => {
    const first = await connect({}, api());
    await call(first, 'set_api_key', { api_key: KEY });
    const next = await connect({}, api());
    expect(payload(await call(next, 'get_account_status')).error).toMatch(/No API key configured/);
  });

  it('without forms: never takes the place of a saved key that still works', async () => {
    // The injected-key case: a document tells the agent to save another key.
    await writeKeyFile(keyFile, KEY);
    const attacker = 'rpk_attacker_key_1';
    const fetchImpl = api([KEY, attacker]);
    const client = await connect({}, fetchImpl);
    const result = await call(client, 'set_api_key', { api_key: attacker });
    const out = payload(result);
    expect(result.isError).toBe(true);
    expect(out.code).toBe('not_confirmed');
    expect(out.error).toContain(keyFile);
    expect(text(result)).not.toContain(attacker);
    expect(readKeyFile(keyFile)).toBe(KEY);
    const status = await call(client, 'get_account_status');
    expect(status.content).toHaveLength(1);
    expect(new Headers(callAt(fetchImpl, fetchImpl.mock.calls.length - 1)[1].headers).get('X-API-Key')).toBe(KEY);
  });

  it('without forms: does not take the place of a saved key it could not check', async () => {
    await writeKeyFile(keyFile, 'rpk_saved_key_value_1');
    const fetchImpl = fetchMock(async (_input, init) =>
      new Headers(init?.headers).get('X-API-Key') === KEY ? jsonResponse(ME) : jsonResponse({ error: 'down' }, 503),
    );
    const client = await connect({}, fetchImpl);
    const result = await call(client, 'set_api_key', { api_key: KEY });
    expect(result.isError).toBe(true);
    expect(payload(result).code).not.toBe('unauthorized');
    expect(text(result)).not.toContain(KEY);
    expect(readKeyFile(keyFile)).toBe('rpk_saved_key_value_1');
  });

  it('without forms: never takes the place of a session key that still works', async () => {
    const attacker = 'rpk_attacker_key_1';
    const client = await connect({}, api([KEY, attacker]));
    await call(client, 'set_api_key', { api_key: KEY });
    const result = await call(client, 'set_api_key', { api_key: attacker });
    expect(payload(result).code).toBe('not_confirmed');
    expect(payload(result).error).toMatch(/already given in this session/);
    expect(payload(await call(client, 'get_account_status')).email).toBe(ME.email);
  });

  it('without forms: may stand in for a saved key the API now rejects', async () => {
    await writeKeyFile(keyFile, 'rpk_revoked_key_1');
    const client = await connect({}, api());
    const out = payload(await call(client, 'set_api_key', { api_key: KEY }));
    expect(out.status).toBe('saved_for_session');
    expect(readKeyFile(keyFile)).toBe('rpk_revoked_key_1');
    expect(payload(await call(client, 'get_account_status')).email).toBe(ME.email);
  });

  it('without forms and with an environment key: saves nothing, since the key would change nothing', async () => {
    const client = await connect({ REDACT_PDF_API_KEY: 'rpk_env_key_value' }, api([KEY, 'rpk_env_key_value']));
    const result = await call(client, 'set_api_key', { api_key: KEY });
    expect(payload(result).code).toBe('not_confirmed');
    expect(payload(result).error).toMatch(/keeps priority/);
    await expect(stat(keyFile)).rejects.toThrow();
  });

  it('saving the key that is already saved changes nothing and asks nobody', async () => {
    await writeKeyFile(keyFile, KEY);
    const { client, asked } = await connectWithForms({ action: 'decline' });
    const out = payload(await call(client, 'set_api_key', { api_key: ` ${KEY}\n` }));
    expect(out).toMatchObject({ status: 'already_saved', key_file: keyFile });
    expect(asked).toHaveLength(0);
  });

  it('giving the session key again changes nothing', async () => {
    const client = await connect({}, api());
    await call(client, 'set_api_key', { api_key: KEY });
    const out = payload(await call(client, 'set_api_key', { api_key: KEY }));
    expect(out).toMatchObject({ status: 'already_saved', session_only: true });
  });
});
