#!/usr/bin/env node
/**
 * Scan the Cursor plugin marketplace MCP endpoints for OAuth support, using the
 * same discovery code path the bridge uses (RFC 9728 -> RFC 8414).
 *
 * Usage:
 *   node tools/scan-servers.mjs [--dir /tmp/cp/plugins-main/third_party] [--json]
 *
 * Groups the result into:
 *   A) protected-resource metadata + dynamic client registration -> bridge works as-is
 *   B) metadata but no DCR -> needs a pre-registered client_id
 *   C) no discoverable OAuth metadata -> static token or vendor-hosted only
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { discoverOAuthServerInfo } from '@modelcontextprotocol/sdk/client/auth.js';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const dirIndex = argv.indexOf('--dir');
const root = dirIndex === -1 ? '/tmp/cp/plugins-main/third_party' : argv[dirIndex + 1];

const targets = [];
for (const dir of readdirSync(root)) {
  try {
    const cfg = JSON.parse(readFileSync(path.join(root, dir, 'mcp.json'), 'utf8'));
    for (const server of Object.values(cfg.mcpServers ?? {})) {
      if (server.url && !server.url.includes('${')) targets.push([dir, server.url]);
    }
  } catch {
    /* plugins without mcp.json are skipped */
  }
}

async function probe([name, url]) {
  try {
    const info = await discoverOAuthServerInfo(url, {
      fetchFn: (u, init) => fetch(u, { ...init, signal: AbortSignal.timeout(10000) }),
    });
    const metadata = info.authorizationServerMetadata ?? {};
    return {
      name,
      url,
      oauth: true,
      authorizationServer: info.authorizationServerUrl,
      dcr: Boolean(metadata.registration_endpoint),
      scopes: (metadata.scopes_supported ?? []).join(','),
    };
  } catch (error) {
    return { name, url, oauth: false, error: `${error.name}: ${String(error.message).slice(0, 60)}` };
  }
}

const results = [];
const queue = [...targets];
await Promise.all(
  Array.from({ length: 8 }, async () => {
    while (queue.length) results.push(await probe(queue.shift()));
  }),
);

const ready = results.filter((r) => r.oauth && r.dcr).sort((a, b) => a.name.localeCompare(b.name));
const noDcr = results.filter((r) => r.oauth && !r.dcr).sort((a, b) => a.name.localeCompare(b.name));
const none = results.filter((r) => !r.oauth).sort((a, b) => a.name.localeCompare(b.name));

if (asJson) {
  console.log(JSON.stringify({ ready, noDcr, none }, null, 2));
} else {
  console.log(`total remotos: ${results.length}`);
  console.log(`\n=== A) PRM + DCR: el puente funciona sin configurar nada (${ready.length}) ===`);
  console.log(ready.map((r) => r.name).join(', '));
  console.log(`\n=== B) metadata OK, sin DCR (necesitan client_id pre-registrado) (${noDcr.length}) ===`);
  console.log(noDcr.map((r) => `${r.name} → ${r.authorizationServer} [${r.scopes}]`).join('\n'));
  console.log(`\n=== C) sin metadata OAuth descubrible (${none.length}) ===`);
  console.log(none.map((r) => `${r.name} [${r.error}]`).join('\n'));
}
