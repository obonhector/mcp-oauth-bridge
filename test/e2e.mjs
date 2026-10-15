#!/usr/bin/env node
/**
 * End-to-end test for the OAuth bridge, against the local mock server.
 *
 * Proves, with no real account involved:
 *   1. an unauthenticated `serve` fails loudly (exit 2) instead of hanging;
 *   2. `login` performs RFC 9728 discovery + RFC 7591 dynamic registration +
 *      authorization code with PKCE (S256) and stores tokens;
 *   3. `serve` exposes the remote MCP tools to a stdio client and proxies calls;
 *   4. an expired access token is refreshed automatically via the refresh token;
 *   5. a pre-registered client id (no dynamic registration) works too.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(HERE, '..', 'bridge.mjs');
const MOCK = path.join(HERE, 'mock-oauth-server.mjs');
const STATIC_CLIENT = 'static-test-client';

const stateDir = mkdtempSync(path.join(tmpdir(), 'mcp-oauth-test-'));
const env = { ...process.env, DSH_MCP_OAUTH_DIR: stateDir, DSH_MCP_OAUTH_NO_OPEN: '1' };
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** Full login: spawn the bridge, drive the "browser" by following the 302. */
async function login(name) {
  const child = spawn(process.execPath, [BRIDGE, 'login', name, '--no-open', '--skip-verify'], { env });
  let stderr = '';
  const authorizationUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no se imprimió AUTHORIZATION_URL')), 20000);
    child.stderr.on('data', (d) => {
      stderr += d;
      const match = stderr.match(/AUTHORIZATION_URL=(\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
  });
  const authorized = await fetch(authorizationUrl, { redirect: 'manual' });
  const location = authorized.headers.get('location');
  const callback = location ? await fetch(location) : { status: 0 };
  const code = await new Promise((resolve) => child.on('close', resolve));
  return { authorizationUrl, authorizedStatus: authorized.status, callbackStatus: callback.status, code, stderr };
}

async function main() {
  console.log('▶ arrancando mock OAuth+MCP...');
  const mock = spawn(process.execPath, [MOCK], { env: { ...env, MOCK_STATIC_CLIENT: STATIC_CLIENT }, stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('el mock no arrancó')), 15000);
    mock.stdout.on('data', (d) => {
      buffer += d;
      const match = buffer.match(/PORT=(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    mock.stderr.on('data', (d) => process.stderr.write(`[mock] ${d}`));
  });
  const mcpUrl = `http://127.0.0.1:${port}/mcp`;
  const stats = () => fetch(`http://127.0.0.1:${port}/__stats`).then((r) => r.json());
  console.log(`  mock en ${mcpUrl}`);

  try {
    console.log('\n▶ 1. servir sin autorizar debe fallar con código 2');
    const added = await run(process.execPath, [BRIDGE, 'add', 'mock', mcpUrl]);
    check('add registra el servidor', added.code === 0, added.stderr.trim().split('\n').pop());
    const unauth = await run(process.execPath, [BRIDGE, 'serve', 'mock']);
    check('serve sin tokens sale con código 2', unauth.code === 2, `código=${unauth.code}`);
    check('el mensaje indica ejecutar login', /login mock/.test(unauth.stderr));

    console.log('\n▶ 2. login: discovery + DCR + PKCE + canje de código');
    const first = await login('mock');
    check('se genera authorization URL con PKCE S256', /code_challenge_method=S256/.test(first.authorizationUrl));
    check('authorize responde 302', first.authorizedStatus === 302);
    check('callback local responde 200', first.callbackStatus === 200);
    check('login termina con código 0', first.code === 0, `código=${first.code}`);
    check('informa access_token + refresh_token', /access_token: sí/.test(first.stderr) && /refresh_token: sí/.test(first.stderr));

    console.log('\n▶ 3. serve: proxy stdio sobre el MCP remoto');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const transport = new StdioClientTransport({ command: process.execPath, args: [BRIDGE, 'serve', 'mock'], env, stderr: 'pipe' });
    const client = new Client({ name: 'e2e', version: '1.0.0' }, { capabilities: {} });
    transport.stderr?.on('data', (d) => process.stderr.write(`  [bridge] ${d}`));
    await client.connect(transport);
    check('initialize sobre stdio', true);

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    check('tools/list refleja el remoto', names.join(',') === 'echo,server_time', names.join(','));

    const echoed = await client.callTool({ name: 'echo', arguments: { text: 'hola DSH' } });
    check('tools/call se proxya', echoed.content?.[0]?.text === 'echo: hola DSH', String(echoed.content?.[0]?.text));

    console.log('\n▶ 4. refresh automático al caducar el access token (TTL 2s)');
    await new Promise((r) => setTimeout(r, 3000));
    const again = await client.callTool({ name: 'echo', arguments: { text: 'tras caducar' } });
    check('llamada posterior al refresh', again.content?.[0]?.text === 'echo: tras caducar');
    const afterRefresh = await stats();
    check('el mock registró el refresh_token grant', afterRefresh.refreshes >= 1, JSON.stringify(afterRefresh));
    await client.close();

    console.log('\n▶ 5. cliente pre-registrado (sin DCR): Google/Microsoft/X y similares');
    const beforeDcr = (await stats()).registrations;
    const staticAdd = await run(process.execPath, [BRIDGE, 'add', 'static', mcpUrl, '--client-id', STATIC_CLIENT]);
    check('add acepta --client-id', staticAdd.code === 0);
    const staticLogin = await login('static');
    check('login con client_id propio termina con código 0', staticLogin.code === 0, `código=${staticLogin.code}`);
    const afterDcr = (await stats()).registrations;
    check('NO hubo registro dinámico de cliente', afterDcr === beforeDcr, `registrations ${beforeDcr}→${afterDcr}`);

    const staticTransport = new StdioClientTransport({ command: process.execPath, args: [BRIDGE, 'serve', 'static'], env, stderr: 'pipe' });
    const staticClient = new Client({ name: 'e2e-static', version: '1.0.0' }, { capabilities: {} });
    await staticClient.connect(staticTransport);
    const staticTools = await staticClient.listTools();
    check('el puente sirve tools con client_id propio', staticTools.tools.length === 2);
    await staticClient.close();

    console.log('\n▶ 6. CLI auxiliar');
    const listed = await run(process.execPath, [BRIDGE, 'tools', 'mock']);
    check('tools lista el remoto desde CLI', listed.code === 0 && /echo/.test(listed.stderr));
    const status = await run(process.execPath, [BRIDGE, 'status', 'mock']);
    check('status reporta conexión OK', /conexión\s*: OK/.test(status.stderr), status.stderr.trim().split('\n').pop());
  } finally {
    mock.kill();
    rmSync(stateDir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? '🎉 TODO OK' : `❌ ${failed.length} fallos`} (${results.length - failed.length}/${results.length})`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Error en el test:', error);
  process.exit(1);
});
