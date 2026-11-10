/**
 * CLI commands. All human-facing output goes to stderr; stdout is reserved for
 * machine-readable output (`--json`, `--version`) and for MCP traffic in serve.
 */
import { createInterface } from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  UnauthorizedError,
  auth,
  discoverOAuthServerInfo,
} from '@modelcontextprotocol/sdk/client/auth.js';
import {
  CONNECT_TIMEOUT_MS,
  CALL_TIMEOUT_MS,
  DEFAULT_PORT,
  DISPLAY_NAME,
  LOGIN_TIMEOUT_MS,
  ROOT,
  SERVERS_FILE,
  USING_LEGACY_DIR,
  VERSION,
  assertServerName,
  describeError,
  ensureDirs,
  envFlag,
  normalizeScope,
  readJsonFile,
  redact,
  statePath,
  writeJsonFile,
} from './env.mjs';
import { acquireLock } from './lock.mjs';
import { FileOAuthProvider, loginHint } from './provider.mjs';
import {
  UpstreamManager,
  buildProxy,
  parseAuthParams,
  runProxy,
} from './proxy.mjs';
import { selectBackend } from './store.mjs';

const log = (...parts) => process.stderr.write(parts.join(' ') + '\n');

const BOOLEAN_FLAGS = new Set([
  'no-open',
  'headless',
  'paste-back',
  'skip-verify',
  'forget-client',
  'json',
  'offline',
  'verify',
  'fail-fast',
  'force',
  'no-revoke',
  'client-secret-stdin',
  'debug',
  'help',
  'version',
]);

const REPEATABLE_FLAGS = new Set(['auth-param', 'scopes']);

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '-h') {
      flags.help = true;
      continue;
    }
    if (arg === '-v') {
      flags.version = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const raw = arg.slice(2);
    const eq = raw.indexOf('=');
    let key = eq === -1 ? raw : raw.slice(0, eq);
    let value;
    if (eq !== -1) value = raw.slice(eq + 1);
    else if (BOOLEAN_FLAGS.has(key)) value = true;
    else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) value = true;
      else {
        value = next;
        i++;
      }
    }
    if (key === 'scope') key = 'scopes';
    if (REPEATABLE_FLAGS.has(key)) {
      flags[key] = [...(flags[key] || []), value];
    } else {
      flags[key] = value;
    }
  }
  return { positional, flags };
}

function collectScopes(flags) {
  if (flags.scopes === undefined) return undefined;
  const values = Array.isArray(flags.scopes) ? flags.scopes : [flags.scopes];
  for (const value of values) if (value === true) throw new Error('--scopes requires a value.');
  return normalizeScope(values);
}

function requireValue(value, flag) {
  if (value === true || value === undefined) throw new Error(`--${flag} requires a value.`);
  return String(value);
}

