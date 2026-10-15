#!/usr/bin/env node
/**
 * MCP OAuth bridge for DeepSeek Harness (DSH).
 *
 * DSH's built-in MCP client (@deepseek-ai/dsh-mcp-client) supports stdio and
 * streamable-http with *static* headers only — it has no OAuth flow. This bridge
 * fills that gap: it performs the full MCP authorization spec dance once
 * (protected-resource metadata -> AS metadata -> dynamic client registration ->
 * authorization code + PKCE), stores the tokens, and then exposes the remote MCP
 * server to DSH over stdio, refreshing tokens on its own.
 *
 * Commands (v1.1 adds serve-all, login --headless/--paste-back, pluggable stores, notify hook):
 *   add <name> <url> [--scopes a,b]   register a server in servers.json
 *   login <name>                      run the OAuth flow (opens a browser)
 *   status <name>                     show stored tokens / expiry
 *   tools <name>                      list the remote tools
 *   logout <name> [--forget-client]   drop tokens (and client registration)
 *   serve <name>                      stdio MCP proxy  (this is what DSH runs)
 *
 * Everything human-facing goes to stderr; stdout carries only MCP traffic.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileStore, selectBackend } from './lib/store.mjs';
import { notify } from './lib/notify.mjs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError, auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const HOME = os.homedir();
const ROOT = process.env.DSH_MCP_OAUTH_DIR || path.join(HOME, '.dsh', 'mcp-oauth');
const STATE_DIR = path.join(ROOT, 'state');
const SERVERS_FILE = path.join(ROOT, 'servers.json');
const DEFAULT_PORT = Number(process.env.DSH_MCP_OAUTH_PORT || 33418);
const TIMEOUT_MS = Number(process.env.DSH_MCP_OAUTH_TIMEOUT_MS || 5 * 60 * 1000);

const log = (...a) => process.stderr.write(a.join(' ') + '\n');

function ensureDirs() {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
}

function readJson(file, fallback = undefined) {
  try {
    const value = fileStore.read(file);
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0 && !existsSync(file)) return fallback;
    return value;
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDirs();
  fileStore.write(file, value);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else positional.push(a);
  }
  return { positional, flags };
}

function statePath(name) {
  return path.join(STATE_DIR, `${name}.json`);
}

function loadServer(name) {
  const servers = readJson(SERVERS_FILE, {}) || {};
  const entry = servers[name];
  if (!entry) {
    throw new Error(
      `Server "${name}" is not registered. Run: node ${path.basename(fileURLToPath(import.meta.url))} add ${name} <url>`,
    );
  }
  return typeof entry === 'string' ? { url: entry } : entry;
}

function backendFor(name) {
  let entry = {};
  try {
    entry = loadServer(name);
  } catch {}
  return selectBackend(entry);
}

function loadState(name) {
  ensureDirs();
  return backendFor(name).read(statePath(name), name) || {};
}

function saveState(name, state) {
  ensureDirs();
  backendFor(name).write(statePath(name), state, name);
}

function loadAllServers() {
  return readJson(SERVERS_FILE, {}) || {};
}

/* ------------------------------------------------------------------ */
/* OAuth provider backed by a JSON file, so login and serve can be      */
/* different processes.                                                */
/* ------------------------------------------------------------------ */
class FileOAuthProvider {
  constructor({ name, redirectUrl, scope, clientId, clientSecret, interactive = true }) {
    this.name = name;
    this.interactive = interactive;
    this.lastFailure = undefined;
    this.redirectUrlValue = redirectUrl;
    this.scope = scope;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.data = loadState(name);
    this.authorizationUrl = undefined;
  }

  persist() {
    saveState(this.name, this.data);
  }

  get redirectUrl() {
    return this.redirectUrlValue;
  }

  get clientMetadata() {
    return {
      redirect_uris: [String(this.redirectUrlValue)],
      client_name: 'DeepSeek Harness MCP OAuth bridge',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(this.scope ? { scope: this.scope } : {}),
    };
  }

