/**
 * Loopback OAuth callback server and paste-back helper.
 *
 * Security properties:
 * - binds only to loopback addresses;
 * - requires an exact `state` match (a missing state is a failure, not a pass);
 * - `state` and the PKCE verifier are single-use (cleared after token exchange);
 * - responses are non-cacheable and do not leak the authorization code via Referer.
 */
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { LOGIN_TIMEOUT_MS } from './env.mjs';

const HTML_OK =
  '<!doctype html><meta charset="utf-8"><title>Authorized</title>' +
  '<h2>Authorized ✅</h2><p>You can close this tab and return to your terminal.</p>';

function headers(contentType = 'text/plain; charset=utf-8') {
  return {
    'content-type': contentType,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  };
}

function listen(host, port, onRequest) {
  return new Promise((resolve, reject) => {
    const server = createServer(onRequest);
    const onError = (error) => {
      server.close();
      reject(error);
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve(server);
    });
  });
}

/**
 * Start the callback listener. Returns `{ code, port, redirectUrl, close }`.
 * `code` resolves with the authorization code; it rejects on OAuth errors,
 * state mismatch, timeout or explicit close.
 */
export async function startCallbackServer({
  port = 33418,
  host = '127.0.0.1',
  path = '/callback',
  provider,
  timeoutMs = LOGIN_TIMEOUT_MS,
  log = (m) => process.stderr.write(m + '\n'),
}) {
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    throw new Error(`Refusing to bind the OAuth callback to non-loopback host "${host}".`);
  }
  const bindHost = host === 'localhost' ? '127.0.0.1' : host.replace(/^\[|\]$/g, '');

  let settle = { resolve: (_value) => {}, reject: (_error) => {} };
  const code = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  // A login that is already authorized never awaits `code`; avoid unhandled rejections.
  code.catch(() => {});

  const servers = [];
  let done = false;
  let timer;

  const finish = (fn, value) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    for (const server of servers) {
      try {
        server.close();
      } catch {
        /* ignore */
      }
    }
    fn(value);
  };

  const handler = (req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405, headers()).end('method not allowed');
      return;
    }
    let requestUrl;
    try {
      requestUrl = new URL(req.url, `http://${host}:${port}`);
    } catch {
      res.writeHead(400, headers()).end('bad request');
      return;
    }
    if (requestUrl.pathname !== path) {
      res.writeHead(404, headers()).end('not found');
      return;
    }

    const error = requestUrl.searchParams.get('error');
    const errorDescription = requestUrl.searchParams.get('error_description');
    const returnedState = requestUrl.searchParams.get('state');
    const expectedState = provider.snapshot().oauthState;
    const expectedIssuer = provider.snapshot().issuer;
    const returnedIssuer = requestUrl.searchParams.get('iss');

    if (error) {
      const detail = errorDescription ? `${error}: ${errorDescription}` : error;
      res.writeHead(400, headers()).end(`Authorization failed: ${detail}`);
      finish(settle.reject, new Error(`Authorization server returned ${detail}`));
      return;
    }
    if (!returnedState || returnedState !== expectedState) {
      res.writeHead(400, headers()).end('invalid state');
      finish(settle.reject, new Error('OAuth state mismatch (possible CSRF); login aborted.'));
      return;
    }
    if (returnedIssuer && expectedIssuer && returnedIssuer !== expectedIssuer) {
      res.writeHead(400, headers()).end('invalid issuer');
      finish(settle.reject, new Error('OAuth issuer mismatch; login aborted.'));
      return;
    }
    const authorizationCode = requestUrl.searchParams.get('code');
    if (!authorizationCode) {
      res.writeHead(400, headers()).end('missing code');
      finish(settle.reject, new Error('The authorization callback did not include a code.'));
      return;
    }

    res.writeHead(200, headers('text/html; charset=utf-8')).end(HTML_OK);
    finish(settle.resolve, authorizationCode);
  };

  try {
    const primary = await listen(bindHost, port, handler);
    servers.push(primary);
    const actualPort = primary.address().port;

    // `localhost` can resolve to ::1 or 127.0.0.1 depending on the browser/OS.
    if (host === 'localhost' && bindHost === '127.0.0.1') {
      try {
        const v6 = await listen('::1', actualPort, handler);
        servers.push(v6);
      } catch {
        /* IPv6 loopback not available; IPv4 is enough for most systems */
      }
    }

    timer = setTimeout(() => {
      log(`Timeout waiting for authorization (${timeoutMs} ms).`);
      finish(settle.reject, new Error(`Timeout waiting for authorization (${timeoutMs} ms).`));
    }, timeoutMs);
    timer.unref?.();

    const redirectUrl = new URL(`http://${host}:${actualPort}${path}`);
    return {
      code,
      port: actualPort,
      redirectUrl,
      close: async () => {
        if (!done) finish(settle.reject, new Error('Login cancelled.'));
      },
    };
  } catch (error) {
    finish(settle.reject, error);
    throw new Error(`Cannot listen on ${bindHost}:${port}: ${error.message}`);
  }
}

export async function readPastedCode({ redirectUrl, provider }) {
  const line = await new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question('Redirect URL: ', (answer) => {
      rl.close();
      try {
        process.stdin.pause();
      } catch {
        /* ignore */
      }
      resolve(answer.trim());
    });
  });

  let parsed;
  try {
    parsed = new URL(line);
  } catch {
    throw new Error('That is not a URL. Paste the full URL the provider redirected to.');
  }
  if (parsed.origin + parsed.pathname !== redirectUrl.origin + redirectUrl.pathname) {
    throw new Error(`The pasted URL does not point to the expected callback (${redirectUrl.href}).`);
  }
  const error = parsed.searchParams.get('error');
  if (error) {
    const description = parsed.searchParams.get('error_description');
    throw new Error(`Authorization server returned ${error}${description ? `: ${description}` : ''}`);
  }
  const returnedState = parsed.searchParams.get('state');
  const expectedState = provider.snapshot().oauthState;
  if (!returnedState || returnedState !== expectedState) {
    throw new Error('OAuth state mismatch (possible CSRF); login aborted.');
  }
  const returnedIssuer = parsed.searchParams.get('iss');
  const expectedIssuer = provider.snapshot().issuer;
  if (returnedIssuer && expectedIssuer && returnedIssuer !== expectedIssuer) {
    throw new Error('OAuth issuer mismatch; login aborted.');
  }
  const authorizationCode = parsed.searchParams.get('code');
  if (!authorizationCode) throw new Error('The pasted URL does not contain a code.');
  return authorizationCode;
}