function parsePort(value, fallback = DEFAULT_PORT) {
  if (value === undefined) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid --port ${JSON.stringify(value)} (expected 0-65535).`);
  }
  return port;
}

function loadServers() {
  const servers = readJsonFile(SERVERS_FILE, {});
  if (servers === undefined || servers === null) return {};
  if (typeof servers !== 'object' || Array.isArray(servers)) {
    throw new Error(`${SERVERS_FILE} must contain a JSON object of server entries.`);
  }
  return servers;
}

function saveServers(servers) {
  writeJsonFile(SERVERS_FILE, servers);
}

function loadServer(name) {
  assertServerName(name);
  const servers = loadServers();
  const entry = servers[name];
  if (!entry) {
    throw new Error(`Server "${name}" is not registered. Run: oauth-mcp-bridge add ${name} <url>`);
  }
  if (typeof entry === 'string') return { url: entry };
  if (!entry.url) throw new Error(`Server "${name}" has no url in ${SERVERS_FILE}.`);
  return entry;
}

function loadServerOptional(name) {
  try {
    return loadServer(name);
  } catch (error) {
    if (/not registered/.test(error.message)) return undefined;
    throw error;
  }
}

async function stateBackendFor(name, server = loadServerOptional(name) || {}) {
  return { backend: selectBackend(server), id: { name, file: statePath(name) } };
}

async function loadState(name, { optional = false } = {}) {
  const server = optional ? loadServerOptional(name) : loadServer(name);
  const { backend, id } = await stateBackendFor(name, server || {});
  return (await backend.read(id)) || {};
}

async function saveState(name, state) {
  const server = loadServerOptional(name) || {};
  const { backend, id } = await stateBackendFor(name, server);
  await backend.write(id, state);
}

async function deleteState(name) {
  const server = loadServerOptional(name) || {};
  const { backend, id } = await stateBackendFor(name, server);
  await backend.delete(id);
}

function makeProvider(name, server, flags, { redirectUrl, interactive }) {
  return new FileOAuthProvider({
    name,
    file: statePath(name),
    server,
    redirectUrl,
    scope: collectScopes(flags) ?? server.scopes,
    clientId: flags['client-id'] ?? server.clientId,
    clientSecret:
      flags['client-secret'] !== undefined
        ? requireValue(flags['client-secret'], 'client-secret')
        : server.clientSecret,
    clientSecretEnv: flags['client-secret-env'] ?? server.clientSecretEnv,
    tokenAuthMethod: flags['token-auth-method'] ?? server.tokenAuthMethod,
    authorizationServer: flags['authorization-server'] ?? server.authorizationServer,
    authParams: parseAuthParams(flags['auth-param'], server.authParams),
    interactive,
    log,
  });
}

function timeoutFetch(timeoutMs) {
  return (url, init = {}) =>
    fetch(url, { ...init, signal: init.signal || AbortSignal.timeout(timeoutMs) });
}

function authOptions(server, provider, flags) {
  return {
    serverUrl: server.url,
    ...(provider.scope ? { scope: provider.scope } : {}),
    ...(flags['resource-metadata-url'] || server.resourceMetadataUrl
      ? { resourceMetadataUrl: new URL(String(flags['resource-metadata-url'] || server.resourceMetadataUrl)) }
      : {}),
    fetchFn: timeoutFetch(CONNECT_TIMEOUT_MS),
  };
}

async function connectClient(name, server, provider) {
  await provider.init();
  const state = provider.snapshot();
  if (!state.tokens?.access_token && !state.tokens?.refresh_token) {
    provider.lastFailure = `no tokens; run: ${loginHint(name)}`;
    const unauthorized = new UnauthorizedError(provider.lastFailure);
    /** @type {any} */ (unauthorized).provider = provider;
    throw unauthorized;
  }
  const client = new Client(
    { name: `oauth-mcp-bridge:${name}`, version: VERSION },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    authProvider: provider,
  });
  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    return { client, transport };
  } catch (error) {
    error.provider = provider;
    await transport.close().catch(() => {});
    await client.close().catch(() => {});
    throw error;
  }
}

function friendlyError(error, name) {
  if (error instanceof UnauthorizedError || error.provider?.lastFailure) {
    return error.provider?.lastFailure || `[${name}] not authorized; run: ${loginHint(name)}`;
  }
  return describeError(error);
}

function expiresInfo(tokens, savedAt) {
  const expiresAt =
    tokens?.expiresAt ||
    (tokens?.expires_in && savedAt ? Number(savedAt) + Number(tokens.expires_in) * 1000 : undefined);
  if (!expiresAt) return { expiresAt: null, expiresIn: null, expired: null };
  const remaining = Math.round((Number(expiresAt) - Date.now()) / 1000);
  return {
    expiresAt: new Date(Number(expiresAt)).toISOString(),
    expiresIn: remaining,
    expired: remaining <= 0,
  };
}

async function reportTokens(name, provider) {
  const state = provider.snapshot();
  const tokens = state.tokens || {};
  const expires = expiresInfo(tokens, state.tokensSavedAt);
  log(`   access_token: ${tokens.access_token ? 'yes' : 'no'}${expires.expiresAt ? ` (expires ${expires.expiresAt})` : ''}`);
  log(`   refresh_token: ${tokens.refresh_token ? 'yes' : 'no'}`);
  log(`   scope: ${tokens.scope || provider.scope || '(not reported)'}`);
  log(`   client_id: ${state.clientInformation?.client_id || provider.clientId || '(none)'}`);
  log(`   store: ${provider.storeDescription}`);
}

async function listAllTools(client) {
  const tools = [];
  let cursor;
  const seen = new Set();
  do {
    const result = await client.listTools(cursor ? { cursor } : undefined, { timeout: CALL_TIMEOUT_MS });
    tools.push(...result.tools);
    cursor = result.nextCursor;
    if (cursor && seen.has(cursor)) break;
    if (cursor) seen.add(cursor);
  } while (cursor);
  return tools;
}

async function countTools(client) {
  return (await listAllTools(client)).length;
}

async function verifyConnection(name, server, flags) {
  const provider = makeProvider(name, server, flags, {
    redirectUrl: new URL(`http://127.0.0.1:${DEFAULT_PORT}/callback`),
    interactive: false,
  });
  const { client, transport } = await connectClient(name, server, provider);
  try {
    const count = await countTools(client);
    log(`✅ Verified: ${count} tool(s) available.`);
    return count;
  } finally {
    await transport.close().catch(() => {});
    await client.close().catch(() => {});
  }
}

