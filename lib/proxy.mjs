/**
 * stdio MCP proxy over one or more OAuth-protected remote servers.
 *
 * Design notes:
 * - connections are lazy and retried; a remote being down at startup no longer
 *   kills the bridge or removes the server for the rest of the process;
 * - `serve` preserves upstream cursors; `serve-all` fetches all pages and
 *   prefixes tool/prompt names with `<server>__`;
 * - `_meta` (including progressToken) is forwarded on tools/call, progress is
 *   relayed, and cancellation is propagated through the request signal.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
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
import {
  CALL_TIMEOUT_MS,
  CONNECT_TIMEOUT_MS,
  MAX_PAGES,
  VERSION,
  describeError,
  redact,
  statePath,
} from './env.mjs';
import { notify } from './notify.mjs';
import { FileOAuthProvider, loginHint } from './provider.mjs';

const LIST_CAPABILITIES = ['tools', 'resources', 'prompts'];
const RETRYABLE = /session not found|session.*expired|not initialized|connection closed|socket hang up|econnreset|fetch failed|network/i;

function isRetryable(error) {
  if (!error) return false;
  if (error.code === 404 || error.code === 'ECONNRESET' || error.code === 'ECONNREFUSED') return true;
  return RETRYABLE.test(String(error.message || ''));
}

function isAuthFailure(error, record) {
  return error instanceof UnauthorizedError || Boolean(record?.provider?.lastFailure);
}

export class UpstreamManager {
  constructor({ entries, args, log = (m) => process.stderr.write(m + '\n') }) {
    this.entries = new Map(entries.map((entry) => [entry.name, entry.server]));
    this.args = args;
    this.log = log;
    this.clients = new Map();
    this.onListChanged = undefined;
  }

  names() {
    return [...this.entries.keys()];
  }

  connected() {
    return [...this.clients.values()].filter((record) => record.client);
  }

  makeProvider(name, server, { interactive = false } = {}) {
    return new FileOAuthProvider({
      name,
      file: statePath(name),
      server,
      redirectUrl: new URL(
        `http://127.0.0.1:${Number(this.args?.flags?.port || 33418)}/callback`,
      ),
      scope: this.args?.flags?.scopes ?? server.scopes,
      clientId: this.args?.flags?.['client-id'] ?? server.clientId,
      clientSecret: this.args?.flags?.['client-secret'],
      clientSecretEnv: this.args?.flags?.['client-secret-env'] ?? server.clientSecretEnv,
      tokenAuthMethod: this.args?.flags?.['token-auth-method'] ?? server.tokenAuthMethod,
      authorizationServer: this.args?.flags?.['authorization-server'] ?? server.authorizationServer,
      authParams: parseAuthParams(this.args?.flags?.['auth-param'], server.authParams),
      interactive,
      log: this.log,
    });
  }

  async connect(name) {
    const existing = this.clients.get(name);
    if (existing?.client) return existing;
    if (existing?.promise) return existing.promise;
    if (existing?.retryAt && Date.now() < existing.retryAt && existing.lastError) {
      throw existing.lastError;
    }

    const server = this.entries.get(name);
    if (!server) throw new Error(`Server "${name}" is not registered.`);

    const record =
      existing ||
      {
        name,
        server,
        client: undefined,
        transport: undefined,
        provider: undefined,
        lastError: undefined,
        retryAt: 0,
        promise: undefined,
      };
    this.clients.set(name, record);

    record.promise = (async () => {
      const provider = this.makeProvider(name, server);
      let client;
      let transport;
      try {
        await provider.init();
        const state = provider.snapshot();
        if (!state.tokens?.access_token && !state.tokens?.refresh_token) {
          provider.lastFailure = `no tokens; run: ${loginHint(name)}`;
          const unauthorized = new UnauthorizedError(provider.lastFailure);
          /** @type {any} */ (unauthorized).provider = provider;
          throw unauthorized;
        }
        client = new Client(
          { name: `oauth-mcp-bridge:${name}`, version: VERSION },
          /** @type {any} */ ({
            capabilities: {},
            fallbackNotificationHandler: async (notification) => {
              if (String(notification?.method || '').endsWith('/list_changed')) {
                this.onListChanged?.(name, notification.method);
              }
            },
          }),
        );
        transport = new StreamableHTTPClientTransport(new URL(server.url), {
          authProvider: provider,
        });
        await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
        record.client = client;
        record.transport = transport;
        record.provider = provider;
        record.lastError = undefined;
        record.retryAt = 0;
        this.log(`[${name}] connected (${server.url})`);
        this.onListChanged?.(name, 'notifications/tools/list_changed');
        return record;
      } catch (error) {
        if (transport) await transport.close().catch(() => {});
        if (client) await client.close().catch(() => {});
        error.provider = provider;
        record.provider = provider;
        record.lastError = error;
        record.retryAt = isAuthFailure(error, record) ? 0 : Date.now() + 30_000;
        throw error;
      } finally {
        record.promise = undefined;
      }
    })();

    return record.promise;
  }

  async connectAll() {
    const results = await Promise.allSettled(this.names().map((name) => this.connect(name)));
    const failures = [];
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        failures.push({ name: this.names()[index], error: result.reason });
      }
    });
    return failures;
  }

  async get(name) {
    const record = this.clients.get(name);
    if (record?.client) return record;
    return this.connect(name);
  }

  supports(name, capability) {
    const record = this.clients.get(name);
    // Not connected yet: try, then use the discovered capabilities on later calls.
    if (!record?.client) return true;
    const capabilities = record.client.getServerCapabilities?.() || {};
    return Boolean(capabilities[capability]);
  }

  async withUpstream(name, fn, { retry = false } = {}) {
    let record;
    try {
      record = await this.get(name);
      const result = await fn(record);
      if (record.provider) record.provider.lastFailure = undefined;
      return result;
    } catch (error) {
      const provider = record?.provider || error.provider;
      if (isAuthFailure(error, { provider })) {
        const message =
          provider?.lastFailure ||
          `not authorized (${describeError(error)}); run: ${loginHint(name)}`;
        if (!provider?.lastFailure) {
          await notify(provider?.hadTokens ? 'refresh_failed' : 'reauth_required', name, message, {
            log: this.log,
          });
        }
        throw new Error(`[${name}] ${message}`);
      }
      if (retry && isRetryable(error)) {
        this.log(`[${name}] connection lost, reconnecting...`);
        await this.drop(name);
        record = await this.connect(name);
        return fn(record);
      }
      throw error;
    }
  }

  async drop(name) {
    const record = this.clients.get(name);
    if (!record) return;
    this.clients.delete(name);
    await record.transport?.close().catch(() => {});
    await record.client?.close().catch(() => {});
  }

  async close() {
    await Promise.allSettled(
      [...this.clients.values()].map(async (record) => {
        await record.transport?.close().catch(() => {});
        await record.client?.close().catch(() => {});
      }),
    );
    this.clients.clear();
  }

  capabilities() {
    // Declare all three so the local Server allows the corresponding handlers.
    // The handlers return empty lists when no connected upstream supports them.
    const capabilities = { tools: {}, resources: {}, prompts: {} };
    for (const record of this.connected()) {
      const remote = record.client.getServerCapabilities?.() || {};
      for (const key of LIST_CAPABILITIES) {
        if (remote[key]) capabilities[key] = { ...(capabilities[key] || {}), ...remote[key] };
      }
    }
    return capabilities;
  }

  instructions() {
    const parts = [];
    for (const record of this.connected()) {
      const text = record.client.getInstructions?.();
      if (text) parts.push(this.entries.size > 1 ? `[${record.name}]\n${text}` : text);
    }
    return parts.join('\n\n') || undefined;
  }
}

