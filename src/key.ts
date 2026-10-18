/**
 * Where the stdio server gets its API key, in order:
 *
 *   1. REDACT_PDF_API_KEY, when it holds a real value.
 *   2. A key given to set_api_key in this session that the user could not
 *      confirm: kept in memory only.
 *   3. The key file that set_api_key writes once the user confirms (user-only,
 *      mode 0600).
 *
 * The file exists because not every client can pass a secret in the
 * environment. Cowork drops a plugin MCP server whose config references
 * `${user_config.*}`, so the Claude plugin passes no key at all and relies on
 * set_api_key or this file. Other launchers (the .mcpb bundle) still pass
 * `${user_config.api_key}`, which can arrive empty or as that literal text.
 * Sending the literal as a key produced a 401 that told the agent the key was
 * "invalid" when none had been given, so both count as unset here and the
 * agent gets the no-key path (try_demo, then set_api_key) instead.
 */

import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

/** `${user_config.api_key}`, `${REDACT_PDF_API_KEY}`: a client that didn't substitute. */
const PLACEHOLDER = /\$\{[^}]*\}/;

/** A key is one token. Anything else is a paste accident, not a credential. */
const KEY_SHAPE = /^[\x21-\x7e]{8,512}$/;

/** The value as a usable key, or undefined when it is empty or a placeholder. */
export function usableKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || PLACEHOLDER.test(trimmed)) return undefined;
  return trimmed;
}

/** Stricter than usableKey: what set_api_key accepts before saving anything. */
export function isWellFormedKey(value: string): boolean {
  return usableKey(value) !== undefined && KEY_SHAPE.test(value.trim());
}

/** `$XDG_CONFIG_HOME/redact-pdf-mcp/key`, else `~/.config/redact-pdf-mcp/key`. */
export function keyFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  // The XDG spec says to ignore a relative value; it would resolve against
  // whatever directory the client happened to launch the server in.
  const base = xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.config');
  return join(base, 'redact-pdf-mcp', 'key');
}

/** A key is ~50 bytes; anything much larger is not a key file. */
const MAX_KEY_FILE_BYTES = 1024;

/**
 * The saved key, or undefined. Read on every call, not cached: a key saved by
 * set_api_key in one session reaches every other running server without a
 * restart. Never throws: an unreadable file means "no key", and the agent then
 * gets the no-key hint rather than a filesystem error.
 *
 * Only a file this user owns and nobody else can write counts. XDG_CONFIG_HOME
 * can point at a shared folder, where another user could plant a key of their
 * own and receive every document; the file is opened without following a
 * symlink and without blocking on a FIFO, then checked through the open handle.
 *
 * The content is held to the same shape set_api_key checks before writing it.
 * A hand-edited file with a second line used to be sent as the key, and Node's
 * Headers.set rejects such a value with an error that quotes it in full, so
 * the key ended up in a tool result.
 */
export function readKeyFile(path: string): string | undefined {
  return inspectKeyFile(path).key;
}

/**
 * readKeyFile, with the reason a file that exists was not used. The startup
 * log names it: a hand-written file with umask 002 is group-writable, and
 * ignoring it without a word looks like the key "not working".
 */
export function inspectKeyFile(path: string): { key?: string; ignored?: string } {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return {};
    return { ignored: code === 'ELOOP' ? 'it is a symlink' : `it cannot be opened (${code ?? 'error'})` };
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) return { ignored: 'it is not a regular file' };
    if (info.size > MAX_KEY_FILE_BYTES) return { ignored: 'it is too large to be a key' };
    if (typeof process.getuid === 'function') {
      if (info.uid !== process.getuid()) return { ignored: 'it belongs to another user' };
      if ((info.mode & 0o022) !== 0) return { ignored: 'other users can write to it (chmod 600 fixes that)' };
    }
    const content = readFileSync(fd, 'utf8');
    return isWellFormedKey(content)
      ? { key: content.trim() }
      : { ignored: 'it does not hold exactly one key on one line' };
  } catch (error) {
    return { ignored: `it cannot be read (${(error as NodeJS.ErrnoException)?.code ?? 'error'})` };
  } finally {
    closeSync(fd);
  }
}

