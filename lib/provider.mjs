/**
 * OAuth client provider backed by the pluggable token store.
 *
 * The provider is deliberately small: the official MCP SDK performs RFC 9728
 * discovery, RFC 7591 registration, PKCE and token refresh. This class only
 * persists state between the `login` and `serve` processes and gives the CLI
 * a friendly non-interactive failure path.
 */
import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import {
  DISPLAY_NAME,
  HOMEPAGE,
  envFlag,
  normalizeScope,
  openBrowser,
} from './env.mjs';
import { notify } from './notify.mjs';
import { selectBackend } from './store.mjs';

export function loginHint(name) {
  return `oauth-mcp-bridge login ${name} --headless`;
}

export class FileOAuthProvider {
  constructor({
    name,
    file,
    server = {},
    redirectUrl,
    scope,
    clientId,
    clientSecret,
    clientSecretEnv,
    tokenAuthMethod,
    authorizationServer,
    authParams = [],
    interactive = true,
    log = (m) => process.stderr.write(m + '\n'),
  }) {
    this.name = name;
    this.file = file;
    if (!this.file) throw new Error('FileOAuthProvider requires a state file path.');
    this.server = /** @type {any} */ (server);
    this.log = log;
    this.interactive = interactive;
    this.redirectUrlValue = redirectUrl;
    this.scope = normalizeScope(scope ?? this.server.scopes);
    this.clientId = clientId ?? this.server.clientId;
    this.clientSecretEnv = clientSecretEnv ?? this.server.clientSecretEnv;
    this.clientSecret =
      (typeof clientSecret === 'string' ? clientSecret : undefined) ??
      (this.clientSecretEnv ? process.env[this.clientSecretEnv] : undefined) ??
      this.server.clientSecret;
    this.tokenAuthMethod = tokenAuthMethod ?? this.server.tokenAuthMethod;
    this.authorizationServer = authorizationServer ?? this.server.authorizationServer;
    this.authParams = authParams;
    this.backend = selectBackend(this.server);
    this.data = {};
    this.hadTokens = false;
    this.lastFailure = undefined;
    this.authorizationUrl = undefined;
    this.initialized = undefined;
  }

  get storeDescription() {
    return this.backend.describe(this.id());
  }

  id() {
    return { name: this.name, file: this.file };
  }

  async init() {
    if (!this.initialized) {
      this.initialized = (async () => {
        this.data = (await this.backend.read(this.id())) || {};
        if (!this.clientSecret && this.data.clientSecret) this.clientSecret = this.data.clientSecret;
        this.lastStoreRead = Date.now();
        this.lastMtime = await this.currentMtime();
      })();
    }
    return this.initialized;
  }

  async currentMtime() {
    if (this.backend.name !== 'file') return 0;
    try {
      return (await stat(this.file)).mtimeMs;
    } catch {
      return 0;
    }
  }

  /** Pick up tokens written by a concurrent login (file store: cheap mtime check). */
  async refreshFromStore() {
    if (this.backend.name === 'file') {
      const mtime = await this.currentMtime();
      if (mtime && mtime > (this.lastMtime || 0)) {
        const latest = await this.backend.read(this.id()).catch(() => undefined);
        if (latest) {
          this.data = { ...this.data, ...latest };
          this.lastMtime = mtime;
        }
      }
      return;
    }
    if (Date.now() - (this.lastStoreRead || 0) < 30_000) return;
    this.lastStoreRead = Date.now();
    const latest = await this.backend.read(this.id()).catch(() => undefined);
    if (latest) this.data = { ...this.data, ...latest };
  }

  async persist() {
    await this.backend.write(this.id(), this.data);
    this.lastStoreRead = Date.now();
    this.lastMtime = await this.currentMtime();
  }

  snapshot() {
    return this.data;
  }

  /** Start a new authorization attempt: fresh state, no stale verifier. */
  async beginLogin() {
    this.lastFailure = undefined;
    this.authorizationUrl = undefined;
    // A dynamic registration is tied to its redirect URIs. If the port changed,
    // register again instead of sending a redirect the server will reject.
    if (
      !this.clientId &&
      !this.data.tokens &&
      this.redirectUrl &&
      this.data.clientInformation?.redirect_uris?.length &&
      !this.data.clientInformation.redirect_uris.includes(String(this.redirectUrl))
    ) {
      delete this.data.clientInformation;
    }
    this.data.oauthState = randomBytes(16).toString('hex');
    delete this.data.codeVerifier;
    await this.persist();
    return this.data.oauthState;
  }

