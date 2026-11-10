#!/usr/bin/env node
/**
 * Unit/integration tests for stores, notify, secrets and logout on every backend.
 * The op/libsecret sections use fake CLIs and are skipped on Windows.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { itemTitle, selectBackend } from '../lib/store.mjs';
import { notify, resetNotifications } from '../lib/notify.mjs';
import {
  check,
  finish,
  loginFlow,
  makeStateDir,
  run,
  startMock,
  testEnv,
} from './helpers.mjs';

const results = [];
const POSIX = process.platform !== 'win32';
const root = mkdtempSync(path.join(tmpdir(), 'mcp-oauth-store-'));
const binDir = path.join(root, 'bin');
mkdirSync(binDir);
process.on('exit', () => rmSync(root, { recursive: true, force: true }));

/* ------------------------------------------------------------------ */
/* file backend                                                        */
/* ------------------------------------------------------------------ */
console.log('▶ file backend');
{
  const backend = selectBackend({ store: 'file' });
  const id = { name: 'todoist', file: path.join(root, 'state', 'todoist.json') };
  await backend.write(id, { tokens: { access_token: 'x' }, clientSecret: 's' });
  check(results, 'file writes and reads', (await backend.read(id)).tokens.access_token === 'x');
  if (POSIX) {
    const mode = (statSync(id.file).mode & 0o777).toString(8).padStart(3, '0');
    check(results, 'file is 0600', mode === '600', mode);
  }
  const leftovers = readdirSync(path.dirname(id.file)).filter((name) => name.includes('.tmp'));
  check(results, 'file writes atomically (no temp files)', leftovers.length === 0, leftovers.join(','));
  await backend.delete(id);
  check(results, 'file delete removes the file', !existsSync(id.file));
  check(results, 'file read returns undefined when missing', (await backend.read(id)) === undefined);

  writeFileSync(id.file, '{bad state');
  let error;
  try {
    await backend.read(id);
  } catch (caught) {
    error = caught;
  }
  check(results, 'corrupt state throws a clear StoreError', /not valid JSON/i.test(error?.message || ''), error?.message);
}

/* ------------------------------------------------------------------ */
/* op backend (fake CLI)                                               */
/* ------------------------------------------------------------------ */
const fakeOp = path.join(binDir, 'op');
if (POSIX) {
  writeFileSync(
    fakeOp,
    `#!/usr/bin/env node
const fs=require('fs'),path=require('path');const v=process.env.VAULT;
const a=process.argv.slice(2);
const list=()=>{try{return JSON.parse(fs.readFileSync(path.join(v,'i.json'),'utf8'))}catch{return[]}};
const save=l=>fs.writeFileSync(path.join(v,'i.json'),JSON.stringify(l));
if(a[0]==='item'&&a[1]==='list'){console.log(JSON.stringify(list()));process.exit(0)}
if(a[0]==='item'&&a[1]==='get'){const h=list().find(i=>i.title===a[2]);if(!h)process.exit(1);console.log(h.state);process.exit(0)}
if(a[0]==='item'&&a[1]==='create'){const t=a[a.indexOf('--title')+1];const s=a.find(x=>x.startsWith('state=')).slice(6);const l=list();l.push({title:t,state:s});save(l);process.exit(0)}
if(a[0]==='item'&&a[1]==='edit'){const l=list(),h=l.find(i=>i.title===a[2]);if(!h)process.exit(1);h.state=a.find(x=>x.startsWith('state=')).slice(6);save(l);process.exit(0)}
if(a[0]==='item'&&a[1]==='delete'){const l=list().filter(i=>i.title!==a[2]);save(l);process.exit(0)}
process.stderr.write('unknown '+a.join(' '));process.exit(1)
`,
    { mode: 0o755 },
  );
  chmodSync(fakeOp, 0o755);
}

