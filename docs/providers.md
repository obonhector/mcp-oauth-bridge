# Provider guides

The bridge implements the MCP OAuth profile and delegates discovery, dynamic
client registration (DCR), PKCE and refresh to the official MCP SDK. This page
covers the providers that need extra setup. Commands use placeholders; keep
secrets in environment variables, never in shell history.

> These are setup recipes, not endorsements. Provider consoles change; verify
> the redirect URI, scopes and client type in the provider's documentation.

---

## Zero-configuration providers

If the provider advertises both protected-resource metadata (RFC 9728) and a
`registration_endpoint` (RFC 7591), this is enough:

```bash
oauth-mcp-bridge add todoist https://ai.todoist.net/mcp
oauth-mcp-bridge login todoist
oauth-mcp-bridge tools todoist
```

Examples reported as DCR-capable in the scan: ahrefs, calendly, coda, gamma,
gong, hunter, intercom, jotform, klaviyo, square, statsig, todoist, trello,
typeform, upwork and others. See [coverage.md](coverage.md) for the caveat:
discovery + DCR is not the same as a guaranteed successful login.

---

## Pre-registered clients

For providers without DCR, create an OAuth app in the provider console and pass
its client id. Prefer the environment/stdin secret forms:

```bash
oauth-mcp-bridge add <name> <url> \
  --client-id "$CLIENT_ID" \
  --client-secret-env CLIENT_SECRET
```

`login` reads `CLIENT_SECRET` from the environment. The secret is copied to the
selected token store, not to `servers.json`.

The default callback is:

```
http://127.0.0.1:33418/callback
```

If the provider requires a different host/path/port, use `--redirect-url` and
register exactly that URI. `localhost` and `127.0.0.1` are different origins for
many providers.

`--token-auth-method` selects how the secret is sent to the token endpoint:

- `client_secret_basic` (HTTP Basic; usually the safest default)
- `client_secret_post` (form body; required by some providers)
- `none` (public client; no secret)

---

## Google

Google does not offer dynamic client registration for these APIs, so create an
OAuth client:

1. Google Cloud Console → APIs & Services → Credentials → Create credentials →
   OAuth client ID.
2. Application type: **Desktop app** (this permits a loopback redirect).
3. Add `http://127.0.0.1:33418/callback` if the console asks for a URI.
4. Enable the API you need (e.g. Gmail API).

```bash
oauth-mcp-bridge add gmail https://gmailmcp.googleapis.com/mcp/v1 \
  --client-id "$GOOGLE_CLIENT_ID" \
  --client-secret-env GOOGLE_CLIENT_SECRET \
  --scopes "https://www.googleapis.com/auth/gmail.readonly" \
  --redirect-url http://127.0.0.1:33418/callback \
  --auth-param access_type=offline \
  --auth-param prompt=consent

oauth-mcp-bridge login gmail
```

Why the extra parameters:

- `access_type=offline` asks Google for a refresh token.
- `prompt=consent` forces the consent screen on re-authorization so a refresh
  token is actually returned.

If the token exchange is rejected, try
`--token-auth-method client_secret_post`. Google's installed-app clients accept
both Basic and POST in most configurations.

Google may return a refresh token only on the first consent. `logout` (which
revokes) followed by a fresh `login` is the reliable way to get a new one.

---

## Microsoft / Entra ID

1. Entra admin center → App registrations → New registration.
2. Supported account type: depending on your tenant.
3. Platform: **Mobile and desktop applications** (public client).
4. Redirect URI: `http://localhost:33418/callback`.
5. API permissions: the scopes your MCP server requires, plus `offline_access`
   if you want a refresh token.

```bash
oauth-mcp-bridge add outlook https://outlook.office.com/mcp \
  --client-id "$ENTRA_CLIENT_ID" \
  --scopes "offline_access https://graph.microsoft.com/.default" \
  --redirect-url http://localhost:33418/callback
```

If your tenant uses a specific authorization server, override discovery:

