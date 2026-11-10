#!/usr/bin/env node
/**
 * Unit tests for pluggable stores, notify hook, and serve-all wiring.
 * No network beyond the local mock OAuth server.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectBackend, itemTitle, fileStore } from '../lib/store.mjs';
import { notify } from '../lib/notify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(HERE, '..', 'bridge.mjs');
const MOCK = path.join(HERE, 'mock-oauth-server.mjs');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const root = mkdtempSync(path.join(tmpdir(), 'mcp-oauth-store-'));
const fakeBin = path.join(root, 'bin');
mkdirSync(fakeBin);

/* ---------- file backend ---------- */
console.log('▶ file backend');
{
  const be = selectBackend({ store: 'file' });
  const f = path.join(root, 'state', 'a.json');
  be.write(f, { tokens: { access_token: 'x' } }, 'a');
  const mode = (statSync(f).mode & 0o777).toString(8).padStart(3, '0');
  check('file escribe 0600', mode === '600', mode);
  check('file lee de vuelta', be.read(f, 'a').tokens.access_token === 'x');
  check('fileStore exportado', fileStore.name === 'file');
}

/* ---------- 1Password mock ---------- */
console.log('▶ op backend (mock CLI)');
{
  const vault = path.join(root, 'op-vault');
  mkdirSync(vault);
  const op = path.join(fakeBin, 'op');
  writeFileSync(op, `#!/usr/bin/env node
const fs=require('fs'); const path=require('path');
const vault=${JSON.stringify(vault)};
const args=process.argv.slice(2);
function list(){ try{return JSON.parse(fs.readFileSync(path.join(vault,'index.json'),'utf8'));}catch{return[];} }
function save(list){ fs.writeFileSync(path.join(vault,'index.json'), JSON.stringify(list)); }
if(args[0]==='item'&&args[1]==='list'){ process.stdout.write(JSON.stringify(list())); process.exit(0); }
if(args[0]==='item'&&args[1]==='get'){
  const title=args[2]; const hit=list().find(i=>i.title===title);
  if(!hit){ process.stderr.write('not found'); process.exit(1); }
  process.stdout.write(hit.state); process.exit(0);
}
if(args[0]==='item'&&args[1]==='create'){
  const title=args[args.indexOf('--title')+1];
  const assignment=args.find(a=>a.startsWith('state='));
  const state=assignment.slice('state='.length);
  const items=list(); items.push({title, state}); save(items); process.exit(0);
}
if(args[0]==='item'&&args[1]==='edit'){
  const title=args[2]; const assignment=args.find(a=>a.startsWith('state='));
  const items=list(); const hit=items.find(i=>i.title===title);
  if(!hit){ process.stderr.write('not found'); process.exit(1); }
  hit.state=assignment.slice('state='.length); save(items); process.exit(0);
}
process.stderr.write('unknown '+args.join(' ')); process.exit(1);
`, { mode: 0o755 });
  chmodSync(op, 0o755);
  process.env.DSH_MCP_OAUTH_OP_BIN = op;
  process.env.DSH_MCP_OAUTH_OP_VAULT = 'test';
  const be = selectBackend({ store: 'op' });
  be.write(null, { tokens: { access_token: 'from-op' }, clientInformation: { client_id: 'c' } }, 'todoist');
  const round = be.read(null, 'todoist');
  check('op create + get roundtrip', round.tokens?.access_token === 'from-op');
  be.write(null, { tokens: { access_token: 'updated' } }, 'todoist');
  check('op edit roundtrip', be.read(null, 'todoist').tokens.access_token === 'updated');
  check('itemTitle sanitiza', itemTitle('todoist') === 'mcp-oauth:todoist');
  let threw = false;
  try { itemTitle('../evil'); } catch { threw = true; }
  check('itemTitle rechaza nombres raros', threw);
}