function resolveRedirect(flags, server = {}) {
  const explicit = flags['redirect-url'] ?? server.redirectUrl;
  const portFlag = flags.port === undefined ? undefined : parsePort(flags.port);
  if (explicit) {
    if (portFlag !== undefined) throw new Error('Use either --port or --redirect-url, not both.');
    const url = new URL(String(explicit));
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('--redirect-url must be http(s).');
    if (url.protocol === 'https:') {
      throw new Error(
        'HTTPS callbacks need a TLS terminator; use --headless --paste-back or an http loopback URL.',
      );
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
      throw new Error('--redirect-url must point to 127.0.0.1, localhost or ::1.');
    }
    return {
      host,
      port: url.port ? Number(url.port) : 80,
      path: url.pathname || '/callback',
      explicit: url,
    };
  }
  return { host: '127.0.0.1', port: portFlag ?? DEFAULT_PORT, path: '/callback', explicit: undefined };
}

async function cmdAdd(args) {
  ensureDirs();
  const [name, url] = args.positional;
  if (!name || !url) {
    throw new Error('Usage: add <name> <url> [--scopes a,b] [--client-id X] [--client-secret-env VAR]');
  }
  assertServerName(name);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL ${JSON.stringify(url)}. Include the scheme, e.g. https://example.com/mcp`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http(s) URLs are supported.');
  }
  if (parsed.protocol === 'http:' && !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    log('Warning: this URL uses cleartext HTTP; OAuth tokens would be sent without TLS.');
  }

  if (args.flags['client-secret'] && args.flags['client-secret-env']) {
    throw new Error('Use either --client-secret or --client-secret-env, not both.');
  }
  if (args.flags['client-secret'] && args.flags['client-secret-stdin']) {
    throw new Error('Use either --client-secret or --client-secret-stdin, not both.');
  }
  if (args.flags['client-secret-env'] && args.flags['client-secret-stdin']) {
    throw new Error('Use either --client-secret-env or --client-secret-stdin, not both.');
  }

  const servers = loadServers();
  const existing =
    typeof servers[name] === 'string' ? { url: servers[name] } : servers[name] || undefined;
  if (existing && !args.flags.force) log(`Updating existing server "${name}" (--force to replace).`);

  const entry = {
    ...(existing && !args.flags.force ? existing : {}),
    url: parsed.href,
  };
  delete entry.clientSecret; // secrets live in the token store, never in servers.json
  if (args.flags.scopes !== undefined) {
    const scope = collectScopes(args.flags);
    if (scope) entry.scopes = scope;
    else delete entry.scopes;
  }
  if (args.flags['client-id'] !== undefined) entry.clientId = requireValue(args.flags['client-id'], 'client-id');
  if (args.flags['client-secret-env'] !== undefined) {
    const envName = requireValue(args.flags['client-secret-env'], 'client-secret-env');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) throw new Error(`Invalid environment variable name "${envName}".`);
    entry.clientSecretEnv = envName;
  }
  if (args.flags.store !== undefined) {
    const store = requireValue(args.flags.store, 'store');
    selectBackend({ store }); // validate
    entry.store = store;
  }
  if (args.flags['op-vault'] !== undefined) entry.opVault = requireValue(args.flags['op-vault'], 'op-vault');
  if (args.flags['token-auth-method'] !== undefined) {
    const method = requireValue(args.flags['token-auth-method'], 'token-auth-method');
    if (!['none', 'client_secret_basic', 'client_secret_post'].includes(method)) {
      throw new Error('--token-auth-method must be none, client_secret_basic or client_secret_post.');
    }
    entry.tokenAuthMethod = method;
  }
  if (args.flags['authorization-server'] !== undefined) {
    entry.authorizationServer = new URL(String(args.flags['authorization-server'])).href;
  }
  if (args.flags['resource-metadata-url'] !== undefined) {
    entry.resourceMetadataUrl = new URL(String(args.flags['resource-metadata-url'])).href;
  }
  if (args.flags['redirect-url'] !== undefined) {
    entry.redirectUrl = new URL(String(args.flags['redirect-url'])).href;
  }
  if (args.flags['auth-param'] !== undefined) {
    entry.authParams = parseAuthParams(args.flags['auth-param']);
  }

  // A changed URL invalidates cached discovery (the old AS/resource may not match).
  if (existing?.url && existing.url !== entry.url) {
    const backend = selectBackend(entry);
    const id = { name, file: statePath(name) };
    const state = (await backend.read(id)) || {};
    if (state.discoveryState || state.discoveryServerUrl) {
      delete state.discoveryState;
      delete state.discoveryServerUrl;
      await backend.write(id, state);
    }
  }

  // Migrate a legacy plaintext secret out of servers.json.
  const legacySecret = existing?.clientSecret;
  const secretFromArg =
    args.flags['client-secret'] !== undefined
      ? requireValue(args.flags['client-secret'], 'client-secret')
      : undefined;
  const secretFromStdin = args.flags['client-secret-stdin'] ? await readSecretFromStdin() : undefined;
  const secret = args.flags['client-secret-env']
    ? undefined
    : secretFromArg || secretFromStdin || legacySecret;
  if (secretFromArg || secretFromStdin) delete entry.clientSecretEnv;
  if (secret) {
    if (secretFromArg) {
      log('Warning: a secret passed with --client-secret can leak via shell history/process list.');
      log('         Prefer --client-secret-env VAR or --client-secret-stdin.');
    }
    const backend = selectBackend(entry);
    const id = { name, file: statePath(name) };
    const state = (await backend.read(id)) || {};
    state.clientSecret = String(secret);
    await backend.write(id, state);
    log(`Client secret stored in ${backend.describe(id)} (not in servers.json).`);
  } else if (entry.clientSecretEnv && !process.env[entry.clientSecretEnv]) {
    log(`Note: ${entry.clientSecretEnv} is not set in this shell; set it before login.`);
  }

  servers[name] = entry;
  saveServers(servers);
  log(`${existing ? 'Updated' : 'Registered'} "${name}" -> ${entry.url}`);
  log(`Next: oauth-mcp-bridge login ${name}`);
}

