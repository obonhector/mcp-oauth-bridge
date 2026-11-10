#!/usr/bin/env node
/**
 * Local OAuth-protected MCP server used by the test suite.
 *
 * It is deliberately strict: state, resource indicator, scopes and client
 * authentication are validated. Optional modes let tests exercise failure paths.
 *
 * Env:
 *   MOCK_ACCESS_TTL=2
 *   MOCK_STATIC_CLIENT=<client_id>  MOCK_STATIC_SECRET=<secret>
 *   MOCK_STATE_MODE=echo|omit|wrong
 *   MOCK_AUTHORIZE=allow|deny
 *   MOCK_PAGINATE=1
 *   MOCK_RESOURCES=1  MOCK_PROMPTS=1  MOCK_META=1
 *   MOCK_SCOPES="test:read test:write"
 *   MOCK_REQUIRE_RESOURCE=1  MOCK_REQUIRE_SCOPE=1  MOCK_REFRESH_ROTATE=1
 *
 * Prints `PORT=<n>` on stdout when ready.
 */
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const ACCESS_TTL_SECONDS = Number(process.env.MOCK_ACCESS_TTL || 2);
const STATIC_CLIENT_ID = process.env.MOCK_STATIC_CLIENT || '';
const STATIC_SECRET = process.env.MOCK_STATIC_SECRET || '';
const STATE_MODE = process.env.MOCK_STATE_MODE || 'echo';
const AUTHORIZE_MODE = process.env.MOCK_AUTHORIZE || 'allow';
const PAGINATE = process.env.MOCK_PAGINATE === '1';
const RESOURCES = process.env.MOCK_RESOURCES === '1';
const PROMPTS = process.env.MOCK_PROMPTS === '1';
const META_TOOL = process.env.MOCK_META === '1';
const REQUIRE_RESOURCE = process.env.MOCK_REQUIRE_RESOURCE !== '0';
const REQUIRE_SCOPE = process.env.MOCK_REQUIRE_SCOPE !== '0';
const ROTATE_REFRESH = process.env.MOCK_REFRESH_ROTATE !== '0';
const SCOPES = (process.env.MOCK_SCOPES || 'test:read test:write').split(/\s+/).filter(Boolean);

const stats = {
  registrations: 0,
  authorize: 0,
  tokens: 0,
  refreshes: 0,
  revokes: 0,
  mcpCalls: 0,
  unauthorized: 0,
  errors: 0,
  listCalls: 0,
  metaCalls: 0,
};
const clients = new Map(); // client_id -> { redirect_uris, client_secret }
const codes = new Map(); // code -> { challenge, redirect_uri, client_id, scope, resource }
const accessTokens = new Map(); // token -> { expiry, client_id, scope }
const refreshTokens = new Map(); // token -> { client_id, scope }
const sessions = new Map(); // mcp-session-id -> transport

function createMcpServer() {
  const capabilities = { tools: {} };
  if (RESOURCES) capabilities.resources = {};
  if (PROMPTS) capabilities.prompts = {};
  const server = new Server({ name: 'mock-mcp', version: '1.0.0' }, { capabilities });

  const allTools = () => {
    const tools = [
      {
        name: 'echo',
        description: 'Returns the text it receives',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      },
      { name: 'server_time', description: 'Server time', inputSchema: { type: 'object', properties: {} } },
    ];
    if (META_TOOL) {
      tools.push({
        name: 'echo_meta',
        description: 'Echoes the progress token from _meta',
        inputSchema: { type: 'object', properties: {} },
      });
    }
    return tools;
  };

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    stats.listCalls++;
    if (PAGINATE) {
      if (!request.params?.cursor) return { tools: [allTools()[0]], nextCursor: 'page2' };
      if (request.params.cursor === 'page2') return { tools: allTools().slice(1) };
      return { tools: [] };
    }
    return { tools: allTools() };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    stats.mcpCalls++;
    const meta = request.params?._meta;
    if (request.params.name === 'echo') {
      if (meta?.progressToken) {
        await server.notification({
          method: 'notifications/progress',
          params: { progressToken: meta.progressToken, progress: 1, total: 2, message: 'halfway' },
        });
      }
      return { content: [{ type: 'text', text: `echo: ${request.params.arguments?.text ?? ''}` }] };
    }
    if (request.params.name === 'echo_meta') {
      stats.metaCalls++;
      return {
        content: [{ type: 'text', text: `meta:${meta?.progressToken ?? 'none'}` }],
      };
    }
    return { content: [{ type: 'text', text: new Date().toISOString() }] };
  });

  if (RESOURCES) {
    const resources = [
      { uri: 'mock://doc/one', name: 'One', mimeType: 'text/plain' },
      { uri: 'mock://doc/two', name: 'Two', mimeType: 'text/plain' },
    ];
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources }));
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
      resourceTemplates: [{ uriTemplate: 'mock://doc/{id}', name: 'Doc' }],
    }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      if (!request.params.uri.startsWith('mock://doc/')) {
        throw new Error(`Unknown resource ${request.params.uri}`);
      }
      return {
        contents: [
          { uri: request.params.uri, mimeType: 'text/plain', text: `resource:${request.params.uri}` },
        ],
      };
    });
  }

  if (PROMPTS) {
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: [
        {
          name: 'mock_prompt',
          description: 'A test prompt',
          arguments: [{ name: 'topic', description: 'Topic', required: true }],
        },
      ],
    }));
    server.setRequestHandler(GetPromptRequestSchema, async (request) => ({
      description: 'A test prompt',
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: `prompt:${request.params.name}:${request.params.arguments?.topic ?? ''}` },
        },
      ],
    }));
  }

  return server;
}