/* ---------- libsecret mock ---------- */
console.log('▶ libsecret backend (mock secret-tool)');
{
  const store = path.join(root, 'secret.json');
  writeFileSync(store, '{}');
  const st = path.join(fakeBin, 'secret-tool');
  writeFileSync(st, `#!/usr/bin/env node
const fs=require('fs'); const store=${JSON.stringify(store)};
const args=process.argv.slice(2);
const data=JSON.parse(fs.readFileSync(store,'utf8'));
if(args[0]==='lookup'){
  const server=args[args.indexOf('server')+1];
  if(!data[server]) process.exit(1);
  process.stdout.write(data[server]); process.exit(0);
}
if(args[0]==='store'){
  const server=args[args.indexOf('server')+1];
  let body=''; process.stdin.on('data',d=>body+=d); process.stdin.on('end',()=>{ data[server]=body; fs.writeFileSync(store,JSON.stringify(data)); });
  return;
}
process.exit(1);
`, { mode: 0o755 });
  chmodSync(st, 0o755);
  process.env.DSH_MCP_OAUTH_SECRET_BIN = st;
  const be = selectBackend({ store: 'libsecret' });
  be.write(null, { tokens: { access_token: 'ks' } }, 'ks-server');
  // wait a tick for stdin drain in child
  await new Promise((r) => setTimeout(r, 50));
  check('libsecret roundtrip', be.read(null, 'ks-server').tokens?.access_token === 'ks');
}

/* ---------- notify ---------- */
console.log('▶ notify hook');
{
  const logFile = path.join(root, 'notify.log');
  const logs = [];
  process.env.DSH_MCP_OAUTH_NOTIFY_CMD = `printf '%s|%s|%s\\n' "$MCP_OAUTH_EVENT" "$MCP_OAUTH_SERVER" "$MCP_OAUTH_MESSAGE" >> ${JSON.stringify(logFile).slice(1, -1)}`;
  // fix: use shell-safe path
  process.env.DSH_MCP_OAUTH_NOTIFY_CMD = `printf '%s|%s|%s\\n' "$MCP_OAUTH_EVENT" "$MCP_OAUTH_SERVER" "$MCP_OAUTH_MESSAGE" >> '${logFile}'`;
  await notify('refresh_failed', 'todoist', 'token caducado', { log: (m) => logs.push(m) });
  await notify('refresh_failed', 'todoist', 'otra vez', { log: (m) => logs.push(m) }); // dedup
  await new Promise((r) => setTimeout(r, 100));
  const body = readFileSync(logFile, 'utf8').trim().split('\n');
  check('notify escribe al comando', body[0] === 'refresh_failed|todoist|token caducado', body[0]);
  check('notify deduplica por (server,event)', body.length === 1, String(body.length));
  check('notify loguea el mensaje', logs.some((l) => /token caducado/.test(l)));
  delete process.env.DSH_MCP_OAUTH_NOTIFY_CMD;
}