async function readSecretFromStdin() {
  if (process.stdin.isTTY) log('Reading the client secret from stdin (it will not be hidden).');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise((resolve) => rl.question('Client secret: ', resolve));
  rl.close();
  try {
    process.stdin.pause();
  } catch {
    /* ignore */
  }
  const value = String(answer).trim();
  if (!value) throw new Error('No client secret received on stdin.');
  return value;
}

async function cmdLogin(args) {
  ensureDirs();
  const [name] = args.positional;
  if (!name) throw new Error('Usage: login <name> [--headless] [--paste-back] [--port N]');
  assertServerName(name);
  const server = loadServer(name);
  const lock = await acquireLock(name, { role: 'login', allowExistingRoles: ['serve', 'serve-all'] });
  if (lock.ignored) {
    log('Warning: a bridge is already running for this server; it will pick up the new tokens on its next connect. Restart it if it was already authenticated.');
  }
  try {
    const headless = Boolean(args.flags.headless || args.flags['paste-back']);
    const redirect = resolveRedirect(args.flags, server);
    const provider = makeProvider(name, server, args.flags, {
      redirectUrl: redirect.explicit || new URL(`http://${redirect.host}:${redirect.port}${redirect.path}`),
      interactive: true,
    });
    await provider.init();
    if (provider.clientSecretEnv && !process.env[provider.clientSecretEnv] && !provider.clientSecret) {
      log(`Warning: ${provider.clientSecretEnv} is not set; the token exchange may fail.`);
    }

    if (headless) return await loginHeadless(name, server, args, provider, redirect);

    const callback = await startCallbackServerWithProvider({
      redirect,
      provider,
      timeoutMs: LOGIN_TIMEOUT_MS,
    });
    provider.redirectUrlValue = callback.redirectUrl;
    await provider.beginLogin();
    log(`Callback server on ${callback.redirectUrl.href}`);
    try {
      let result = await auth(provider, authOptions(server, provider, args.flags));
      if (result === 'REDIRECT') {
        const code = await callback.code;
        result = await auth(provider, {
          ...authOptions(server, provider, args.flags),
          authorizationCode: code,
        });
      }
      if (result !== 'AUTHORIZED') throw new Error(`Authorization incomplete (${result}).`);
      log(`✅ Authorized "${name}".`);
      await reportTokens(name, provider);
      if (!args.flags['skip-verify']) {
        try {
          await verifyConnection(name, server, args.flags);
        } catch (error) {
          log(`⚠️  Could not verify the connection: ${friendlyError(error, name)}`);
        }
      }
    } finally {
      await callback.close();
    }
  } finally {
    await lock.release();
  }
}