  /** Internal snapshot (not part of the OAuthClientProvider interface). */
  snapshot() {
    return this.data;
  }

  state() {
    if (!this.data.oauthState) {
      this.data.oauthState = randomBytes(16).toString('hex');
      this.persist();
    }
    return this.data.oauthState;
  }

  async clientInformation() {
    if (this.clientId) {
      return {
        client_id: this.clientId,
        ...(this.clientSecret ? { client_secret: this.clientSecret } : {}),
      };
    }
    return this.data.clientInformation;
  }

  async saveClientInformation(clientInformation) {
    this.data.clientInformation = clientInformation;
    this.persist();
  }

  async tokens() {
    if (this.data.tokens) this.hadTokens = true;
    return this.data.tokens;
  }

  async saveTokens(tokens) {
    this.data.tokens = tokens;
    this.data.tokensSavedAt = Date.now();
    this.persist();
  }

  async saveCodeVerifier(codeVerifier) {
    this.data.codeVerifier = codeVerifier;
    this.persist();
  }

  async codeVerifier() {
    if (!this.data.codeVerifier) throw new Error('No PKCE code verifier stored; re-run login.');
    return this.data.codeVerifier;
  }

  async redirectToAuthorization(authorizationUrl) {
    this.authorizationUrl = authorizationUrl;
    if (!this.interactive) {
      // In serve mode nobody can click: refresh failed or tokens are gone.
      const message = this.data.tokens || this.hadTokens
        ? `el refresh del token falló; hace falta volver a autorizar: ${loginHint(this.name)}`
        : `sin tokens; ejecuta: ${loginHint(this.name)}`;
      this.lastFailure = message;
      notify(this.hadTokens ? 'refresh_failed' : 'reauth_required', this.name, message, { log });
      return;
    }
    log('');
    log('  Abre esta URL para autorizar (o espera a que se abra el navegador):');
    log('');
    log(`  AUTHORIZATION_URL=${authorizationUrl.href}`);
    log('');
    if (!process.env.DSH_MCP_OAUTH_NO_OPEN) openBrowser(authorizationUrl.href);
  }

  async invalidateCredentials(scope) {
    if (this.data.tokens && (scope === 'all' || scope === 'tokens')) this.hadTokens = true;
    if (scope === 'all' || scope === 'client') delete this.data.clientInformation;
    if (scope === 'all' || scope === 'tokens') {
      delete this.data.tokens;
      delete this.data.tokensSavedAt;
    }
    if (scope === 'all' || scope === 'verifier') delete this.data.codeVerifier;
    this.persist();
  }
}

function openBrowser(url) {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
  } catch {
    /* the URL is printed anyway */
  }
}

function loginHint(name) {
  return `node ${fileURLToPath(import.meta.url)} login ${name} --headless`;
}

