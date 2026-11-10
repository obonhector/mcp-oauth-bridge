/**
 * Cooperative per-server lock.
 *
 * `serve` holds a lock for its whole lifetime; `login` / `logout` / `tools`
 * take the lock briefly. This prevents two processes from racing on refresh
 * token rotation (which would silently log the user out) and prevents a live
 * bridge from writing tokens back after `logout`.
 */
import { mkdir, readFile, rm, writeFile, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { lockPath } from './env.mjs';

const STALE_MS = 24 * 60 * 60 * 1000;

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function readInfo(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function acquireLock(name, { role = 'process', waitMs = 0, allowExistingRoles = [] } = {}) {
  const file = lockPath(name);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const handle = await open(file, 'wx', 0o600);
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, role, at: Date.now(), host: os.hostname() }),
        'utf8',
      );
      await handle.close();
      let released = false;
      return {
        file,
        async release() {
          if (released) return;
          released = true;
          const current = await readInfo(file);
          if (!current || current.pid === process.pid) await rm(file, { force: true });
        },
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const info = await readInfo(file);
      if (info && allowExistingRoles.includes(info.role) && processAlive(info.pid)) {
        return { file, ignored: true, async release() {} };
      }
      const stale =
        !info ||
        !processAlive(info.pid) ||
        Date.now() - Number(info.at || 0) > STALE_MS ||
        (info.host && info.host !== os.hostname() && Date.now() - Number(info.at || 0) > 60_000);
      if (stale) {
        await rm(file, { force: true });
        continue;
      }
      if (Date.now() < deadline) {
        await sleep(250);
        continue;
      }
      throw new Error(
        `Server "${name}" is in use by ${info.role || 'another process'} (pid ${info.pid}). Stop it first (or use --force with logout).`,
      );
    }
  }
}

export async function readLock(name) {
  return readInfo(lockPath(name));
}

export async function assertServerFree(name, { role = 'process' } = {}) {
  const info = await readLock(name);
  if (!info) return;
  if (!processAlive(info.pid)) {
    await rm(lockPath(name), { force: true });
    return;
  }
  throw new Error(
    `Server "${name}" is in use by ${info.role || 'another process'} (pid ${info.pid}). Stop it first, then retry ${role}.`,
  );
}

export async function writePidFile(name) {
  const file = lockPath(name);
  await writeFile(file, JSON.stringify({ pid: process.pid, role: 'serve', at: Date.now() }), {
    mode: 0o600,
  });
}