async function startCallbackServerWithProvider({ redirect, provider, timeoutMs }) {
  const { startCallbackServer } = await import('./callback.mjs');
  return startCallbackServer({
    port: redirect.port,
    host: redirect.host,
    path: redirect.path,
    provider,
    timeoutMs,
    log,
  });
}

async function loginHeadless(name, server, args, provider, redirect) {
  const pasteBack = Boolean(args.flags['paste-back']);
  const waitForCode = pasteBack
    ? undefined
    : await startCallbackServerWithProvider({ redirect, provider, timeoutMs: LOGIN_TIMEOUT_MS });
  if (!pasteBack) provider.redirectUrlValue = waitForCode.redirectUrl;
  await provider.beginLogin();

  log(`Headless login for "${name}".`);
  log(
    pasteBack
      ? 'Paste the full redirect URL here when the provider sends you back (even if the browser says it cannot connect).'
      : `Callback on ${provider.redirectUrl.href}. From your laptop: ssh -L ${redirect.port}:127.0.0.1:${redirect.port} <this-host> and open the URL there.`,
  );

  try {
    let result = await auth(provider, authOptions(server, provider, args.flags));
    if (result === 'REDIRECT') {
      const code = pasteBack
        ? await readPastedCodeWithProvider(provider)
        : await waitForCode.code;
      result = await auth(provider, {
        ...authOptions(server, provider, args.flags),
        authorizationCode: code,
      });
    }
    if (result !== 'AUTHORIZED') throw new Error(`Authorization incomplete (${result}).`);
    log(`✅ Authorized "${name}".`);
    await reportTokens(name, provider);
  } finally {
    await waitForCode?.close();
  }
}

async function readPastedCodeWithProvider(provider) {
  const { readPastedCode } = await import('./callback.mjs');
  return readPastedCode({ redirectUrl: provider.redirectUrl, provider });
}