  get redirectUrl() {
    return this.redirectUrlValue;
  }

  get clientMetadata() {
    return {
      redirect_uris: [String(this.redirectUrlValue)],
      client_name: DISPLAY_NAME,
      client_uri: HOMEPAGE,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: this.tokenAuthMethod || 'none',
      ...(this.scope ? { scope: this.scope } : {}),
    };
  }

  async state() {
    if (!this.data.oauthState) await this.beginLogin();
    return this.data.oauthState;
  }

  async clientInformation() {
    await this.refreshFromStore();
    if (this.clientId) {
      return {
        client_id: this.clientId,
        ...(this.clientSecret ? { client_secret: this.clientSecret } : {}),
        ...(this.tokenAuthMethod ? { token_endpoint_auth_method: this.tokenAuthMethod } : {}),
      };
    }
    return this.data.clientInformation;
  }

  async saveClientInformation(clientInformation) {
    this.data.clientInformation = clientInformation;
    await this.persist();
  }

  async tokens() {
    await this.refreshFromStore();
    if (this.data.tokens) this.hadTokens = true;
    return this.data.tokens;
  }

  async saveTokens(tokens) {
    const now = Date.now();
    this.data.tokens = {
      ...tokens,
      ...(tokens.expires_in ? { expiresAt: now + Number(tokens.expires_in) * 1000 } : {}),
      obtainedAt: now,
    };
    this.data.tokensSavedAt = now;
    if (tokens.issuer) this.data.issuer = tokens.issuer;
    // The verifier and CSRF state are single-use.
    delete this.data.codeVerifier;
    delete this.data.oauthState;
    this.lastFailure = undefined;
    await this.persist();
  }

  async saveCodeVerifier(codeVerifier) {
    this.data.codeVerifier = codeVerifier;
    await this.persist();
  }

  async codeVerifier() {
    if (!this.data.codeVerifier) throw new Error('No PKCE code verifier stored; re-run login.');
    return this.data.codeVerifier;
  }

  async redirectToAuthorization(authorizationUrl) {
    const url = new URL(authorizationUrl);
    for (const [key, value] of this.authParams) url.searchParams.set(key, value);
    this.authorizationUrl = url;

    if (!this.interactive) {
      const message =
        this.data.tokens || this.hadTokens
          ? `token refresh failed; re-authorization required: ${loginHint(this.name)}`
          : `no tokens; run: ${loginHint(this.name)}`;
      this.lastFailure = message;
      await notify(this.hadTokens ? 'refresh_failed' : 'reauth_required', this.name, message, {
        log: this.log,
      });
      return;
    }

    this.log('');
    this.log('  Open this URL to authorize (the browser may open automatically):');
    this.log('');
    this.log(`  AUTHORIZATION_URL=${url.href}`);
    this.log('');
    if (!envFlag('NO_OPEN')) openBrowser(url.href);
  }

  async invalidateCredentials(scope) {
    if (this.data.tokens && (scope === 'all' || scope === 'tokens')) this.hadTokens = true;
    if (
      (scope === 'all' || scope === 'tokens') &&
      !this.clientId &&
      this.redirectUrl &&
      this.data.clientInformation?.redirect_uris?.length &&
      !this.data.clientInformation.redirect_uris.includes(String(this.redirectUrl))
    ) {
      delete this.data.clientInformation;
    }
    if (scope === 'all' || scope === 'client') delete this.data.clientInformation;
    if (scope === 'all' || scope === 'tokens') {
      delete this.data.tokens;
      delete this.data.tokensSavedAt;
    }
    if (scope === 'all' || scope === 'verifier') delete this.data.codeVerifier;
    if (scope === 'all' || scope === 'discovery') delete this.data.discoveryState;
    await this.persist();
  }

  async discoveryState() {
    const cached = this.data.discoveryState;
    if (cached && this.data.discoveryServerUrl && this.data.discoveryServerUrl !== this.server?.url) {
      delete this.data.discoveryState;
      delete this.data.discoveryServerUrl;
      await this.persist();
    }
    if (this.authorizationServer) {
      const cached = this.data.discoveryState;
      if (cached?.authorizationServerUrl === this.authorizationServer) return cached;
      return { authorizationServerUrl: this.authorizationServer };
    }
    return this.data.discoveryState;
  }

  async saveDiscoveryState(state) {
    this.data.discoveryState = state;
    this.data.discoveryServerUrl = this.server?.url;
    if (state?.authorizationServerUrl) this.data.issuer = state.authorizationServerUrl;
    await this.persist();
  }
}