export function parseAuthParams(values, extra = []) {
  const pairs = [];
  const add = (key, value) => {
    if (!/^[A-Za-z0-9._~-]+$/.test(key)) throw new Error(`Invalid auth parameter name "${key}".`);
    pairs.push([key, String(value)]);
  };
  if (values) {
    for (const raw of Array.isArray(values) ? values : [values]) {
      const index = String(raw).indexOf('=');
      if (index <= 0) throw new Error(`Invalid --auth-param ${JSON.stringify(raw)} (expected key=value).`);
      add(String(raw).slice(0, index), String(raw).slice(index + 1));
    }
  }
  if (Array.isArray(extra)) {
    for (const item of extra) {
      if (Array.isArray(item) && item.length === 2) add(item[0], item[1]);
      else if (item && typeof item === 'object') {
        for (const [key, value] of Object.entries(item)) add(key, value);
      }
    }
  }
  return pairs;
}

async function listAll(client, method, key, params) {
  const items = [];
  let cursor = params?.cursor;
  const seen = new Set();
  let pages = 0;
  for (;;) {
    const result = await client[method]({ ...(params || {}), cursor }, { timeout: CALL_TIMEOUT_MS });
    items.push(...(result[key] || []));
    const next = result.nextCursor;
    pages++;
    if (!next || seen.has(next) || pages >= MAX_PAGES) break;
    seen.add(next);
    cursor = next;
  }
  return items;
}