async function cmdStatus(args) {
  const [name] = args.positional;
  if (!name) throw new Error('Usage: status <name> [--offline|--verify] [--json]');
  assertServerName(name);
  const server = loadServer(name);
  const state = await loadState(name);
  const tokens = state.tokens || {};
  const expires = expiresInfo(tokens, state.tokensSavedAt);
  const backend = selectBackend(server);
  const storeLocation = backend.describe({ name, file: statePath(name) });
  const info = {
    name,
    url: server.url,
    store: backend.name,
    store_location: storeLocation,
    client_id: state.clientInformation?.client_id || server.clientId || null,
    authorized: Boolean(tokens.access_token),
    access_token: Boolean(tokens.access_token),
    refresh_token: Boolean(tokens.refresh_token),
    expires_at: expires.expiresAt,
    expires_in_seconds: expires.expiresIn,
    expired: expires.expired,
    scope: tokens.scope || server.scopes || null,
    issuer: state.issuer || tokens.issuer || null,
    connection: null,
  };

  let exitCode = 0;
  if (!args.flags.offline) {
    let lock;
    try {
      lock = await acquireLock(name, { role: 'status' });
    } catch (error) {
      log(`Live verification skipped: ${error.message}`);
    }
    if (lock) {
      try {
        const provider = makeProvider(name, server, args.flags, {
          redirectUrl: new URL(`http://127.0.0.1:${DEFAULT_PORT}/callback`),
          interactive: false,
        });
        const { client, transport } = await connectClient(name, server, provider);
        try {
          const count = await countTools(client);
          info.connection = { ok: true, tools: count, error: null };
        } finally {
          await transport.close().catch(() => {});
          await client.close().catch(() => {});
        }
      } catch (error) {
        info.connection = { ok: false, tools: null, error: friendlyError(error, name) };
        exitCode = 3;
      } finally {
        await lock.release();
      }
    }
  }

  if (args.flags.json) {
    process.stdout.write(JSON.stringify(info, null, 2) + '\n');
  } else {
    log(`server      : ${info.name} -> ${info.url}`);
    log(`store       : ${info.store} (${info.store_location})`);
    log(`client_id   : ${info.client_id || '(not registered)'}`);
    log(`tokens      : ${info.access_token ? 'present' : 'missing'}${info.expires_at ? ` (expires ${info.expires_at}${info.expired ? ', EXPIRED' : ''})` : ''}`);
    log(`refresh     : ${info.refresh_token ? 'yes' : 'no'}`);
    log(`scope       : ${info.scope || '(not reported)'}`);
    log(`issuer      : ${info.issuer || '(unknown)'}`);
    if (info.connection) {
      log(`connection  : ${info.connection.ok ? `OK, ${info.connection.tools} tool(s)` : `FAILED (${info.connection.error})`}`);
    } else {
      log('connection  : not checked (--offline or another process is running)');
    }
  }
  if (exitCode) process.exitCode = exitCode;
  if (args.flags.offline && !info.authorized) process.exitCode = 3;
}

async function cmdTools(args) {
  const [name] = args.positional;
  if (!name) throw new Error('Usage: tools <name> [--json]');
  assertServerName(name);
  const server = loadServer(name);
  const lock = await acquireLock(name, { role: 'tools' });
  try {
    const provider = makeProvider(name, server, args.flags, {
      redirectUrl: new URL(`http://127.0.0.1:${DEFAULT_PORT}/callback`),
      interactive: false,
    });
    const { client, transport } = await connectClient(name, server, provider);
    try {
      const allTools = await listAllTools(client);
      if (args.flags.json) {
        process.stdout.write(JSON.stringify(allTools, null, 2) + '\n');
      } else {
        for (const tool of allTools) log(`- ${tool.name}: ${tool.description || ''}`);
      }
    } finally {
      await transport.close().catch(() => {});
      await client.close().catch(() => {});
    }
  } finally {
    await lock.release();
  }
}

async function cmdLogout(args) {
  const [name] = args.positional;
  if (!name) throw new Error('Usage: logout <name> [--forget-client] [--no-revoke]');
  assertServerName(name);
  const server = loadServerOptional(name);
  let lock;
  try {
    lock = await acquireLock(name, { role: 'logout' });
  } catch (error) {
    if (!args.flags.force) throw error;
    log(`Warning: ${error.message} Continuing because --force was passed.`);
    log('Warning: a live bridge can refresh tokens and write them back after logout; stop it first.');
  }
  try {
    const state = await loadState(name, { optional: true });
    if (!state || Object.keys(state).length === 0) {
      log(`No state for "${name}".`);
      return;
    }
    if (!args.flags['no-revoke'] && server) {
      await revokeTokens(name, server, state, { forgetClient: Boolean(args.flags['forget-client']) });
    }
    if (args.flags['forget-client']) {
      await deleteState(name);
      log(`Full state removed for "${name}" (tokens, client registration and secret).`);
    } else {
      delete state.tokens;
      delete state.tokensSavedAt;
      delete state.codeVerifier;
      delete state.oauthState;
      if (Object.keys(state).length === 0) await deleteState(name);
      else await saveState(name, state);
      log(`Tokens removed for "${name}".`);
    }
    if (args.flags['forget-client'] && server) {
      log('Remote client deletion was attempted when the provider supports RFC 7592.');
    }
    log(`Store: ${selectBackend(server || {}).describe({ name, file: statePath(name) })}`);
  } finally {
    await lock?.release();
  }
}