/**
 * The folder must be this user's and closed to everyone else before a key goes
 * into it. `mkdir`'s mode applies only to a folder it creates, and
 * XDG_CONFIG_HOME can point anywhere, /tmp included, where another local user
 * could have created the folder first and could read or replace the key. A
 * symlink is refused rather than followed: through one, the chmod and the
 * rename below would land in whatever folder it points to.
 * POSIX only: Windows has no uid or mode bits here, and a profile folder is
 * private by default.
 */
async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (typeof process.getuid !== 'function') return;
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw Object.assign(new Error(`${dir} is not a plain folder`), { code: 'ENOTDIR' });
  }
  if (info.uid !== process.getuid()) {
    throw Object.assign(new Error(`${dir} belongs to another user`), { code: 'ENOTOWNER' });
  }
  if ((info.mode & 0o077) !== 0) await chmod(dir, 0o700);
}

/**
 * Write the key readable by the user only, through a temporary file moved into
 * place, so a concurrent reader never sees half a key.
 *
 * The temporary name is random and opened with `wx` (O_CREAT | O_EXCL): it is
 * always a new file created 0600, never an existing file or a symlink planted
 * under a predictable name, and two saves don't share it. It is removed when
 * anything fails, so a failed save leaves no copy of the key.
 *
 * `expect` closes the race between checking the saved key and replacing it:
 * `null` publishes only where no usable key is saved (link, which fails if a
 * file appeared meanwhile), a string only while that key is still the one
 * saved. Either way a mismatch throws with code ECHANGED and writes nothing.
 * Leave it out to overwrite unconditionally.
 */
export async function writeKeyFile(path: string, key: string, expect?: string | null): Promise<void> {
  await ensurePrivateDir(dirname(path));
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const changed = () => Object.assign(new Error('the saved key changed meanwhile'), { code: 'ECHANGED' });
  try {
    // A umask can only narrow 0600, so no chmod is needed after it.
    await writeFile(temp, `${key.trim()}\n`, { mode: 0o600, flag: 'wx' });
    if (expect === null) {
      try {
        await link(temp, path);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        // EEXIST: a file is there. Other codes: a filesystem without hard
        // links, where the check below is the best that can be done. Either
        // way, replace only a file that holds no usable key (hand-edited or
        // foreign), never one a concurrent save just wrote.
        // EISDIR: what Windows reports for link() on a non-NTFS volume (see
        // writeOutput in server.ts).
        if (!['EEXIST', 'EPERM', 'ENOTSUP', 'ENOSYS', 'EISDIR'].includes(code ?? '')) throw error;
        if (readKeyFile(path) !== undefined) throw changed();
      }
    } else if (expect !== undefined && readKeyFile(path) !== expect) {
      throw changed();
    }
    await rename(temp, path);
  } finally {
    // After link() the temp name is a second link to the saved file; after a
    // rename or a failure it must not be left holding a copy of the key.
    await unlink(temp).catch(() => {});
  }
}

export interface KeySource {
  /** The key for this call: the environment's, else this session's, else the file's. */
  current(): string | undefined;
  /** The key in the file, whatever the environment says. */
  saved(): string | undefined;
  /**
   * A key given in the conversation that the user could not confirm. It lives
   * in this process only, never on disk, so a key planted by injected text
   * ends with the session. `account` is shown on every tool result meanwhile.
   */
  session(): { key: string; account: string } | undefined;
  setSession(value: { key: string; account: string } | undefined): void;
  /** True when the environment supplies the key, so a saved file is not used. */
  readonly fromEnvironment: boolean;
  readonly filePath: string;
}

export function keySource(env: NodeJS.ProcessEnv = process.env, filePath = keyFilePath(env)): KeySource {
  const envKey = usableKey(env.REDACT_PDF_API_KEY);
  let sessionKey: { key: string; account: string } | undefined;
  return {
    current: () => envKey ?? sessionKey?.key ?? readKeyFile(filePath),
    saved: () => readKeyFile(filePath),
    session: () => sessionKey,
    setSession: (value) => {
      sessionKey = value;
    },
    fromEnvironment: envKey !== undefined,
    filePath,
  };
}