function progressRelay(extra, request) {
  const progressToken = request.params?._meta?.progressToken;
  if (!progressToken || !extra?.sendNotification) return undefined;
  return (progress) => {
    extra
      .sendNotification({
        method: 'notifications/progress',
        params: { progressToken, ...progress },
      })
      .catch(() => {});
  };
}

/**
 * Build the local stdio MCP server.
 * `prefixFor(name)` returns '' for single-server serve without --prefix,
 * or `<prefix>__` / `<server>__` for prefixed modes.
 */
export function buildProxy(manager, { label, prefixFor }) {
  const local = new Server(
    { name: label, version: VERSION },
    { capabilities: manager.capabilities(), instructions: manager.instructions() },
  );
  const toolRoutes = new Map();
  const promptRoutes = new Map();
  const resourceOwners = new Map();
  const names = () => manager.names();

  manager.onListChanged = (name, method) => {
    const capabilities = manager.capabilities();
    const notifications = [];
    if (method !== 'notifications/resources/list_changed' || capabilities.resources) {
      notifications.push('notifications/tools/list_changed');
    }
    if (capabilities.resources) notifications.push('notifications/resources/list_changed');
    if (capabilities.prompts) notifications.push('notifications/prompts/list_changed');
    for (const notification of new Set(notifications)) {
      local.notification({ method: notification }).catch(() => {});
    }
  };

  const resolveTool = (exposed) => {
    const hit = toolRoutes.get(exposed);
    if (hit) return hit;
    for (const name of names()) {
      const prefix = prefixFor(name);
      if (prefix && exposed.startsWith(prefix)) {
        return { up: name, name: exposed.slice(prefix.length) };
      }
    }
    if (names().length === 1) return { up: names()[0], name: exposed };
    throw new Error(`Unknown tool: ${exposed}`);
  };

  const resolvePrompt = (exposed) => {
    const hit = promptRoutes.get(exposed);
    if (hit) return hit;
    for (const name of names()) {
      const prefix = prefixFor(name);
      if (prefix && exposed.startsWith(prefix)) {
        return { up: name, name: exposed.slice(prefix.length) };
      }
    }
    if (names().length === 1) return { up: names()[0], name: exposed };
    throw new Error(`Unknown prompt: ${exposed}`);
  };

  local.setRequestHandler(ListToolsRequestSchema, async (request) => {
    toolRoutes.clear();
    const upstreams = names();
    if (upstreams.length === 1) {
      const name = upstreams[0];
      if (!manager.supports(name, 'tools')) return { tools: [] };
      const page = await manager.withUpstream(
        name,
        (record) => listAll(record.client, 'listTools', 'tools', request.params),
        { retry: true },
      );
      const tools = (page || []).map((tool) => {
        const exposed = `${prefixFor(name)}${tool.name}`;
        toolRoutes.set(exposed, { up: name, name: tool.name });
        return { ...tool, name: exposed };
      });
      return { tools };
    }

    const tools = [];
    for (const name of upstreams) {
      if (!manager.supports(name, 'tools')) continue;
      try {
        const page = await manager.withUpstream(
          name,
          (record) => listAll(record.client, 'listTools', 'tools', request.params),
          { retry: true },
        );
        for (const tool of page) {
          const exposed = `${prefixFor(name)}${tool.name}`;
          toolRoutes.set(exposed, { up: name, name: tool.name });
          tools.push({ ...tool, name: exposed });
        }
      } catch (error) {
        manager.log(`[${name}] tools/list failed: ${error.message}`);
      }
    }
    return { tools };
  });

  local.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const route = resolveTool(request.params.name);
    const options = {
      signal: extra?.signal,
      timeout: CALL_TIMEOUT_MS,
      resetTimeoutOnProgress: true,
      onprogress: progressRelay(extra, request),
    };
    return manager.withUpstream(route.up, (record) =>
      record.client.callTool({ ...request.params, name: route.name }, undefined, options),
    );
  });

  local.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    resourceOwners.clear();
    const upstreams = names();
    if (upstreams.length === 1) {
      const name = upstreams[0];
      if (!manager.supports(name, 'resources')) return { resources: [] };
      const page = await manager.withUpstream(
        name,
        (record) => listAll(record.client, 'listResources', 'resources', request.params),
        { retry: true },
      );
      for (const resource of page || []) resourceOwners.set(resource.uri, name);
      return { resources: page || [] };
    }
    const resources = [];
    for (const name of upstreams) {
      if (!manager.supports(name, 'resources')) continue;
      try {
        const page = await manager.withUpstream(
          name,
          (record) => listAll(record.client, 'listResources', 'resources', request.params),
          { retry: true },
        );
        for (const resource of page) {
          if (resourceOwners.has(resource.uri)) {
            manager.log(`[${name}] resource URI collision ignored: ${resource.uri}`);
            continue;
          }
          resourceOwners.set(resource.uri, name);
          resources.push(resource);
        }
      } catch (error) {
        manager.log(`[${name}] resources/list failed: ${error.message}`);
      }
    }
    return { resources };
  });

  local.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
    const upstreams = names();
    if (upstreams.length === 1) {
      const name = upstreams[0];
      if (!manager.supports(name, 'resources')) return { resourceTemplates: [] };
      const page = await manager.withUpstream(
        name,
        (record) => listAll(record.client, 'listResourceTemplates', 'resourceTemplates', request.params),
        { retry: true },
      );
      return { resourceTemplates: page || [] };
    }
    const resourceTemplates = [];
    for (const name of upstreams) {
      if (!manager.supports(name, 'resources')) continue;
      try {
        const page = await manager.withUpstream(
          name,
          (record) => listAll(record.client, 'listResourceTemplates', 'resourceTemplates', request.params),
          { retry: true },
        );
        resourceTemplates.push(...page);
      } catch (error) {
        manager.log(`[${name}] resources/templates/list failed: ${error.message}`);
      }
    }
    return { resourceTemplates };
  });

  local.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
    const owner = resourceOwners.get(request.params.uri);
    const candidates = owner ? [owner] : names();
    let lastError;
    for (const name of candidates) {
      if (!manager.supports(name, 'resources')) continue;
      try {
        return await manager.withUpstream(name, (record) =>
          record.client.readResource(request.params, {
            timeout: CALL_TIMEOUT_MS,
            signal: extra?.signal,
          }),
        );
      } catch (error) {
        lastError = error;
        if (owner) break;
      }
    }
    throw lastError || new Error(`No upstream can read resource ${request.params.uri}`);
  });

  local.setRequestHandler(ListPromptsRequestSchema, async (request) => {
    promptRoutes.clear();
    const upstreams = names();
    if (upstreams.length === 1) {
      const name = upstreams[0];
      if (!manager.supports(name, 'prompts')) return { prompts: [] };
      const page = await manager.withUpstream(
        name,
        (record) => listAll(record.client, 'listPrompts', 'prompts', request.params),
        { retry: true },
      );
      const prompts = (page || []).map((prompt) => {
        const exposed = `${prefixFor(name)}${prompt.name}`;
        promptRoutes.set(exposed, { up: name, name: prompt.name });
        return { ...prompt, name: exposed };
      });
      return { prompts };
    }
    const prompts = [];
    for (const name of upstreams) {
      if (!manager.supports(name, 'prompts')) continue;
      try {
        const page = await manager.withUpstream(
          name,
          (record) => listAll(record.client, 'listPrompts', 'prompts', request.params),
          { retry: true },
        );
        for (const prompt of page) {
          const exposed = `${prefixFor(name)}${prompt.name}`;
          promptRoutes.set(exposed, { up: name, name: prompt.name });
          prompts.push({ ...prompt, name: exposed });
        }
      } catch (error) {
        manager.log(`[${name}] prompts/list failed: ${error.message}`);
      }
    }
    return { prompts };
  });

  local.setRequestHandler(GetPromptRequestSchema, async (request, extra) => {
    const route = resolvePrompt(request.params.name);
    return manager.withUpstream(route.up, (record) =>
      record.client.getPrompt(
        { ...request.params, name: route.name },
        { timeout: CALL_TIMEOUT_MS, signal: extra?.signal },
      ),
    );
  });

  return local;
}

export async function runProxy(proxy, manager, { locks = [] } = {}) {
  let shuttingDown = false;
  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const lock of locks) await lock.release().catch(() => {});
    await manager.close().catch(() => {});
    process.exit(code);
  };

  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));
  process.stdin.on('close', () => void shutdown(0));
  process.on('uncaughtException', (error) => {
    process.stderr.write(`Uncaught exception: ${redact(describeError(error))}\n`);
    void shutdown(1);
  });
  process.on('unhandledRejection', (error) => {
    // Keep serving: a rejected notification must not take down a long-lived bridge.
    process.stderr.write(`Unhandled rejection: ${redact(describeError(error))}\n`);
  });

  await proxy.connect(new StdioServerTransport());
}