async function revokeTokens(name, server, state, { forgetClient = false } = {}) {
  const tokens = state.tokens || {};
  const token = tokens.refresh_token || tokens.access_token;
  if (!token) return;
  try {
    const info = await discoverOAuthServerInfo(server.url, { fetchFn: timeoutFetch(10_000) });
    const metadata = /** @type {any} */ (info.authorizationServerMetadata);
    const endpoint = metadata?.revocation_endpoint;
    if (endpoint) {
      const clientId = state.clientInformation?.client_id || server.clientId;
      const clientSecret =
        state.clientSecret ||
        state.clientInformation?.client_secret ||
        (server.clientSecretEnv ? process.env[server.clientSecretEnv] : undefined) ||
        server.clientSecret;
      const method =
        state.clientInformation?.token_endpoint_auth_method ||
        server.tokenAuthMethod ||
        (clientSecret ? 'client_secret_basic' : 'none');
      const body = new URLSearchParams({
        token,
        token_type_hint: tokens.refresh_token ? 'refresh_token' : 'access_token',
      });
      if (clientId) body.set('client_id', clientId);
      const headers = { 'content-type': 'application/x-www-form-urlencoded' };
      if (clientSecret && method === 'client_secret_basic') {
        headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
      } else if (clientSecret) {
        body.set('client_secret', clientSecret);
      }
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) log('Token revoked at the authorization server.');
      else log(`Warning: token revocation returned HTTP ${response.status}.`);
    }
  } catch (error) {
    log(`Warning: could not revoke the token remotely: ${describeError(error)}`);
  }

  const clientInfo = state.clientInformation;
  if (forgetClient && clientInfo?.registration_client_uri && clientInfo?.registration_access_token) {
    try {
      const response = await fetch(clientInfo.registration_client_uri, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${clientInfo.registration_access_token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) log(`Warning: client registration deletion returned HTTP ${response.status}.`);
    } catch (error) {
      log(`Warning: could not delete the client registration: ${describeError(error)}`);
    }
  }
}

function classifyFailure(error) {
  const authFailure = error instanceof UnauthorizedError || Boolean(error.provider?.lastFailure);
  return {
    authFailure,
    message: authFailure
      ? error.provider?.lastFailure || error.message
      : `connection failed: ${describeError(error)}`,
  };
}

async function cmdServe(args) {
  const [name] = args.positional;
  if (!name) throw new Error('Usage: serve <name> [--prefix p] [--fail-fast]');
  assertServerName(name);
  const server = loadServer(name);
  const lock = await acquireLock(name, { role: 'serve' });
  const manager = new UpstreamManager({ entries: [{ name, server }], args, log });
  let failures;
  try {
    failures = await manager.connectAll();
  } catch (error) {
    await lock.release();
    throw error;
  }
  if (failures.length) {
    const failure = failures[0];
    const { authFailure, message } = classifyFailure(failure.error);
    log(`[${name}] ${message}`);
    if (args.flags['fail-fast']) {
      await lock.release();
      process.exit(authFailure ? 2 : 1);
    }
    log(`[${name}] starting degraded; it will retry on the next request.`);
  }

  const proxy = buildProxy(manager, {
    label: `oauth-mcp-${name}`,
    prefixFor: () => (args.flags.prefix ? `${args.flags.prefix}__` : ''),
  });
  try {
    await runProxy(proxy, manager, { locks: [lock] });
    log(`[${name}] bridge ready (${server.url})`);
  } catch (error) {
    await lock.release();
    throw error;
  }
}

async function cmdServeAll(args) {
  const servers = loadServers();
  const only = args.flags.only
    ? String(args.flags.only)
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
    : Object.keys(servers);
  const entries = [];
  const locks = [];
  for (const name of only) {
    if (!servers[name]) {
      log(`[${name}] not registered; skipped.`);
      continue;
    }
    try {
      assertServerName(name);
      const lock = await acquireLock(name, { role: 'serve-all' });
      locks.push(lock);
      entries.push({
        name,
        server: typeof servers[name] === 'string' ? { url: servers[name] } : servers[name],
      });
    } catch (error) {
      log(`[${name}] ${error.message} Skipped.`);
    }
  }
  if (!entries.length) {
    log('serve-all: no servers available.');
    process.exit(2);
  }
  const manager = new UpstreamManager({ entries, args, log });
  const failures = await manager.connectAll();
  for (const failure of failures) {
    const { message } = classifyFailure(failure.error);
    log(`[${failure.name}] ${message}`);
  }
  if (args.flags['fail-fast'] && failures.length === entries.length) {
    for (const lock of locks) await lock.release();
    process.exit(2);
  }

  const proxy = buildProxy(manager, {
    label: 'oauth-mcp-all',
    prefixFor: (name) => `${name}__`,
  });
  try {
    await runProxy(proxy, manager, { locks });
    log(`serve-all ready: ${entries.map((entry) => entry.name).join(', ')}`);
  } catch (error) {
    for (const lock of locks) await lock.release();
    throw error;
  }
}