/* ------------------------------------------------------------------ */
/* Remote connection                                                    */
/* ------------------------------------------------------------------ */
async function connectRemote(name, { url, scope }, provider) {
  const client = new Client(
    { name: `dsh-oauth-bridge:${name}`, version: '1.1.0' },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(new URL(url), { authProvider: provider });
  await client.connect(transport);
  return { client, transport };
}

/* ------------------------------------------------------------------ */
/* Commands                                                             */
/* ------------------------------------------------------------------ */
async function cmdAdd(args) {
  const [name, url] = args.positional;
  if (!name || !url) throw new Error('Usage: add <name> <url> [--scopes a,b] [--client-id X] [--client-secret Y]');
  const servers = readJson(SERVERS_FILE, {}) || {};
  servers[name] = {
    url,
    ...(args.flags.scopes ? { scopes: String(args.flags.scopes) } : {}),
    ...(args.flags['client-id'] ? { clientId: String(args.flags['client-id']) } : {}),
    ...(args.flags['client-secret'] ? { clientSecret: String(args.flags['client-secret']) } : {}),
  };
  writeJson(SERVERS_FILE, servers);
  log(`Registrado "${name}" -> ${url} en ${SERVERS_FILE}`);
}

async function cmdLogin(args) {
  const [name] = args.positional;
  if (!name) throw new Error('Usage: login <name> [--port N] [--no-open] [--headless] [--paste-back]');
  const server = loadServer(name);
  if (args.flags['no-open'] || args.flags.headless) process.env.DSH_MCP_OAUTH_NO_OPEN = '1';
  if (args.flags.headless) return loginHeadless(name, server, args);

  const port = Number(args.flags.port || DEFAULT_PORT);
  const redirectUrl = new URL(`http://127.0.0.1:${port}/callback`);
  const provider = new FileOAuthProvider({
    name,
    redirectUrl,
    scope: args.flags.scopes || server.scopes,
    clientId: args.flags['client-id'] || server.clientId,
    clientSecret: args.flags['client-secret'] || server.clientSecret,
  });

  const waitForCode = startCallbackServer(port, provider);
  log(`Servidor de callback en ${redirectUrl.href}`);

  try {
    let result = await auth(provider, {
      serverUrl: server.url,
      ...(provider.scope ? { scope: provider.scope } : {}),
    });

    if (result === 'REDIRECT') {
      const code = await waitForCode;
      result = await auth(provider, {
        serverUrl: server.url,
        authorizationCode: code,
        ...(provider.scope ? { scope: provider.scope } : {}),
      });
    }

    if (result !== 'AUTHORIZED') throw new Error(`Autorización incompleta (${result}).`);
    log(`✅ Autorizado "${name}".`);
  } finally {
    stopCallbackServer();
  }

  const state = loadState(name);
  const token = state.tokens || {};
  log(`   access_token: ${token.access_token ? 'sí' : 'no'}${token.expires_in ? ` (caduca en ${token.expires_in}s)` : ''}`);
  log(`   refresh_token: ${token.refresh_token ? 'sí' : 'no'}`);
  log(`   client_id: ${state.clientInformation?.client_id || '(ninguno)'}`);

  if (!args.flags['skip-verify']) {
    try {
      const { client, transport } = await connectRemote(name, server, provider);
      const tools = await client.listTools();
      log(`✅ Verificado: ${tools.tools.length} tools disponibles.`);
      await transport.close();
      await client.close();
    } catch (error) {
      log(`⚠️  No se pudo verificar la conexión: ${error.message}`);
    }
  }
}

let callbackServer;

function startCallbackServer(port, provider) {
  return new Promise((resolve, reject) => {
    let settle;
    const codePromise = new Promise((res) => (settle = res));

    callbackServer = createServer((req, res) => {
      const requestUrl = new URL(req.url, `http://127.0.0.1:${port}`);
      if (requestUrl.pathname !== '/callback') {
        res.writeHead(404).end('not found');
        return;
      }
      const error = requestUrl.searchParams.get('error');
      const code = requestUrl.searchParams.get('code');
      const returnedState = requestUrl.searchParams.get('state');
      const expectedState = provider.snapshot().oauthState;

      if (error) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end(`Error: ${error}`);
        clearTimeout(timer);
        reject(new Error(`El servidor de autorización devolvió: ${error}`));
        return;
      }
      if (expectedState && returnedState && returnedState !== expectedState) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('state inválido');
        clearTimeout(timer);
        reject(new Error('El parámetro state no coincide; posible CSRF.'));
        return;
      }
      if (!code) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('falta code');
        return;
      }
      res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end('<h2>Autorizado ✅</h2><p>Ya puedes cerrar esta pestaña y volver a DSH.</p>');
      clearTimeout(timer);
      settle(code);
    });

    const timer = setTimeout(() => {
      reject(new Error(`Timeout esperando la autorización (${TIMEOUT_MS} ms).`));
      stopCallbackServer();
    }, TIMEOUT_MS);

    callbackServer.on('error', reject);
    callbackServer.listen(port, '127.0.0.1', () => {});
    resolve(codePromise);
  });
}