/* ---------- serve-all against mock ---------- */
console.log('▶ serve-all');
{
  const stateDir = mkdtempSync(path.join(tmpdir(), 'mcp-oauth-all-'));
  const env = { ...process.env, DSH_MCP_OAUTH_DIR: stateDir, DSH_MCP_OAUTH_NO_OPEN: '1' };
  delete env.DSH_MCP_OAUTH_STORE;
  delete env.DSH_MCP_OAUTH_OP_BIN;
  const mock = spawn(process.execPath, [MOCK], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await new Promise((resolve, reject) => {
    let b = ''; const t = setTimeout(() => reject(new Error('mock')), 10000);
    mock.stdout.on('data', (d) => { b += d; const m = b.match(/PORT=(\d+)/); if (m) { clearTimeout(t); resolve(+m[1]); } });
  });
  const mcpUrl = `http://127.0.0.1:${port}/mcp`;
  const run = (args) => new Promise((resolve) => {
    const c = spawn(process.execPath, [BRIDGE, ...args], { env });
    let stdout = '', stderr = '';
    c.stdout.on('data', (d) => (stdout += d)); c.stderr.on('data', (d) => (stderr += d));
    c.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  await run(['add', 'a', mcpUrl]);
  await run(['add', 'b', mcpUrl]);
  // login a only
  const child = spawn(process.execPath, [BRIDGE, 'login', 'a', '--no-open', '--skip-verify'], { env });
  const authUrl = await new Promise((resolve, reject) => {
    let e = ''; const t = setTimeout(() => reject(new Error('no url')), 15000);
    child.stderr.on('data', (d) => { e += d; const m = e.match(/AUTHORIZATION_URL=(\S+)/); if (m) { clearTimeout(t); resolve(m[1]); } });
  });
  const r = await fetch(authUrl, { redirect: 'manual' });
  await fetch(r.headers.get('location'));
  await new Promise((res) => child.on('close', res));

  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: process.execPath, args: [BRIDGE, 'serve-all', '--only', 'a,b'], env, stderr: 'pipe' });
  const client = new Client({ name: 'e2e-all', version: '1.0.0' }, { capabilities: {} });
  let bridgeErr = '';
  transport.stderr?.on('data', (d) => (bridgeErr += d));
  await client.connect(transport);
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  check('serve-all prefija tools con el servidor', names.includes('a__echo') && names.includes('a__server_time'), names.join(','));
  check('serve-all omite el servidor no autorizado', !names.some((n) => n.startsWith('b__')), names.join(','));
  check('serve-all reporta el omitido', /b.*sin autorizar|b.*requiere|b.*login/.test(bridgeErr), bridgeErr.split('\n').filter((l) => /\[b\]/.test(l)).join(' | '));
  const echoed = await client.callTool({ name: 'a__echo', arguments: { text: 'all' } });
  check('serve-all proxya tools/call', echoed.content?.[0]?.text === 'echo: all');
  await client.close();
  mock.kill();
  rmSync(stateDir, { recursive: true, force: true });
}

/* ---------- headless paste-back ---------- */
console.log('▶ login --headless --paste-back');
{
  const stateDir = mkdtempSync(path.join(tmpdir(), 'mcp-oauth-headless-'));
  const env = { ...process.env, DSH_MCP_OAUTH_DIR: stateDir, DSH_MCP_OAUTH_NO_OPEN: '1' };
  const mock = spawn(process.execPath, [MOCK], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await new Promise((resolve, reject) => {
    let b = ''; const t = setTimeout(() => reject(new Error('mock')), 10000);
    mock.stdout.on('data', (d) => { b += d; const m = b.match(/PORT=(\d+)/); if (m) { clearTimeout(t); resolve(+m[1]); } });
  });
  const mcpUrl = `http://127.0.0.1:${port}/mcp`;
  spawnSync(process.execPath, [BRIDGE, 'add', 'h', mcpUrl], { env });
  const child = spawn(process.execPath, [BRIDGE, 'login', 'h', '--headless', '--paste-back', '--skip-verify'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  let authUrl;
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no auth url\n' + stderr)), 15000);
    child.stderr.on('data', (d) => {
      stderr += d;
      const m = stderr.match(/AUTHORIZATION_URL=(\S+)/);
      if (m && !authUrl) authUrl = m[1];
      if (/URL de redirección:/.test(stderr) && authUrl) { clearTimeout(t); resolve(); }
    });
  });
  const authorized = await fetch(authUrl, { redirect: 'manual' });
  const location = authorized.headers.get('location');
  check('authorize emitió redirect', Boolean(location), String(authorized.status));
  child.stdin.write(location + '\n');
  child.stdin.end();
  const code = await new Promise((res) => child.on('close', res));
  check('paste-back login termina 0', code === 0, `code=${code}\n${stderr}`);
  check('paste-back guardó tokens', /access_token: sí/.test(stderr));

  console.log('▶ refresh fallido -> error claro + notify');
  const statePath = path.join(stateDir, 'state', 'h.json');
  const st = JSON.parse(readFileSync(statePath, 'utf8'));
  st.tokens.access_token = 'at-revoked';
  st.tokens.refresh_token = 'rt-revoked';
  writeFileSync(statePath, JSON.stringify(st));
  const notifyLog = path.join(stateDir, 'notify.log');
  const res = spawnSync(process.execPath, [BRIDGE, 'serve', 'h'], {
    env: { ...env, DSH_MCP_OAUTH_NOTIFY_CMD: `printf '%s|%s\\n' "$MCP_OAUTH_EVENT" "$MCP_OAUTH_SERVER" >> '${notifyLog}'` },
    encoding: 'utf8', timeout: 20000, input: '',
  });
  check('serve con refresh revocado sale con código 2', res.status === 2, `code=${res.status}`);
  check('mensaje de refresh fallido', /refresh del token falló/.test(res.stderr), res.stderr.split('\n').find((l) => /❌/.test(l)) || '');
  let nl = '';
  try { nl = readFileSync(notifyLog, 'utf8'); } catch {}
  check('notify hook recibió refresh_failed', /refresh_failed\|h/.test(nl), nl.trim());
  mock.kill();
  rmSync(stateDir, { recursive: true, force: true });
}

rmSync(root, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? '🎉 TODO OK' : `❌ ${failed.length} fallos`} (${results.length - failed.length}/${results.length})`);
process.exit(failed.length === 0 ? 0 : 1);