async function handleMcpRequest(req, res, body) {
  const sessionId = req.headers['mcp-session-id'];
  let transport = sessionId ? sessions.get(sessionId) : undefined;

  if (!transport) {
    if (req.method !== 'POST') {
      return json(res, 400, { jsonrpc: '2.0', error: { code: -32000, message: 'Missing session ID' }, id: null });
    }
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: false,
      onsessioninitialized: (sid) => {
        sessions.set(sid, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await createMcpServer().connect(transport);
  }

  await transport.handleRequest(req, res, body);
}

function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function validScopes(scope) {
  if (!scope) return REQUIRE_SCOPE ? undefined : [];
  if (scope.includes(',')) return undefined;
  const requested = scope.split(/\s+/).filter(Boolean);
  return requested.every((name) => SCOPES.includes(name)) ? requested : undefined;
}

function clientById(id) {
  if (clients.has(id)) return clients.get(id);
  if (STATIC_CLIENT_ID && id === STATIC_CLIENT_ID) {
    return { redirect_uris: [], client_secret: STATIC_SECRET || undefined, static: true };
  }
  return undefined;
}

function checkClientAuth(req, params, client, clientId) {
  if (!client?.client_secret) return true;
  const header = req.headers.authorization || '';
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const index = decoded.indexOf(':');
    return decoded.slice(0, index) === clientId && decoded.slice(index + 1) === client.client_secret;
  }
  return params.get('client_id') === clientId && params.get('client_secret') === client.client_secret;
}

function issueTokens(clientId, scope) {
  const accessToken = `at-${randomUUID()}`;
  const refreshToken = `rt-${randomUUID()}`;
  accessTokens.set(accessToken, {
    expiry: Date.now() + ACCESS_TTL_SECONDS * 1000,
    client_id: clientId,
    scope,
  });
  refreshTokens.set(refreshToken, { client_id: clientId, scope });
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_SECONDS,
    scope,
  };
}