function stopCallbackServer() {
  try {
    callbackServer?.close();
  } catch {}
  callbackServer = undefined;
}

/**
 * Headless login for SSH/Tailscale boxes with no display.
 * --headless     prints the auth URL, then waits for the loopback redirect
 *                (open it on any machine that can reach this host's 127.0.0.1,
 *                e.g. `ssh -L 33418:127.0.0.1:33418`).
 * --paste-back   no listener: prints the URL and reads the final redirect URL
 *                (the one the provider tried to open) from stdin.
 */
async function loginHeadless(name, server, args) {
  const pasteBack = Boolean(args.flags['paste-back']);
  const port = Number(args.flags.port || DEFAULT_PORT);
  const redirectUrl = new URL(args.flags['redirect-url'] || `http://127.0.0.1:${port}/callback`);
  const provider = makeProvider(name, server, args, redirectUrl);

  const waitForCode = pasteBack ? undefined : startCallbackServer(port, provider);
  log(`Login sin navegador para "${name}".`);
  log(pasteBack
    ? 'Modo paste-back: cuando el proveedor redirija, pega aquí la URL completa (aunque el navegador diga que no puede conectar).'
    : `Callback en ${redirectUrl.href}. Desde tu portátil: ssh -L ${port}:127.0.0.1:${port} <este-host> y abre la URL en el navegador local.`);

  try {
    let result = await auth(provider, authOpts(server, provider));
    if (result === 'REDIRECT') {
      const code = pasteBack ? await readPastedCode(redirectUrl, provider) : await waitForCode;
      result = await auth(provider, { ...authOpts(server, provider), authorizationCode: code });
    }
    if (result !== 'AUTHORIZED') throw new Error(`Autorización incompleta (${result}).`);
    log(`✅ Autorizado "${name}".`);
    reportTokens(name);
  } finally {
    if (!pasteBack) stopCallbackServer();
  }
}

function makeProvider(name, server, args, redirectUrl, extra = {}) {
  return new FileOAuthProvider({
    name,
    redirectUrl,
    scope: args.flags.scopes || server.scopes,
    clientId: args.flags['client-id'] || server.clientId,
    clientSecret: args.flags['client-secret'] || server.clientSecret,
    ...extra,
  });
}

function authOpts(server, provider) {
  return { serverUrl: server.url, ...(provider.scope ? { scope: provider.scope } : {}) };
}

function reportTokens(name) {
  const state = loadState(name);
  const token = state.tokens || {};
  log(`   access_token: ${token.access_token ? 'sí' : 'no'}${token.expires_in ? ` (caduca en ${token.expires_in}s)` : ''}`);
  log(`   refresh_token: ${token.refresh_token ? 'sí' : 'no'}`);
  log(`   client_id: ${state.clientInformation?.client_id || '(ninguno)'}`);
}

async function readPastedCode(redirectUrl, provider) {
  const line = await new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question('URL de redirección: ', (answer) => {
      rl.close();
      try { process.stdin.pause(); } catch {}
      resolve(answer.trim());
    });
  });
  let parsed;
  try { parsed = new URL(line); } catch { throw new Error('Eso no es una URL. Pega la URL completa a la que redirigió el proveedor.'); }
  if (parsed.origin + parsed.pathname !== redirectUrl.origin + redirectUrl.pathname) {
    throw new Error(`La URL pegada no apunta al callback esperado (${redirectUrl.href}).`);
  }
  const returnedState = parsed.searchParams.get('state');
  const expectedState = provider.snapshot().oauthState;
  if (expectedState && returnedState && returnedState !== expectedState) throw new Error('El parámetro state no coincide; posible CSRF.');
  const code = parsed.searchParams.get('code');
  if (!code) throw new Error(`La URL no trae "code" (${parsed.searchParams.get('error') || 'sin error'}).`);
  return code;
}