const USAGE = `oauth-mcp-bridge ${VERSION} — OAuth for stdio-only MCP clients

Usage:
  oauth-mcp-bridge <command> [options]

Commands:
  add <name> <url> [--scopes a,b] [--client-id X] [--client-secret-env VAR]
                          [--client-secret-stdin] [--store file|op|libsecret]
                          [--token-auth-method none|client_secret_basic|client_secret_post]
                          [--authorization-server URL] [--resource-metadata-url URL]
                          [--redirect-url URL] [--auth-param key=value] [--force]
  login <name> [--headless] [--paste-back] [--port N] [--redirect-url URL]
                          [--scopes a,b] [--client-id X] [--client-secret-env VAR]
                          [--client-secret X] [--token-auth-method M]
                          [--authorization-server URL] [--resource-metadata-url URL]
                          [--auth-param key=value] [--skip-verify]
  status <name> [--json] [--offline] [--verify]
  tools <name> [--json]
  logout <name> [--forget-client] [--no-revoke] [--force]
  serve <name> [--prefix p] [--fail-fast]
  serve-all [--only a,b] [--fail-fast]
  help | --help | -h
  --version | -v

Environment (new names, legacy DSH_* aliases still work):
  MCP_OAUTH_BRIDGE_DIR            state directory
  MCP_OAUTH_BRIDGE_STORE          file|op|libsecret
  MCP_OAUTH_BRIDGE_PORT           default callback port (33418)
  MCP_OAUTH_BRIDGE_TIMEOUT_MS     login timeout (300000)
  MCP_OAUTH_BRIDGE_CONNECT_TIMEOUT_MS
  MCP_OAUTH_BRIDGE_CALL_TIMEOUT_MS
  MCP_OAUTH_BRIDGE_NOTIFY_CMD     shell command for refresh/connect alerts
  MCP_OAUTH_BRIDGE_OP_VAULT       default "MCP OAuth Bridge"
  MCP_OAUTH_BRIDGE_NO_OPEN=1      never open a browser
  MCP_OAUTH_BRIDGE_DEBUG=1        print stack traces

Exit codes: 0 ok, 1 error, 2 authorization required, 3 status verification failed.

State directory: ${ROOT}${USING_LEGACY_DIR ? ' (legacy DSH directory; set MCP_OAUTH_BRIDGE_DIR to move)' : ''}`;

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.flags.version) {
    process.stdout.write(`${DISPLAY_NAME} ${VERSION}\n`);
    return;
  }
  if (args.flags.help) {
    log(USAGE);
    return;
  }
  const command = args.positional.shift() || 'help';

  try {
    if (command !== 'help') ensureDirs();
    switch (command) {
      case 'help':
        log(USAGE);
        return;
      case 'add':
        return await cmdAdd(args);
      case 'login':
      case 'auth':
        return await cmdLogin(args);
      case 'status':
        return await cmdStatus(args);
      case 'tools':
        return await cmdTools(args);
      case 'logout':
        return await cmdLogout(args);
      case 'serve':
        return await cmdServe(args);
      case 'serve-all':
        return await cmdServeAll(args);
      default: {
        const server = loadServerOptional(command);
        if (server) {
          args.positional.unshift(command);
          return await cmdServe(args);
        }
        log(USAGE);
        process.exitCode = 1;
      }
    }
  } catch (error) {
    const detail = friendlyError(error, args.positional[0] || command).replace(/^Error:\s*/, '');
    log(`Error: ${redact(detail)}`);
    if (envFlag('DEBUG')) log(error?.stack || String(error));
    process.exitCode = 1;
  }
}

export { main };