const server = createServer(async (req, res) => {
  const base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  const url = new URL(req.url, base);

  try {
    if (
      url.pathname === '/.well-known/oauth-protected-resource' ||
      url.pathname === '/.well-known/oauth-protected-resource/mcp'
    ) {
      return json(res, 200, {
        resource: `${base}/mcp`,
        authorization_servers: [base],
        scopes_supported: SCOPES,
        bearer_methods_supported: ['header'],
      });
    }
    if (
      url.pathname === '/.well-known/oauth-authorization-server' ||
      url.pathname === '/.well-known/oauth-authorization-server/mcp'
    ) {
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        revocation_endpoint: `${base}/revoke`,
        scopes_supported: SCOPES,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
      });
    }

    if (url.pathname === '/register' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) {
        return json(res, 400, { error: 'invalid_redirect_uri' });
      }
      const client_id = `mock-client-${randomUUID()}`;
      clients.set(client_id, { redirect_uris: body.redirect_uris, client_name: body.client_name });
      stats.registrations++;
      return json(res, 201, {
        client_id,
        redirect_uris: body.redirect_uris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      });
    }

    if (url.pathname === '/authorize' && req.method === 'GET') {
      const clientId = url.searchParams.get('client_id');
      const redirectUri = url.searchParams.get('redirect_uri');
      const challenge = url.searchParams.get('code_challenge');
      const state = url.searchParams.get('state');
      const scope = url.searchParams.get('scope');
      const resource = url.searchParams.get('resource');
      const client = clientById(clientId);

      if (!client) return json(res, 400, { error: 'invalid_client' });
      if (!client.static && !client.redirect_uris.includes(redirectUri)) {
        return json(res, 400, { error: 'invalid_redirect_uri' });
      }
      if (!challenge || url.searchParams.get('code_challenge_method') !== 'S256') {
        return json(res, 400, { error: 'invalid_request', error_description: 'PKCE S256 required' });
      }
      if (REQUIRE_RESOURCE && resource !== `${base}/mcp`) {
        return json(res, 400, { error: 'invalid_target', error_description: 'resource indicator missing or wrong' });
      }
      if (REQUIRE_SCOPE && !validScopes(scope)) {
        return json(res, 400, { error: 'invalid_scope', error_description: 'scope must be space-delimited and supported' });
      }
      if (!state) {
        return json(res, 400, { error: 'invalid_request', error_description: 'state required' });
      }
      stats.authorize++;

      const location = new URL(redirectUri);
      if (AUTHORIZE_MODE === 'deny') {
        location.searchParams.set('error', 'access_denied');
        location.searchParams.set('error_description', 'user denied the request');
      } else {
        const code = randomUUID();
        codes.set(code, {
          challenge,
          redirect_uri: redirectUri,
          client_id: clientId,
          scope: scope || SCOPES.join(' '),
          resource,
        });
        location.searchParams.set('code', code);
      }
      if (STATE_MODE === 'echo') location.searchParams.set('state', state);
      else if (STATE_MODE === 'wrong') location.searchParams.set('state', 'wrong-state');
      // omit: no state at all
      res.writeHead(302, { location: location.href }).end();
      return;
    }

    if (url.pathname === '/token' && req.method === 'POST') {
      const params = new URLSearchParams(await readBody(req));
      const grant = params.get('grant_type');

      if (grant === 'authorization_code') {
        const record = codes.get(params.get('code'));
        if (!record) return json(res, 400, { error: 'invalid_grant' });
        if (params.get('redirect_uri') !== record.redirect_uri) {
          return json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
        }
        const verifier = params.get('code_verifier') || '';
        const computed = createHash('sha256').update(verifier).digest('base64url');
        if (computed !== record.challenge) {
          return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE mismatch' });
        }
        const client = clientById(record.client_id);
        if (!checkClientAuth(req, params, client, record.client_id)) {
          return json(res, 401, { error: 'invalid_client' });
        }
        codes.delete(params.get('code'));
        stats.tokens++;
        return json(res, 200, issueTokens(record.client_id, record.scope));
      }

      if (grant === 'refresh_token') {
        const current = refreshTokens.get(params.get('refresh_token'));
        if (!current) return json(res, 400, { error: 'invalid_grant' });
        if (params.get('client_id') && params.get('client_id') !== current.client_id) {
          return json(res, 400, { error: 'invalid_grant', error_description: 'client mismatch' });
        }
        const client = clientById(current.client_id);
        if (!checkClientAuth(req, params, client, current.client_id)) {
          return json(res, 401, { error: 'invalid_client' });
        }
        if (ROTATE_REFRESH) refreshTokens.delete(params.get('refresh_token'));
        stats.refreshes++;
        return json(res, 200, issueTokens(current.client_id, current.scope));
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }

    if (url.pathname === '/revoke' && req.method === 'POST') {
      const params = new URLSearchParams(await readBody(req));
      const token = params.get('token');
      accessTokens.delete(token);
      refreshTokens.delete(token);
      stats.revokes++;
      return json(res, 200, {});
    }

    if (url.pathname === '/mcp') {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const record = accessTokens.get(token);
      if (!record || record.expiry < Date.now()) {
        stats.unauthorized++;
        return json(
          res,
          401,
          { jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null },
          {
            'www-authenticate': `Bearer error="invalid_token", resource_metadata="${base}/.well-known/oauth-protected-resource"`,
          },
        );
      }
      const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || '{}') : undefined;
      try {
        await handleMcpRequest(req, res, body);
      } catch (error) {
        stats.errors++;
        process.stderr.write(`[mock] handleRequest error: ${error?.stack || error}\n`);
        if (!res.headersSent) json(res, 500, { error: 'mock_failure', detail: String(error?.message || error) });
      }
      return;
    }

    if (url.pathname === '/__mint') {
      const access_token = `at-${randomUUID()}`;
      accessTokens.set(access_token, { expiry: Date.now() + ACCESS_TTL_SECONDS * 1000, client_id: 'mint', scope: SCOPES.join(' ') });
      return json(res, 200, { access_token, expires_in: ACCESS_TTL_SECONDS });
    }
    if (url.pathname === '/__stats') return json(res, 200, stats);
    return json(res, 404, { error: 'not_found' });
  } catch (error) {
    stats.errors++;
    process.stderr.write(`[mock] request error: ${error?.stack || error}\n`);
    if (!res.headersSent) json(res, 500, { error: 'mock_failure', detail: String(error?.message || error) });
  }
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`PORT=${/** @type {any} */ (server.address()).port}\n`);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