async function cmdStatus(args) {
  const [name] = args.positional;
  if (!name) throw new Error('Usage: status <name>');
  const server = loadServer(name);
  const state = loadState(name);
  const tokens = state.tokens || {};
  const savedAt = state.tokensSavedAt ? new Date(state.tokensSavedAt).toISOString() : 'nunca';
  log(`servidor   : ${name} -> ${server.url}`);
  log(`client_id  : ${state.clientInformation?.client_id || '(sin registrar)'}`);
  log(`tokens     : ${tokens.access_token ? 'presentes' : 'ausentes'}${tokens.expires_in ? ` (expires_in=${tokens.expires_in}s)` : ''}`);
  log(`refresh    : ${tokens.refresh_token ? 'sí' : 'no'}`);
  log(`guardados  : ${savedAt}`);
  log(`estado     : ${statePath(name)}`);

  try {
    const provider = new FileOAuthProvider({ name, redirectUrl: new URL(`http://127.0.0.1:${DEFAULT_PORT}/callback`) });
    const { client, transport } = await connectRemote(name, server, provider);
    const tools = await client.listTools();
    log(`conexión   : OK, ${tools.tools.length} tools`);
    await transport.close();
    await client.close();
  } catch (error) {
    log(`conexión   : FALLA (${error.name}: ${error.message})`);
    if (error instanceof UnauthorizedError) log('             -> ejecuta: login ' + name);
  }
}

async function cmdTools(args) {
  const [name] = args.positional;
  if (!name) throw new Error('Usage: tools <name>');
  const server = loadServer(name);
  const provider = new FileOAuthProvider({
    name,
    redirectUrl: new URL(`http://127.0.0.1:${DEFAULT_PORT}/callback`),
  });
  const { client, transport } = await connectRemote(name, server, provider);
  const { tools } = await client.listTools();
  for (const tool of tools) log(`- ${tool.name}: ${tool.description || ''}`);
  await transport.close();
  await client.close();
}

async function cmdLogout(args) {
  const [name] = args.positional;
  if (!name) throw new Error('Usage: logout <name> [--forget-client]');
  const file = statePath(name);
  if (!existsSync(file)) {
    log(`No hay estado para "${name}".`);
    return;
  }
  const state = loadState(name);
  if (args.flags['forget-client']) {
    writeJson(file, {});
    log(`Estado completo borrado para "${name}".`);
  } else {
    delete state.tokens;
    delete state.tokensSavedAt;
    delete state.codeVerifier;
    saveState(name, state);
    log(`Tokens borrados para "${name}".`);
  }
}

/* ------------------------------------------------------------------ */
/* stdio MCP proxy (shared by serve and serve-all)                      */
/* ------------------------------------------------------------------ */
function serveProvider(name, server, args) {
  return new FileOAuthProvider({
    name,
    redirectUrl: new URL(`http://127.0.0.1:${Number(args.flags.port || DEFAULT_PORT)}/callback`),
    scope: server.scopes,
    clientId: server.clientId,
    clientSecret: server.clientSecret,
    interactive: false,
  });
}

/** Connect one upstream; returns { name, client, transport, provider } or throws. */
async function openUpstream(name, server, args) {
  const provider = serveProvider(name, server, args);
  try {
    const { client, transport } = await connectRemote(name, server, provider);
    return { name, server, client, transport, provider };
  } catch (error) {
    error.provider = provider;
    throw error;
  }
}

/** Wrap an upstream call so auth failures surface clearly (and notify). */
async function guarded(up, fn) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof UnauthorizedError || up.provider.lastFailure) {
      const message = up.provider.lastFailure || `no autorizado (${error.message}); ejecuta: ${loginHint(up.name)}`;
      await notify('refresh_failed', up.name, message, { log });
      throw new Error(`[${up.name}] ${message}`);
    }
    throw error;
  }
}