if (POSIX) {
  console.log('▶ op backend (fake CLI)');
  const vault = path.join(root, 'op-vault');
  mkdirSync(vault);
  process.env.MCP_OAUTH_BRIDGE_OP_BIN = fakeOp;
  process.env.MCP_OAUTH_BRIDGE_OP_VAULT = 'test';
  process.env.VAULT = vault;
  const backend = selectBackend({ store: 'op' });
  const id = { name: 'todoist', file: path.join(root, 'state', 'todoist.json') };
  await backend.write(id, { tokens: { access_token: 'from-op' }, clientInformation: { client_id: 'c' } });
  check(results, 'op create + read roundtrip', (await backend.read(id)).tokens?.access_token === 'from-op');
  await backend.write(id, { tokens: { access_token: 'updated' } });
  check(results, 'op edit roundtrip', (await backend.read(id)).tokens.access_token === 'updated');
  check(results, 'op describe names the item', /mcp-oauth:todoist/.test(backend.describe(id)));
  check(results, 'itemTitle sanitizes', itemTitle('todoist') === 'mcp-oauth:todoist');
  let threw = false;
  try {
    itemTitle('../evil');
  } catch {
    threw = true;
  }
  check(results, 'itemTitle rejects bad names', threw);

  const mock = await startMock({ MOCK_ACCESS_TTL: '60' });
  const stateDir = makeStateDir();
  const env = testEnv(stateDir, {
    MCP_OAUTH_BRIDGE_OP_BIN: fakeOp,
    MCP_OAUTH_BRIDGE_OP_VAULT: 'test',
    VAULT: vault,
  });
  try {
    await run(['add', 'opmock', mock.url, '--store', 'op'], { env });
    const login = await loginFlow({ name: 'opmock', env });
    check(results, 'op login works', login.code === 0, `code=${login.code}`);
    const opId = { name: 'opmock', file: path.join(stateDir, 'state', 'opmock.json') };
    const opState = await backend.read(opId);
    check(results, 'op stores tokens after login', Boolean(opState?.tokens?.refresh_token));
    let logout = await run(['logout', 'opmock', '--no-revoke'], { env });
    check(results, 'op logout exits 0', logout.code === 0, logout.stderr.trim().split('\n').pop());
    const after = await backend.read(opId);
    check(results, 'op logout removes tokens from the backend', !after?.tokens);
    await run(['logout', 'opmock', '--forget-client', '--no-revoke'], { env });
    check(results, 'op --forget-client deletes the item', (await backend.read(opId)) === undefined);
  } finally {
    await mock.stop();
  }
} else {
  console.log('▶ op backend (skipped on win32)');
}

