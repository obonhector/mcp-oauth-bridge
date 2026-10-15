#!/usr/bin/env node
/**
 * Local mock of an OAuth-protected MCP server, used to prove the bridge
 * end-to-end without touching any real account.
 *
 * Implements: RFC 9728 protected-resource metadata, RFC 8414 AS metadata,
 * RFC 7591 dynamic client registration, authorization code + PKCE (S256),
 * refresh tokens, and a stateful streamable-HTTP MCP endpoint with two tools.
 *
 * Prints `PORT=<n>` on stdout when ready.
 */
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const ACCESS_TTL_SECONDS = Number(process.env.MOCK_ACCESS_TTL || 2);
const STATIC_CLIENT_ID = process.env.MOCK_STATIC_CLIENT || '';
const stats = { registrations: 0, authorize: 0, tokens: 0, refreshes: 0, mcpCalls: 0, unauthorized: 0, errors: 0 };
const clients = new Map(); // client_id -> { redirect_uris }
const codes = new Map(); // code -> { challenge, redirect_uri, client_id }
const accessTokens = new Map(); // token -> expiry epoch ms
const refreshTokens = new Map(); // token -> client_id
const sessions = new Map(); // mcp-session-id -> transport

function createMcpServer() {
  const server = new Server({ name: 'mock-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'echo',
        description: 'Devuelve el texto recibido',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      },
      { name: 'server_time', description: 'Hora del servidor', inputSchema: { type: 'object', properties: {} } },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    stats.mcpCalls++;
    if (request.params.name === 'echo') {
      return { content: [{ type: 'text', text: `echo: ${request.params.arguments?.text ?? ''}` }] };
    }
    return { content: [{ type: 'text', text: new Date().toISOString() }] };
  });
  return server;
}

/** One transport per MCP session, the pattern the SDK documents. */
async function handleMcpRequest(req, res, body) {
  const sessionId = req.headers['mcp-session-id'];
  let transport = sessionId ? sessions.get(sessionId) : undefined;

  if (!transport) {
    if (req.method !== 'POST') {
      return json(res, 400, { jsonrpc: '2.0', error: { code: -32000, message: 'Missing session ID' }, id: null });
    }
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sid) => sessions.set(sid, transport),
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

const server = createServer(async (req, res) => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const url = new URL(req.url, base);

  try {
    // ---- discovery -------------------------------------------------
    if (
      url.pathname === '/.well-known/oauth-protected-resource' ||
      url.pathname === '/.well-known/oauth-protected-resource/mcp'
    ) {
      return json(res, 200, {
        resource: `${base}/mcp`,
        authorization_servers: [base],
        scopes_supported: ['test:read'],
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
        scopes_supported: ['test:read'],
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    }

    // ---- dynamic client registration --------------------------------
    if (url.pathname === '/register' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) {
        return json(res, 400, { error: 'invalid_redirect_uri' });
      }
      const client_id = `mock-client-${randomUUID()}`;
      clients.set(client_id, { redirect_uris: body.redirect_uris });
      stats.registrations++;
      return json(res, 201, {
        client_id,
        redirect_uris: body.redirect_uris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      });
    }

    // ---- authorization ---------------------------------------------
    if (url.pathname === '/authorize' && req.method === 'GET') {
      const client_id = url.searchParams.get('client_id');
      const redirect_uri = url.searchParams.get('redirect_uri');
      const challenge = url.searchParams.get('code_challenge');
      // A pre-registered client (no dynamic registration) is accepted as-is.
      const client =
        clients.get(client_id) ??
        (STATIC_CLIENT_ID && client_id === STATIC_CLIENT_ID ? { redirect_uris: [redirect_uri] } : undefined);
      if (!client || !client.redirect_uris.includes(redirect_uri)) {
        return json(res, 400, { error: 'invalid_client' });
      }
      if (!challenge || url.searchParams.get('code_challenge_method') !== 'S256') {
        return json(res, 400, { error: 'invalid_request', error_description: 'PKCE S256 required' });
      }
      const code = randomUUID();
      codes.set(code, { challenge, redirect_uri, client_id });
      stats.authorize++;
      const location = new URL(redirect_uri);
      location.searchParams.set('code', code);
      const returnedState = url.searchParams.get('state');
      if (returnedState) location.searchParams.set('state', returnedState);
      res.writeHead(302, { location: location.href }).end();
      return;
    }

    // ---- token ------------------------------------------------------
    if (url.pathname === '/token' && req.method === 'POST') {
      const params = new URLSearchParams(await readBody(req));
      const grant = params.get('grant_type');

      if (grant === 'authorization_code') {
        const record = codes.get(params.get('code'));
        if (!record) return json(res, 400, { error: 'invalid_grant' });
        const verifier = params.get('code_verifier') || '';
        const computed = createHash('sha256').update(verifier).digest('base64url');
        if (computed !== record.challenge) {
          return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE mismatch' });
        }
        codes.delete(params.get('code'));
        stats.tokens++;
        return json(res, 200, issueTokens(record.client_id));
      }

      if (grant === 'refresh_token') {
        const client_id = refreshTokens.get(params.get('refresh_token'));
        if (!client_id) return json(res, 400, { error: 'invalid_grant' });
        stats.refreshes++;
        return json(res, 200, issueTokens(client_id));
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }

    // ---- MCP endpoint ------------------------------------------------
    if (url.pathname === '/mcp') {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const expiry = accessTokens.get(token);
      if (!expiry || expiry < Date.now()) {
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

    // ---- test-only helpers -------------------------------------------
    if (url.pathname === '/__mint') {
      const access_token = `at-${randomUUID()}`;
      accessTokens.set(access_token, Date.now() + ACCESS_TTL_SECONDS * 1000);
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

function issueTokens(client_id) {
  const access_token = `at-${randomUUID()}`;
  const refresh_token = `rt-${randomUUID()}`;
  accessTokens.set(access_token, Date.now() + ACCESS_TTL_SECONDS * 1000);
  refreshTokens.set(refresh_token, client_id);
  return {
    access_token,
    refresh_token,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_SECONDS,
    scope: 'test:read',
  };
}

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`PORT=${server.address().port}\n`);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
