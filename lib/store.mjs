/**
 * Pluggable token storage.
 * Backends: file (default, 0600), op (1Password CLI, works with service accounts),
 * libsecret (secret-tool). Select with servers.json "store" or DSH_MCP_OAUTH_STORE.
 * op: DSH_MCP_OAUTH_OP_VAULT (default "DSH MCP OAuth"), DSH_MCP_OAUTH_OP_BIN.
 * libsecret: DSH_MCP_OAUTH_SECRET_BIN.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function selectBackend(entry = {}) {
  const name = entry.store || process.env.DSH_MCP_OAUTH_STORE || 'file';
  if (!BACKENDS[name]) throw new Error(`Backend de tokens desconocido: "${name}" (file|op|libsecret)`);
  return BACKENDS[name](entry);
}

function fileBackend() {
  return {
    name: 'file',
    read(file) {
      try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
    },
    write(file, value) {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
      try { chmodSync(file, 0o600); } catch {}
    },
  };
}

function run(bin, args, input) {
  const result = spawnSync(bin, args, { encoding: 'utf8', input, timeout: 30000 });
  if (result.error) throw new Error(`No se pudo ejecutar \`${bin}\`: ${result.error.message}`);
  return result;
}

function opBackend(entry) {
  const vault = entry.opVault || process.env.DSH_MCP_OAUTH_OP_VAULT || 'DSH MCP OAuth';
  const bin = process.env.DSH_MCP_OAUTH_OP_BIN || 'op';
  const op = (args) => {
    const r = run(bin, args);
    if (r.status !== 0) throw new Error(`op falló (código ${r.status}): ${(r.stderr || r.stdout || '').trim().split('\n').pop()}`);
    return r.stdout;
  };
  return {
    name: 'op',
    read(_file, serverName) {
      const title = itemTitle(serverName);
      const items = JSON.parse(op(['item', 'list', '--vault', vault, '--format', 'json']) || '[]');
      if (!items.some((i) => i.title === title)) return {};
      const raw = op(['item', 'get', title, '--vault', vault, '--fields', 'label=state', '--reveal']).trim();
      if (!raw) return {};
      try { return JSON.parse(raw); }
      catch { throw new Error(`El ítem "${title}" de 1Password no tiene JSON válido en el campo "state".`); }
    },
    write(_file, value, serverName) {
      const title = itemTitle(serverName);
      const items = JSON.parse(op(['item', 'list', '--vault', vault, '--format', 'json']) || '[]');
      const assignment = `state=${JSON.stringify(value)}`;
      if (items.some((i) => i.title === title)) op(['item', 'edit', title, '--vault', vault, assignment]);
      else op(['item', 'create', '--category', 'API Credential', '--title', title, '--vault', vault, assignment]);
    },
  };
}

export function itemTitle(serverName) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(serverName)) throw new Error(`Nombre de servidor inválido para 1Password: "${serverName}"`);
  return `mcp-oauth:${serverName}`;
}

function libsecretBackend() {
  const bin = process.env.DSH_MCP_OAUTH_SECRET_BIN || 'secret-tool';
  return {
    name: 'libsecret',
    read(_file, serverName) {
      const r = run(bin, ['lookup', 'service', 'mcp-oauth-bridge', 'server', serverName]);
      if (r.status !== 0 || !r.stdout.trim()) return {};
      return JSON.parse(r.stdout.trim());
    },
    write(_file, value, serverName) {
      const r = run(bin, ['store', '--label', `mcp-oauth ${serverName}`, 'service', 'mcp-oauth-bridge', 'server', serverName], JSON.stringify(value));
      if (r.status !== 0) throw new Error(`secret-tool store falló: ${(r.stderr || '').trim()}`);
    },
  };
}

export const fileStore = fileBackend();
const BACKENDS = { file: fileBackend, op: opBackend, libsecret: libsecretBackend };
