/**
 * Pluggable token storage.
 *
 * Backends:
 *   file      JSON file, 0600, atomic writes (default)
 *   op        1Password CLI; works with service accounts
 *   libsecret secret-tool (Linux keyring)
 *
 * Selected per server (`"store": "op"` in servers.json) or globally with
 * MCP_OAUTH_BRIDGE_STORE=file|op|libsecret (legacy DSH_MCP_OAUTH_STORE).
 */
import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertServerName, env } from './env.mjs';

export class StoreError extends Error {
  constructor(message, code = 'STORE_ERROR') {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {{ input?: string, timeout?: number }} [options]
 */
function run(bin, args, { input, timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new StoreError(`\`${bin}\` timed out after ${timeout} ms.`, 'STORE_TIMEOUT'));
    }, timeout);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 1_000_000) {
        child.kill('SIGKILL');
        finish(reject, new StoreError(`\`${bin}\` produced too much output.`, 'STORE_OUTPUT'));
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 1_000_000) child.kill('SIGKILL');
    });
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code) => finish(resolve, { code, stdout, stderr }));
    if (input !== undefined) child.stdin.end(String(input));
    else child.stdin.end();
  });
}

function fileBackend() {
  return {
    name: 'file',
    async read(id) {
      let raw;
      try {
        raw = await readFile(id.file, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') return undefined;
        throw new StoreError(`Cannot read ${id.file}: ${error.message}`, error.code || 'STORE_READ');
      }
      if (raw.trim() === '') return undefined;
      try {
        return JSON.parse(raw);
      } catch (error) {
        throw new StoreError(
          `State file ${id.file} is not valid JSON (${error.message}). Fix it, or run: oauth-mcp-bridge logout ${id.name} --forget-client`,
          'STORE_CORRUPT',
        );
      }
    },
    async write(id, value) {
      await mkdir(path.dirname(id.file), { recursive: true, mode: 0o700 });
      const tmp = path.join(
        path.dirname(id.file),
        `.${path.basename(id.file)}.${process.pid}.${Date.now()}.tmp`,
      );
      try {
        await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
        try {
          await chmod(tmp, 0o600);
        } catch {
          /* POSIX-only */
        }
        await rename(tmp, id.file);
        try {
          await chmod(id.file, 0o600);
        } catch {
          /* POSIX-only */
        }
      } catch (error) {
        await rm(tmp, { force: true }).catch(() => {});
        throw new StoreError(`Cannot write ${id.file}: ${error.message}`, error.code || 'STORE_WRITE');
      }
    },
    async delete(id) {
      await rm(id.file, { force: true });
    },
    describe(id) {
      return id.file;
    },
  };
}

function opBackend(entry = {}) {
  const vault = entry.opVault || env('OP_VAULT', 'MCP OAuth Bridge');
  const bin = env('OP_BIN', 'op');
  const op = async (args, input) => {
    const result = await run(bin, args, { input });
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout || '').trim().split('\n').pop();
      throw new StoreError(`\`${bin} ${args[0]} ${args[1] || ''}\` failed (exit ${result.code}): ${detail}`, 'OP_FAILED');
    }
    return result.stdout;
  };
  const list = async () => {
    const raw = await op(['item', 'list', '--vault', vault, '--format', 'json']);
    try {
      return JSON.parse(raw || '[]');
    } catch {
      throw new StoreError(`1Password returned invalid JSON for vault "${vault}".`, 'OP_PARSE');
    }
  };
  return {
    name: 'op',
    async read(id) {
      const title = itemTitle(id.name);
      const items = await list();
      if (!items.some((item) => item.title === title)) return undefined;
      const raw = (await op(['item', 'get', title, '--vault', vault, '--fields', 'label=state', '--reveal'])).trim();
      if (!raw) return undefined;
      try {
        return JSON.parse(raw);
      } catch (error) {
        throw new StoreError(`1Password item "${title}" does not contain valid JSON in field "state": ${error.message}`, 'OP_PARSE');
      }
    },
    async write(id, value) {
      const title = itemTitle(id.name);
      const assignment = `state=${JSON.stringify(value)}`;
      const items = await list();
      if (items.some((item) => item.title === title)) {
        await op(['item', 'edit', title, '--vault', vault, assignment]);
      } else {
        await op(['item', 'create', '--category', 'API Credential', '--title', title, '--vault', vault, assignment]);
      }
    },
    async delete(id) {
      const title = itemTitle(id.name);
      const items = await list();
      if (!items.some((item) => item.title === title)) return;
      await op(['item', 'delete', title, '--vault', vault]);
    },
    describe(id) {
      return `1Password item "${itemTitle(id.name)}" (vault "${vault}")`;
    },
  };
}

function libsecretBackend() {
  const bin = env('SECRET_BIN', 'secret-tool');
  return {
    name: 'libsecret',
    async read(id) {
      const result = await run(bin, ['lookup', 'service', 'mcp-oauth-bridge', 'server', id.name]);
      if (result.code !== 0 || !result.stdout.trim()) return undefined;
      try {
        return JSON.parse(result.stdout.trim());
      } catch (error) {
        throw new StoreError(`libsecret entry for "${id.name}" is not valid JSON: ${error.message}`, 'SECRET_PARSE');
      }
    },
    async write(id, value) {
      const result = await run(
        bin,
        ['store', '--label', `mcp-oauth ${id.name}`, 'service', 'mcp-oauth-bridge', 'server', id.name],
        { input: JSON.stringify(value) },
      );
      if (result.code !== 0) {
        throw new StoreError(`secret-tool store failed: ${(result.stderr || '').trim()}`, 'SECRET_FAILED');
      }
    },
    async delete(id) {
      const result = await run(bin, ['clear', 'service', 'mcp-oauth-bridge', 'server', id.name]);
      if (result.code !== 0) {
        throw new StoreError(`secret-tool clear failed: ${(result.stderr || '').trim()}`, 'SECRET_FAILED');
      }
    },
    describe(id) {
      return `libsecret (service mcp-oauth-bridge, server "${id.name}")`;
    },
  };
}

export function itemTitle(serverName) {
  assertServerName(serverName);
  return `mcp-oauth:${serverName}`;
}

export function selectBackend(entry = {}) {
  const name = entry.store || env('STORE', 'file');
  const factory = { file: fileBackend, op: opBackend, libsecret: libsecretBackend }[name];
  if (!factory) throw new Error(`Unknown token store "${name}" (expected file, op or libsecret).`);
  return factory(entry);
}

export const fileStore = fileBackend();
