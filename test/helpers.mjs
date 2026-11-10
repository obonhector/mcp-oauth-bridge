import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BRIDGE = path.join(HERE, '..', 'bridge.mjs');
export const MOCK = path.join(HERE, 'mock-oauth-server.mjs');
export const VERSION = JSON.parse(readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version;

export function makeStateDir(prefix = 'mcp-oauth-test-') {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export function testEnv(dir, extra = {}) {
  return {
    ...process.env,
    MCP_OAUTH_BRIDGE_DIR: dir,
    MCP_OAUTH_BRIDGE_NO_OPEN: '1',
    ...extra,
  };
}

/**
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv, timeout?: number, input?: string }} [options]
 */
export function run(args, { env = process.env, timeout = 20_000, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BRIDGE, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    if (input !== undefined) child.stdin.end(input);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export function startMock(extra = {}, { quiet = true } = {}) {
  const env = { ...process.env, ...extra };
  const child = spawn(process.execPath, [MOCK], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  if (!quiet) child.stderr.on('data', (chunk) => process.stderr.write(`[mock] ${chunk}`));
  const ready = new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('mock did not start')), 10_000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const match = buffer.match(/PORT=(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.on('error', reject);
  });
  return ready.then((port) => {
    const base = `http://127.0.0.1:${port}`;
    return {
      child,
      port,
      base,
      url: `${base}/mcp`,
      stats: () => fetch(`${base}/__stats`).then((response) => response.json()),
      stop: () =>
        new Promise((resolve) => {
          if (child.exitCode !== null) return resolve();
          child.once('close', resolve);
          child.kill('SIGTERM');
        }),
    };
  });
}

export function waitForAuthUrl(child, getStderr, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const text = getStderr();
      const marker = 'AUTHORIZATION_URL=';
      const index = text.indexOf(marker);
      if (index !== -1) {
        const url = text.slice(index + marker.length).trim().split(/\s/)[0];
        if (url) return resolve(url);
      }
      if (Date.now() - started > timeout) return reject(new Error(`no AUTHORIZATION_URL\n${text}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

export function waitForExit(child, timeout = 15_000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve('HANG');
    }, timeout);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/** Spawn `login`, follow the redirect, and return the result. */
/**
 * @param {{ name?: string, env?: NodeJS.ProcessEnv, timeout?: number, follow?: boolean, args?: string[] }} [options]
 */
export async function loginFlow({
  name = 'mock',
  env,
  timeout = 15_000,
  follow = true,
  args = [],
} = {}) {
  const child = spawn(
    process.execPath,
    [BRIDGE, 'login', name, '--no-open', '--skip-verify', '--port', '0', ...args],
    { env },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const started = Date.now();
  let authUrl;
  let callbackStatus = null;
  if (follow) {
    authUrl = await waitForAuthUrl(child, () => stderr);
    const authorized = await fetch(authUrl, { redirect: 'manual' });
    const location = authorized.headers.get('location');
    if (location) {
      const callback = await fetch(location);
      callbackStatus = callback.status;
    }
  }
  const code = await waitForExit(child, timeout);
  return { code, stdout, stderr, authUrl, callbackStatus, elapsed: Date.now() - started };
}

/**
 * @param {Array<{ name: string, ok: boolean, detail: string }>} results
 * @param {string} name
 * @param {boolean} ok
 * @param {string | number | boolean} [detail]
 */
export function check(results, name, ok, detail = '') {
  detail = String(detail);
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

export function finish(results) {
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${failed.length === 0 ? '🎉 TODO OK' : `❌ ${failed.length} fallos`} (${results.length - failed.length}/${results.length})`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

export function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/** Poll a predicate (e.g. wait for a serve lock to be released). */
export async function waitFor(predicate, timeout = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}