/**
 * Build a local stdio server over N upstreams. Names are `${prefix}tool`;
 * prefix is '' for single-server serve without --prefix, `${name}__` otherwise.
 */
function buildProxy(upstreams, { label, prefixFor }) {
  const local = new Server({ name: label, version: '1.1.0' }, { capabilities: { tools: {}, resources: {}, prompts: {} } });
  const routes = new Map(); // exposed tool name -> { up, name }
  const promptRoutes = new Map();

  local.setRequestHandler(ListToolsRequestSchema, async () => {
    const all = [];
    routes.clear();
    for (const up of upstreams) {
      try {
        const { tools } = await guarded(up, () => up.client.listTools());
        for (const tool of tools) {
          const exposed = `${prefixFor(up)}${tool.name}`;
          routes.set(exposed, { up, name: tool.name });
          all.push({ ...tool, name: exposed });
        }
      } catch (error) {
        if (upstreams.length === 1) throw error;
        log(`[${up.name}] tools/list falló: ${error.message}`);
      }
    }
    return { tools: all };
  });

  const route = async (exposed) => {
    if (!routes.has(exposed)) {
      // tools/call before tools/list, or a stale list: refresh routing.
      for (const up of upstreams) {
        const p = prefixFor(up);
        if (exposed.startsWith(p)) return { up, name: exposed.slice(p.length) };
      }
      throw new Error(`Tool desconocida: ${exposed}`);
    }
    return routes.get(exposed);
  };

  local.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { up, name } = await route(request.params.name);
    return guarded(up, () => up.client.callTool({ name, arguments: request.params.arguments ?? {} }));
  });

  const collect = async (method, key, request) => {
    const out = [];
    for (const up of upstreams) {
      try {
        const result = await guarded(up, () => up.client[method](upstreams.length === 1 ? request?.params : undefined));
        for (const item of result[key] || []) out.push(item);
      } catch (error) {
        if (upstreams.length === 1) throw error;
      }
    }
    return { [key]: out };
  };

  local.setRequestHandler(ListResourcesRequestSchema, (r) => collect('listResources', 'resources', r));
  local.setRequestHandler(ListResourceTemplatesRequestSchema, (r) => collect('listResourceTemplates', 'resourceTemplates', r));
  local.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    let lastError;
    for (const up of upstreams) {
      try {
        return await guarded(up, () => up.client.readResource(request.params));
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('Sin upstreams');
  });
  local.setRequestHandler(ListPromptsRequestSchema, async (request) => {
    const out = [];
    promptRoutes.clear();
    for (const up of upstreams) {
      try {
        const { prompts } = await guarded(up, () => up.client.listPrompts(upstreams.length === 1 ? request.params : undefined));
        for (const prompt of prompts) {
          const exposed = `${prefixFor(up)}${prompt.name}`;
          promptRoutes.set(exposed, { up, name: prompt.name });
          out.push({ ...prompt, name: exposed });
        }
      } catch (error) {
        if (upstreams.length === 1) throw error;
      }
    }
    return { prompts: out };
  });
  local.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const hit = promptRoutes.get(request.params.name) || (await route(request.params.name));
    return guarded(hit.up, () => hit.up.client.getPrompt({ ...request.params, name: hit.name }));
  });
  return local;
}

