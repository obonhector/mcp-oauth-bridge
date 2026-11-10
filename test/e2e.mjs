#!/usr/bin/env node
/**
 * End-to-end tests against the local mock OAuth/MCP server.
 *
 * Covers: unauthorized startup, login, PKCE/state/resource/scope, callback
 * success and failure, timeout, re-login, proxy tools/resources/prompts,
 * pagination, _meta/progress, refresh, serve-all, status, logout/revocation,
 * path traversal, corrupt config/state, and status exit codes.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  BRIDGE,
  check,
  cleanup,
  finish,
  loginFlow,
  makeStateDir,
  run,
  startMock,
  testEnv,
} from './helpers.mjs';

const results = [];
const cleanups = [];
process.on('exit', () => {
  for (const fn of cleanups) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
});

function stdioClient(name, env, args) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BRIDGE, ...args],
    env,
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => (stderr += chunk));
  const client = new Client({ name, version: '1.0.0' }, { capabilities: {} });
  return { client, transport, stderr: () => stderr };
}

async function withMock(extra, fn) {
  const mock = await startMock(extra);
  cleanups.push(() => mock.child.kill('SIGKILL'));
  try {
    return await fn(mock);
  } finally {
    await mock.stop().catch(() => {});
  }
}

async function main() {
  /* ------------------------------------------------------------------ */
  /* 1. Core flow                                                        */
  /* ------------------------------------------------------------------ */
  await withMock(
    {
      MOCK_ACCESS_TTL: '2',
      MOCK_RESOURCES: '1',
      MOCK_PROMPTS: '1',
      MOCK_META: '1',
      MOCK_PAGINATE: '1',
    },
    async (mock) => {
      const dir = makeStateDir();
      cleanups.push(() => cleanup(dir));
      const env = testEnv(dir, { MCP_OAUTH_BRIDGE_TIMEOUT_MS: '8000' });

      let result = await run(['add', 'core', mock.url, '--scopes', 'test:read,test:write'], { env });
      check(results, 'add registers the server', result.code === 0, result.stderr.trim().split('\n').pop());
      const servers = JSON.parse(readFileSync(path.join(dir, 'servers.json'), 'utf8'));
      check(results, 'scopes are normalized to spaces', servers.core.scopes === 'test:read test:write', servers.core.scopes);
      check(results, 'no client secret in servers.json', !('clientSecret' in servers.core));

      result = await run(['serve', 'core', '--fail-fast'], { env, timeout: 10_000 });
      check(results, 'serve --fail-fast without tokens exits 2', result.code === 2, `code=${result.code}`);
      check(results, 'failure message points to login', /login core/i.test(result.stderr));

      const login = await loginFlow({ name: 'core', env });
      check(results, 'login exits 0', login.code === 0, `code=${login.code}`);
      check(results, 'authorization URL uses PKCE S256', /code_challenge_method=S256/.test(login.authUrl || ''));
      check(results, 'authorization URL has the resource indicator', /resource=/.test(login.authUrl || ''));
      check(results, 'authorization URL has state', /state=/.test(login.authUrl || ''));
      check(
        results,
        'scopes are sent space-delimited',
        /scope=test%3Aread\+test%3Awrite/.test(login.authUrl || ''),
        (login.authUrl || '').match(/scope=[^&]+/)?.[0],
      );
      check(results, 'callback responds 200', login.callbackStatus === 200, String(login.callbackStatus));

      const stateFile = path.join(dir, 'state', 'core.json');
      const state = JSON.parse(readFileSync(stateFile, 'utf8'));
      check(results, 'tokens are stored', Boolean(state.tokens?.access_token && state.tokens?.refresh_token));
      check(results, 'absolute expiry is stored', Boolean(state.tokens?.expiresAt));
      check(results, 'PKCE verifier is cleared after exchange', !state.codeVerifier);
      check(results, 'authorization state is cleared after exchange', !state.oauthState);

      result = await run(['status', 'core', '--offline', '--json'], { env });
      const status = JSON.parse(result.stdout || '{}');
      check(results, 'status --offline exits 0', result.code === 0, `code=${result.code}`);
      check(results, 'status reports scopes', status.scope === 'test:read test:write', status.scope);
      check(results, 'status reports the file store', status.store === 'file', status.store);

      const proxy = stdioClient('core-client', env, ['serve', 'core']);
      cleanups.push(() => proxy.client.close().catch(() => {}));
      await proxy.client.connect(proxy.transport);
      const tools = await proxy.client.listTools();
      const names = tools.tools.map((tool) => tool.name).sort();
      check(results, 'all pages of tools/list are exposed', names.join(',') === 'echo,echo_meta,server_time', names.join(','));
      const echo = await proxy.client.callTool({ name: 'echo', arguments: { text: 'hi' } });
      check(results, 'tools/call is proxied', echo.content?.[0]?.text === 'echo: hi', echo.content?.[0]?.text);

      const meta = await proxy.client.callTool({
        name: 'echo_meta',
        arguments: {},
        _meta: { progressToken: 'tok-test' },
      });
      check(results, '_meta/progressToken is forwarded', /^meta:(?!none)/.test(meta.content?.[0]?.text || ''), meta.content?.[0]?.text);
      const withMeta = await proxy.client.callTool({
        name: 'echo',
        arguments: { text: 'meta' },
        _meta: { progressToken: 'tok-test' },
      });
      check(results, 'tools/call with _meta still works', withMeta.content?.[0]?.text === 'echo: meta');

      const resources = await proxy.client.listResources();
      check(results, 'resources/list is exposed', resources.resources.length === 2, String(resources.resources.length));
      const read = await proxy.client.readResource({ uri: 'mock://doc/one' });
      check(results, 'resources/read is proxied', /resource:mock:\/\/doc\/one/.test(/** @type {any} */ (read.contents?.[0])?.text || ''));
      const prompts = await proxy.client.listPrompts();
      check(results, 'prompts/list is exposed', prompts.prompts.map((prompt) => prompt.name).join(',') === 'mock_prompt');
      const prompt = await proxy.client.getPrompt({ name: 'mock_prompt', arguments: { topic: 'x' } });
      check(results, 'prompts/get is proxied', /prompt:mock_prompt:x/.test(/** @type {any} */ (prompt.messages?.[0]?.content)?.text || ''));

      await new Promise((resolve) => setTimeout(resolve, 3000));
      const afterExpiry = await proxy.client.callTool({ name: 'echo', arguments: { text: 'after' } });
      check(results, 'expired access token refreshes automatically', afterExpiry.content?.[0]?.text === 'echo: after');
      const stats = await mock.stats();
      check(results, 'refresh_token grant was used', stats.refreshes >= 1, JSON.stringify(stats));
      await proxy.client.close();

      result = await run(['status', 'core', '--verify', '--json'], { env, timeout: 15_000 });
      const verified = JSON.parse(result.stdout || '{}');
      check(results, 'status --verify exits 0', result.code === 0, `code=${result.code}`);
      check(results, 'status --verify counts all pages', verified.connection?.tools === 3, JSON.stringify(verified.connection));

      result = await run(['tools', 'core', '--json'], { env });
      check(results, 'tools --json lists all tools', result.code === 0 && JSON.parse(result.stdout).length === 3);

      const beforeLogout = await mock.stats();
      result = await run(['logout', 'core'], { env, timeout: 20_000 });
      check(results, 'logout exits 0', result.code === 0, result.stderr.trim().split('\n').pop());
      const afterLogout = JSON.parse(readFileSync(stateFile, 'utf8'));
      check(results, 'logout removes tokens', !afterLogout.tokens);
      check(results, 'logout revokes the token remotely', (await mock.stats()).revokes > beforeLogout.revokes);
      result = await run(['status', 'core', '--offline'], { env });
      check(results, 'status after logout exits 3', result.code === 3, `code=${result.code}`);

      const relogin = await loginFlow({ name: 'core', env });
      check(results, 'login works again after logout', relogin.code === 0, `code=${relogin.code}`);
      result = await run(['logout', 'core', '--forget-client'], { env });
      check(results, 'logout --forget-client removes the state file', result.code === 0 && !existsSync(stateFile));
    },
  );

  /* ------------------------------------------------------------------ */
  /* 2. Failure paths                                                    */
  /* ------------------------------------------------------------------ */
  await withMock({}, async (mock) => {
    const dir = makeStateDir();
    cleanups.push(() => cleanup(dir));
    const env = testEnv(dir, { MCP_OAUTH_BRIDGE_TIMEOUT_MS: '1200' });
    await run(['add', 'timeout', mock.url], { env });
    const timedOut = await loginFlow({ name: 'timeout', env, follow: false, timeout: 10_000 });
    check(results, 'login timeout exits non-zero', timedOut.code !== 0 && timedOut.code !== 'HANG', `code=${timedOut.code}`);
    check(results, 'timeout message is explicit', /Timeout waiting for authorization/i.test(timedOut.stderr));
  });

  await withMock({ MOCK_AUTHORIZE: 'deny' }, async (mock) => {
    const dir = makeStateDir();
    cleanups.push(() => cleanup(dir));
    const env = testEnv(dir);
    await run(['add', 'denied', mock.url], { env });
    const denied = await loginFlow({ name: 'denied', env });
    check(results, 'access_denied exits non-zero', denied.code !== 0 && denied.code !== 'HANG', `code=${denied.code}`);
    check(results, 'access_denied is reported', /access_denied/i.test(denied.stderr));
  });

  for (const mode of ['omit', 'wrong']) {
    await withMock({ MOCK_STATE_MODE: mode }, async (mock) => {
      const dir = makeStateDir();
      cleanups.push(() => cleanup(dir));
      const env = testEnv(dir);
      await run(['add', `state-${mode}`, mock.url], { env });
      const login = await loginFlow({ name: `state-${mode}`, env });
      const errorLine = login.stderr
        .split('\n')
        .find((line) => /state mismatch/i.test(line) && !line.includes('AUTHORIZATION_URL'));
      check(results, `missing/incorrect state (${mode}) is rejected`, login.code !== 0 && login.code !== 'HANG', `code=${login.code}`);
      check(results, `state error is explicit (${mode})`, Boolean(errorLine), errorLine || 'no state error line');
    });
  }

  await withMock({ MOCK_ACCESS_TTL: '60' }, async (mock) => {
    const dir = makeStateDir();
    cleanups.push(() => cleanup(dir));
    const env = testEnv(dir, { MCP_OAUTH_BRIDGE_TIMEOUT_MS: '3000' });
    await run(['add', 'relogin', mock.url], { env });
    const first = await loginFlow({ name: 'relogin', env });
    check(results, 're-login baseline succeeds', first.code === 0);
    const started = Date.now();
    const second = await run(['login', 'relogin', '--no-open', '--skip-verify', '--port', '0'], {
      env,
      timeout: 5000,
    });
    const elapsed = Date.now() - started;
    check(results, 're-login with valid tokens exits quickly', second.code === 0 && elapsed < 1500, `${elapsed} ms`);
  });

  {
    const dir = makeStateDir();
    cleanups.push(() => cleanup(dir));
    const env = testEnv(dir);
    let result = await run(['add', '../evil', 'http://127.0.0.1:1/mcp'], { env });
    check(results, 'path traversal in server name is rejected', result.code !== 0 && /Invalid server name/i.test(result.stderr));
    result = await run(['add', 'bad-url', 'not-a-url'], { env });
    check(results, 'invalid URL is rejected', result.code !== 0 && /Invalid URL/i.test(result.stderr));
    result = await run(['add', '__proto__', 'http://127.0.0.1:1/mcp'], { env });
    check(results, 'prototype-polluting name is rejected', result.code !== 0 && /Invalid server name/i.test(result.stderr));

    writeFileSync(path.join(dir, 'servers.json'), '{bad json');
    result = await run(['status', 'anything'], { env });
    check(results, 'corrupt servers.json gives a clear error', result.code !== 0 && /Invalid JSON/i.test(result.stderr), result.stderr.trim().split('\n').pop());

    writeFileSync(path.join(dir, 'servers.json'), JSON.stringify({ corrupt: { url: 'http://127.0.0.1:1/mcp' } }));
    writeFileSync(path.join(dir, 'state', 'corrupt.json'), '{bad state');
    result = await run(['status', 'corrupt', '--offline'], { env });
    check(results, 'corrupt state gives a clear error', result.code !== 0 && /not valid JSON/i.test(result.stderr), result.stderr.trim().split('\n').pop());
  }

  {
    const dir = makeStateDir();
    cleanups.push(() => cleanup(dir));
    const env = testEnv(dir);
    await run(['add', 'dead', 'http://127.0.0.1:1/mcp'], { env });
    const result = await run(['status', 'dead'], { env, timeout: 15_000 });
    check(results, 'status on a dead server exits 3', result.code === 3, `code=${result.code}`);
    check(results, 'status reports the connection failure', /FAILED/i.test(result.stderr));
    const invalidPort = await run(['login', 'dead', '--port', '70000'], { env });
    check(results, 'invalid port is rejected', invalidPort.code !== 0 && /Invalid --port/i.test(invalidPort.stderr));
    const httpsRedirect = await run(
      ['login', 'dead', '--redirect-url', 'https://example.com/callback'],
      { env },
    );
    check(results, 'https redirect without a terminator is rejected', httpsRedirect.code !== 0 && /HTTPS callbacks/i.test(httpsRedirect.stderr));
  }

  /* ------------------------------------------------------------------ */
  /* 3. serve-all: prefixes, resources/prompts, lazy second login        */
  /* ------------------------------------------------------------------ */
  await withMock({ MOCK_RESOURCES: '1', MOCK_PROMPTS: '1', MOCK_ACCESS_TTL: '60' }, async (mock) => {
    const dir = makeStateDir();
    cleanups.push(() => cleanup(dir));
    const env = testEnv(dir);
    await run(['add', 'a', mock.url], { env });
    await run(['add', 'b', mock.url], { env });
    const loginA = await loginFlow({ name: 'a', env });
    check(results, 'serve-all: first server logs in', loginA.code === 0);

    const proxy = stdioClient('all-client', env, ['serve-all', '--only', 'a,b']);
    cleanups.push(() => proxy.client.close().catch(() => {}));
    await proxy.client.connect(proxy.transport);

    let tools = await proxy.client.listTools();
    let names = tools.tools.map((tool) => tool.name).sort();
    check(results, 'serve-all prefixes tools with the server', names.includes('a__echo') && names.includes('a__server_time'), names.join(','));
    check(results, 'serve-all omits the unauthorized server', !names.some((name) => name.startsWith('b__')), names.join(','));

    const resources = await proxy.client.listResources();
    check(results, 'serve-all lists resources', resources.resources.length === 2, String(resources.resources.length));
    const prompts = await proxy.client.listPrompts();
    check(results, 'serve-all prefixes prompts', prompts.prompts.map((prompt) => prompt.name).includes('a__mock_prompt'), prompts.prompts.map((prompt) => prompt.name).join(','));
    const prompt = await proxy.client.getPrompt({ name: 'a__mock_prompt', arguments: { topic: 'all' } });
    check(results, 'serve-all routes prompts/get', /prompt:mock_prompt:all/.test(/** @type {any} */ (prompt.messages?.[0]?.content)?.text || ''));
    const echoed = await proxy.client.callTool({ name: 'a__echo', arguments: { text: 'all' } });
    check(results, 'serve-all routes tools/call', echoed.content?.[0]?.text === 'echo: all');

    const loginB = await loginFlow({ name: 'b', env });
    check(results, 'serve-all: second server can log in while running', loginB.code === 0, `code=${loginB.code}`);
    tools = await proxy.client.listTools();
    names = tools.tools.map((tool) => tool.name).sort();
    check(results, 'serve-all picks up the second server lazily', names.includes('b__echo'), names.join(','));
    const echoedB = await proxy.client.callTool({ name: 'b__echo', arguments: { text: 'b' } });
    check(results, 'serve-all routes the lazy server call', echoedB.content?.[0]?.text === 'echo: b');
    await proxy.client.close();
  });

  /* ------------------------------------------------------------------ */
  /* 4. Secrets never go into servers.json                               */
  /* ------------------------------------------------------------------ */
  await withMock({ MOCK_STATIC_CLIENT: 'static-id', MOCK_STATIC_SECRET: 's3cret' }, async (mock) => {
    const dir = makeStateDir();
    cleanups.push(() => cleanup(dir));
    const env = testEnv(dir, { STATIC_SECRET: 's3cret' });
    let result = await run(
      ['add', 'static', mock.url, '--client-id', 'static-id', '--client-secret', 's3cret', '--token-auth-method', 'client_secret_post'],
      { env },
    );
    check(results, 'add with a static client secret succeeds', result.code === 0);
    const servers = JSON.parse(readFileSync(path.join(dir, 'servers.json'), 'utf8'));
    check(results, 'client secret is not written to servers.json', !('clientSecret' in servers.static));
    const state = JSON.parse(readFileSync(path.join(dir, 'state', 'static.json'), 'utf8'));
    check(results, 'client secret is stored in the token store', state.clientSecret === 's3cret');
    const login = await loginFlow({ name: 'static', env });
    check(results, 'client_secret_post login works', login.code === 0, `code=${login.code}`);

    result = await run(
      ['add', 'envstatic', mock.url, '--client-id', 'static-id', '--client-secret-env', 'STATIC_SECRET'],
      { env },
    );
    check(results, 'add --client-secret-env succeeds', result.code === 0);
    const servers2 = JSON.parse(readFileSync(path.join(dir, 'servers.json'), 'utf8'));
    check(results, '--client-secret-env stores only the variable name', servers2.envstatic.clientSecretEnv === 'STATIC_SECRET' && !('clientSecret' in servers2.envstatic));
    const envLogin = await loginFlow({ name: 'envstatic', env });
    check(results, 'client secret from the environment works', envLogin.code === 0, `code=${envLogin.code}`);
  });

  finish(results);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
