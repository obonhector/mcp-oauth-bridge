/**
 * Environment, paths and small shared helpers.
 *
 * Primary environment prefix: MCP_OAUTH_BRIDGE_*
 * Legacy aliases:             DSH_MCP_OAUTH_*   (still honoured)
 */
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_NAME = 'oauth-mcp-bridge';
export const DISPLAY_NAME = 'MCP OAuth Bridge';
export const HOMEPAGE = 'https://github.com/obonhector/oauth-mcp-bridge';

const ENV_PREFIXES = ['MCP_OAUTH_BRIDGE', 'DSH_MCP_OAUTH'];
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const VERSION = JSON.parse(
  readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'),
).version;

/** Read the first defined environment variable among the new and legacy prefixes. */
export function env(name, fallback = undefined) {
  for (const prefix of ENV_PREFIXES) {
    const key = `${prefix}_${name}`;
    const value = process.env[key];
    if (value !== undefined && value !== '') return value;
  }
  return fallback;
}

export function envFlag(name) {
  const value = env(name);
  return value !== undefined && !['0', 'false', 'no'].includes(String(value).toLowerCase());
}

function numberEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Invalid ${name}: ${JSON.stringify(raw)} (expected a number between ${min} and ${max}).`);
  }
  return Math.trunc(value);
}

export const DEFAULT_PORT = numberEnv('PORT', 33418, { min: 0, max: 65535 });
export const LOGIN_TIMEOUT_MS = numberEnv('TIMEOUT_MS', 5 * 60 * 1000, { min: 1000 });
export const CONNECT_TIMEOUT_MS = numberEnv('CONNECT_TIMEOUT_MS', 30_000, { min: 1000 });
export const CALL_TIMEOUT_MS = numberEnv('CALL_TIMEOUT_MS', 120_000, { min: 1000 });
export const MAX_PAGES = numberEnv('MAX_PAGES', 50, { min: 1, max: 1000 });

function defaultDataDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), APP_NAME);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_NAME);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), APP_NAME);
}

const LEGACY_DIR = path.join(os.homedir(), '.dsh', 'mcp-oauth');

function resolveDataDir() {
  const explicit = env('DIR');
  if (explicit) return { dir: explicit, legacy: false };
  const modern = defaultDataDir();
  // Existing DSH users keep their tokens: use the old directory until they move it.
  if (!existsSync(modern) && existsSync(LEGACY_DIR)) return { dir: LEGACY_DIR, legacy: true };
  return { dir: modern, legacy: false };
}

const resolvedDir = resolveDataDir();
export const ROOT = resolvedDir.dir;
export const USING_LEGACY_DIR = resolvedDir.legacy;
export const STATE_DIR = path.join(ROOT, 'state');
export const SERVERS_FILE = path.join(ROOT, 'servers.json');

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function assertServerName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name) || name === '.' || name === '..') {
    throw new Error(
      `Invalid server name ${JSON.stringify(name)}. Use 1-64 characters: letters, digits, dot, underscore or dash (must start with a letter or digit).`,
    );
  }
  return name;
}

export function statePath(name) {
  assertServerName(name);
  return path.join(STATE_DIR, `${name}.json`);
}

export function lockPath(name) {
  assertServerName(name);
  return path.join(STATE_DIR, `${name}.lock`);
}

export function ensureDirs() {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  try {
    chmodSync(ROOT, 0o700);
  } catch {
    /* best effort: a pre-existing shared directory may not be ours */
  }
  try {
    chmodSync(STATE_DIR, 0o700);
  } catch {
    /* best effort */
  }
}

/** JSON file read with actionable errors. Returns `fallback` only when the file is absent/empty. */
export function readJsonFile(file, fallback = undefined) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`Cannot read ${file}: ${error.message}`);
  }
  if (raw.trim() === '') return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${file}: ${error.message}. Fix or remove this file (no changes were made).`,
    );
  }
}

/** Atomic JSON write (temp file + rename), 0600 on POSIX. */
export function writeJsonFile(file, value) {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      /* POSIX-only */
    }
    renameSync(tmp, file);
    try {
      chmodSync(file, 0o600);
    } catch {
      /* POSIX-only */
    }
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw new Error(`Cannot write ${file}: ${error.message}`);
  }
}

/** OAuth scopes are space-delimited; accept comma/whitespace input from users. */
export function normalizeScope(value) {
  if (value === undefined || value === null) return undefined;
  const raw = Array.isArray(value) ? value : [value];
  const parts = raw.flatMap((item) => String(item).split(/[\s,]+/));
  const scopes = [...new Set(parts.map((s) => s.trim()).filter(Boolean))];
  return scopes.length ? scopes.join(' ') : undefined;
}

export function normalizeScopes(value) {
  const scope = normalizeScope(value);
  return scope ? scope.split(' ') : [];
}

export function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      // `start` is a cmd builtin. Quoting the URL keeps `&` in the query string literal.
      spawn('cmd.exe', ['/d', '/s', '/c', `start "" "${String(url).replaceAll('"', '')}"`], {
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
        windowsVerbatimArguments: true,
      }).unref();
    } else {
      const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
      spawn(cmd, [String(url)], { stdio: 'ignore', detached: true }).unref();
    }
  } catch {
    /* the URL is printed anyway */
  }
}

/** Remove obvious credentials from error text before logging. */
export function redact(text) {
  return String(text ?? '')
    .replace(/(access_token|refresh_token|client_secret|code_verifier)=([^&\s"']+)/gi, '$1=[redacted]')
    .replace(/("(?:access_token|refresh_token|client_secret|code_verifier)"\s*:\s*")[^"]+"/gi, '$1[redacted]"');
}

/** Human-readable cause for Node fetch errors (which otherwise say "fetch failed"). */
export function describeError(error) {
  if (!error) return 'unknown error';
  const cause = error.cause;
  const suffix = cause?.code || cause?.message ? ` (${cause.code || cause.message})` : '';
  return `${error.name || 'Error'}: ${error.message || String(error)}${suffix}`;
}