/* ------------------------------------------------------------------ */
/* libsecret backend (fake CLI)                                        */
/* ------------------------------------------------------------------ */
if (POSIX) {
  console.log('▶ libsecret backend (fake CLI)');
  const secretStore = path.join(root, 'secret-store.json');
  writeFileSync(secretStore, '{}');
  const fakeSecret = path.join(binDir, 'secret-tool');
  writeFileSync(
    fakeSecret,
    `#!/usr/bin/env node
const fs=require('fs');const store=process.env.SECRET_STORE;
const args=process.argv.slice(2);
const data=()=>{try{return JSON.parse(fs.readFileSync(store,'utf8'))}catch{return{}}};
const save=d=>fs.writeFileSync(store,JSON.stringify(d));
if(args[0]==='lookup'){const s=args[args.indexOf('server')+1];const d=data();if(!d[s])process.exit(1);process.stdout.write(d[s]);process.exit(0)}
if(args[0]==='store'){const s=args[args.indexOf('server')+1];let b='';process.stdin.on('data',x=>b+=x);process.stdin.on('end',()=>{const d=data();d[s]=b;save(d)});return;}
if(args[0]==='clear'){const s=args[args.indexOf('server')+1];const d=data();delete d[s];save(d);process.exit(0)}
process.exit(1)
`,
    { mode: 0o755 },
  );
  chmodSync(fakeSecret, 0o755);
  process.env.MCP_OAUTH_BRIDGE_SECRET_BIN = fakeSecret;
  process.env.SECRET_STORE = secretStore;
  const backend = selectBackend({ store: 'libsecret' });
  const id = { name: 'todoist', file: '' };
  await backend.write(id, { tokens: { access_token: 'from-keyring' } });
  check(results, 'libsecret roundtrip', (await backend.read(id)).tokens.access_token === 'from-keyring');
  check(results, 'libsecret describe names the entry', /libsecret/.test(backend.describe(id)));

  const mock = await startMock({ MOCK_ACCESS_TTL: '60' });
  const stateDir = makeStateDir();
  const env = testEnv(stateDir, {
    MCP_OAUTH_BRIDGE_SECRET_BIN: fakeSecret,
    SECRET_STORE: secretStore,
  });
  try {
    await run(['add', 'lsmock', mock.url, '--store', 'libsecret'], { env });
    const login = await loginFlow({ name: 'lsmock', env });
    check(results, 'libsecret login works', login.code === 0, `code=${login.code}`);
    const stored = await backend.read({ name: 'lsmock', file: '' });
    check(results, 'libsecret stores tokens after login', Boolean(stored?.tokens?.refresh_token));
    const logout = await run(['logout', 'lsmock', '--no-revoke'], { env });
    check(results, 'libsecret logout exits 0', logout.code === 0, logout.stderr.trim().split('\n').pop());
    const after = await backend.read({ name: 'lsmock', file: '' });
    check(results, 'libsecret logout removes tokens', !after?.tokens);
    await run(['logout', 'lsmock', '--forget-client', '--no-revoke'], { env });
    check(results, 'libsecret --forget-client deletes the entry', (await backend.read({ name: 'lsmock', file: '' })) === undefined);
  } finally {
    await mock.stop();
  }
} else {
  console.log('▶ libsecret backend (skipped on win32)');
}

/* ------------------------------------------------------------------ */
/* notify hook                                                         */
/* ------------------------------------------------------------------ */
console.log('▶ notify hook');
{
  const logFile = path.join(root, 'notify.log');
  const sink = path.join(root, 'notify-sink.mjs');
  writeFileSync(
    sink,
    `import { appendFileSync } from 'node:fs';
const values = [
  process.env.MCP_OAUTH_BRIDGE_EVENT,
  process.env.MCP_OAUTH_BRIDGE_SERVER,
  process.env.MCP_OAUTH_BRIDGE_MESSAGE,
  process.env.MCP_OAUTH_EVENT,
  process.env.MCP_OAUTH_SERVER,
  process.env.MCP_OAUTH_MESSAGE,
];
appendFileSync(process.argv[2], values.join('|') + '\\n');
`,
  );
  const command = `"${process.execPath}" "${sink}" "${logFile}"`;
  process.env.MCP_OAUTH_BRIDGE_NOTIFY_CMD = command;
  resetNotifications();
  const logs = [];
  await notify('refresh_failed', 'todoist', 'token expired', { log: (line) => logs.push(line) });
  await notify('refresh_failed', 'todoist', 'again', { log: (line) => logs.push(line) });
  const lines = readFileSync(logFile, 'utf8').trim().split('\n');
  check(results, 'notify runs the command', lines[0] === 'refresh_failed|todoist|token expired|refresh_failed|todoist|token expired', lines[0]);
  check(results, 'notify deduplicates (server,event)', lines.length === 1, String(lines.length));
  check(results, 'notify logs locally', logs.some((line) => /token expired/.test(line)));

  delete process.env.MCP_OAUTH_BRIDGE_NOTIFY_CMD;
  process.env.DSH_MCP_OAUTH_NOTIFY_CMD = command;
  resetNotifications();
  await notify('reauth_required', 'legacy', 'legacy hook', { log: () => {} });
  const legacyLines = readFileSync(logFile, 'utf8').trim().split('\n');
  check(results, 'legacy DSH_* notify variable still works', legacyLines.at(-1)?.startsWith('reauth_required|legacy|legacy hook'), legacyLines.at(-1));
  delete process.env.DSH_MCP_OAUTH_NOTIFY_CMD;
}

finish(results);