```bash
--authorization-server "https://login.microsoftonline.com/$TENANT_ID/v2.0"
```

`offline_access` is a scope, not an `--auth-param`. Without it you may get an
access token but no refresh token.

---

## GitHub

GitHub OAuth apps do not support DCR. Create an OAuth app:

1. GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.
2. Authorization callback URL: `http://127.0.0.1:33418/callback`.
3. Copy the client id and generate a client secret.

```bash
oauth-mcp-bridge add github https://api.githubcopilot.com/mcp/ \
  --client-id "$GITHUB_CLIENT_ID" \
  --client-secret-env GITHUB_CLIENT_SECRET \
  --scopes "read:user"
```

GitHub user-to-server tokens do not expire by default, so a refresh token may
not be issued. The bridge still works; `status` will show `refresh: no`.

---

## X (Twitter)

Create an OAuth 2.0 app with a confidential or public client, and register the
loopback callback exactly:

```bash
oauth-mcp-bridge add x https://api.x.com/mcp \
  --client-id "$X_CLIENT_ID" \
  --client-secret-env X_CLIENT_SECRET \
  --scopes "tweet.read users.read offline.access" \
  --redirect-url http://127.0.0.1:33418/callback
```

X uses `offline.access` for refresh tokens. If your app is a public client, omit
the secret and use `--token-auth-method none`.

---

## Shopify

Shopify OAuth apps generally require an **HTTPS** redirect URI and may reject a
plain loopback callback. Options:

- Put a TLS terminator in front of the loopback callback and use
  `--redirect-url https://your-host/callback` (the bridge itself does not serve
  HTTPS; you need a tunnel/reverse proxy).
- Use a static token in the client config if the server supports it, instead of
  this bridge.
- Check the provider's current rules before relying on a loopback flow.

The bridge rejects `https://` redirect URLs in normal login mode because it
cannot bind TLS itself. Use `--headless --paste-back` with a tunnel when the
provider insists on HTTPS.

---

## SharePoint / custom metadata

If the provider's metadata does not validate (for example a `ZodError`), point
the bridge at the protected-resource metadata directly:

```bash
oauth-mcp-bridge add sharepoint <url> \
  --resource-metadata-url "https://<host>/.well-known/oauth-protected-resource"
```

For a non-standard authorization server:

```bash
oauth-mcp-bridge add <name> <url> --authorization-server "https://<issuer>"
```

`--authorization-server` bootstraps discovery from that issuer instead of the
one advertised by the resource metadata.

---

## Extra authorization parameters

Some providers need parameters that are not part of the MCP profile. Pass them
with repeatable `--auth-param key=value`:

```bash
--auth-param access_type=offline --auth-param prompt=consent
--auth-param audience=https://api.example.com
--auth-param login_hint=user@example.com
```

They are added to the authorization URL only; the token request is unchanged.

---

## Troubleshooting by provider

| Error | What to check |
|---|---|
| `invalid_client` | Client id/secret, client type (public vs confidential), `--token-auth-method`. |
| `redirect_uri_mismatch` / `invalid_redirect_uri` | Exact scheme, host (`localhost` vs `127.0.0.1`), port and path must match the console. |
| `invalid_scope` | The scope strings and separators; the provider may not support the scope for this client type. |
| No `refresh_token` | Google `access_type=offline` + `prompt=consent`; Microsoft `offline_access`; X `offline.access`. |
| `insufficient_scope` on a tool call | Add the scope, `logout`, `login` again. |
| `403` after consent | The user/tenant may need admin consent or the API may not be enabled. |
| `fetch failed` | DNS/TLS/proxy; `NODE_EXTRA_CA_CERTS`, `NODE_USE_ENV_PROXY=1` on Node 24+. |
| `state mismatch` | The callback was replayed/expired; run `login` again. |
| `op` vault missing | Create the vault named by `MCP_OAUTH_BRIDGE_OP_VAULT`. |