async function runProxy(upstreams, opts) {
  const local = buildProxy(upstreams, opts);
  const shutdown = async () => {
    for (const up of upstreams) {
      try { await up.transport.close(); } catch {}
      try { await up.client.close(); } catch {}
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('close', shutdown);
  await local.connect(new StdioServerTransport());
}

async function cmdServe(args) {
  const [name] = args.positional;
  if (!name) throw new Error('Usage: serve <name>');
  const server = loadServer(name);
  const prefix = args.flags.prefix ? `${args.flags.prefix}__` : '';

  let up;
  try {
    up = await openUpstream(name, server, args);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      const msg = error.provider?.lastFailure || `requiere autorización OAuth. Ejecuta: ${loginHint(name)}`;
      log(`[${name}] ${msg}`);
      log(`[${name}] requiere autorización OAuth. Ejecuta: node ${fileURLToPath(import.meta.url)} login ${name}`);
      process.exit(2);
    }
    await notify('connect_failed', name, `no se pudo conectar: ${error.name}: ${error.message}`, { log });
    if (process.env.DSH_MCP_OAUTH_DEBUG) log(error.stack || String(error));
    process.exit(1);
  }

  await runProxy([up], { label: `dsh-oauth-${name}`, prefixFor: () => prefix });
  log(`[${name}] puente OAuth listo (${server.url})`);
}

/**
 * One stdio process for every server in servers.json (or --only a,b).
 * Tools are exposed as `<server>__<tool>`. Servers that fail to connect are
 * skipped with a clear error (and a notify) instead of killing the rest.
 */
async function cmdServeAll(args) {
  const servers = loadAllServers();
  const only = args.flags.only ? String(args.flags.only).split(',').map((x) => x.trim()).filter(Boolean) : Object.keys(servers);
  const upstreams = [];
  for (const name of only) {
    const entry = servers[name];
    if (!entry) { log(`[${name}] no está registrado; se omite.`); continue; }
    const server = typeof entry === 'string' ? { url: entry } : entry;
    try {
      upstreams.push(await openUpstream(name, server, args));
      log(`[${name}] conectado (${server.url})`);
    } catch (error) {
      const msg = error instanceof UnauthorizedError
        ? error.provider?.lastFailure || `sin autorizar; ejecuta: ${loginHint(name)}`
        : `no se pudo conectar: ${error.message}`;
      await notify(error instanceof UnauthorizedError ? 'reauth_required' : 'connect_failed', name, msg, { log });
    }
  }
  if (!upstreams.length) {
    log('serve-all: ningún servidor disponible.');
    process.exit(2);
  }
  await runProxy(upstreams, { label: 'dsh-oauth-all', prefixFor: (up) => `${up.name}__` });
  log(`serve-all listo: ${upstreams.map((u) => u.name).join(', ')}`);
}

/* ------------------------------------------------------------------ */
const USAGE = `MCP OAuth bridge (DSH)

  add <name> <url> [--scopes a,b] [--client-id X] [--client-secret Y]
  login <name> [--port N] [--no-open] [--skip-verify]
  login <name> --headless [--paste-back] [--port N]   (SSH/Tailscale, sin navegador)
  status <name>
  tools <name>
  logout <name> [--forget-client]
  serve <name> [--prefix p]
  serve-all [--only a,b]          un solo proceso stdio, tools como <server>__<tool>

Env: DSH_MCP_OAUTH_STORE=file|op|libsecret  DSH_MCP_OAUTH_OP_VAULT=...
     DSH_MCP_OAUTH_NOTIFY_CMD='sh command' (recibe MCP_OAUTH_EVENT/SERVER/MESSAGE)

State dir: ${ROOT}`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args.positional.shift() || 'help';
  ensureDirs();

  switch (command) {
    case 'add':
      return cmdAdd(args);
    case 'login':
    case 'auth':
      return cmdLogin(args);
    case 'status':
      return cmdStatus(args);
    case 'tools':
      return cmdTools(args);
    case 'logout':
      return cmdLogout(args);
    case 'serve':
      return cmdServe(args);
    case 'serve-all':
      return cmdServeAll(args);
    case 'help':
    case '--help':
      log(USAGE);
      return;
    default:
      // `bridge.mjs <name>` behaves like serve <name>, handy for configs.
      if (loadServerSafe(command)) {
        args.positional.unshift(command);
        return cmdServe(args);
      }
      log(USAGE);
      process.exit(1);
  }
}

function loadServerSafe(name) {
  try {
    loadServer(name);
    return true;
  } catch {
    return false;
  }
}

main().catch((error) => {
  log(`Error: ${error?.message || error}`);
  process.exit(1);
});
