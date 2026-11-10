# oauth-mcp-bridge

**OAuth for remote MCP servers when your stdio-only client cannot do OAuth itself.**

[![CI](https://github.com/obonhector/oauth-mcp-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/obonhector/oauth-mcp-bridge/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/oauth-mcp-bridge.svg)](https://www.npmjs.com/package/oauth-mcp-bridge)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)

`oauth-mcp-bridge` performs the MCP OAuth dance **once** — protected-resource
metadata (RFC 9728), authorization-server metadata (RFC 8414), dynamic client
registration (RFC 7591), authorization code with PKCE S256 (RFC 7636) and the
resource indicator (RFC 8707) — stores the tokens, refreshes them on 401, and
then exposes the remote server to your client over plain stdio.

One process, multiple servers, no tokens in your client config.

![Demo: add, login, status, tools and a stdio client](docs/demo.gif)

> npm package: **`oauth-mcp-bridge`**. Not to be confused with the unrelated
> `mcp-oauth-bridge` package on npm.

---

## Install

```bash
# no global install required
npx oauth-mcp-bridge add todoist https://ai.todoist.net/mcp
npx oauth-mcp-bridge login todoist          # opens your browser, listens on 127.0.0.1:33418
npx oauth-mcp-bridge tools todoist          # list the remote tools
npx oauth-mcp-bridge serve todoist          # the stdio MCP server your client spawns
```

Or globally:

```bash
npm install -g oauth-mcp-bridge
oauth-mcp-bridge login todoist
```

Requires **Node.js 22 or newer**. Linux, macOS and Windows are supported; the
`libsecret` store is Linux-only.

### Point your MCP client at it

```json
{
  "mcpServers": {
    "todoist": {
      "command": "npx",
      "args": ["-y", "oauth-mcp-bridge", "serve", "todoist"]
    }
  }
}
```

`npx` is convenient but adds first-run latency and depends on `PATH`. For a
long-lived client, install globally and use the `oauth-mcp-bridge` binary
instead.

---

## Why

Many MCP clients still speak only stdio, or streamable HTTP with **static**
headers. Remote MCP servers increasingly require OAuth. This bridge fills the
gap without asking you to paste a bearer token into a config file:

```
MCP client ──stdio──▶ oauth-mcp-bridge ──HTTPS + Bearer──▶ remote MCP server
                            │
                            └── tokens in file / 1Password / libsecret
```

The OAuth flow happens once per server. After that, the bridge refreshes tokens
on its own, reconnects when a remote comes back, and can expose several remote
servers through a single stdio process.

---

## Commands

| Command | What it does |
|---|---|
| `add <name> <url>` | Register a server in `servers.json` |
| `login <name>` | Run the OAuth flow (browser + loopback callback) |
| `status <name>` | Show tokens, expiry, scopes, store and optionally verify the connection |
| `tools <name>` | List the remote tools |
| `logout <name>` | Revoke tokens and remove them from the store |
| `serve <name>` | Expose one remote server over stdio |
| `serve-all` | Expose every authorized server over one stdio process, `<server>__<tool>` |
| `help`, `--help`, `-h` | Usage |
| `--version`, `-v` | Version |

Useful flags:

| Flag | Applies to | Meaning |
|---|---|---|
| `--scopes a,b` / `--scope a` | `add`, `login` | Requested scopes; commas are normalized to spaces |
| `--client-id X` | `add`, `login` | Pre-registered OAuth client |
| `--client-secret-env VAR` | `add`, `login` | Read the secret from an environment variable (recommended) |
| `--client-secret-stdin` | `add` | Read the secret from stdin |
| `--client-secret X` | `login` | Inline secret; visible in shell history/process list |
| `--store file\|op\|libsecret` | `add` | Token store for this server |
| `--token-auth-method none\|client_secret_basic\|client_secret_post` | `add`, `login` | Token endpoint client authentication |
| `--authorization-server URL` | `add`, `login` | Override the discovered authorization server |
| `--resource-metadata-url URL` | `add`, `login` | Override the RFC 9728 metadata URL |
| `--redirect-url URL` | `add`, `login` | Exact loopback callback, e.g. `http://localhost:33418/callback` |
| `--auth-param key=value` | `add`, `login` | Extra authorization URL parameter; repeatable |
| `--headless` | `login` | Print the URL and wait for a loopback/SSH-tunnel callback |
| `--paste-back` | `login` | Print the URL and paste the final redirect URL back (implies headless) |
| `--port N` | `login` | Callback port; `0` picks an ephemeral port |
| `--prefix p` | `serve` | Expose tools as `p__<tool>` |
| `--only a,b` | `serve-all` | Limit the servers |
| `--offline` / `--verify` | `status` | Skip or force the live connection check |
| `--json` | `status`, `tools` | Machine-readable output on stdout |
| `--fail-fast` | `serve`, `serve-all` | Exit with code 2/1 instead of starting degraded |
| `--no-revoke` | `logout` | Do not call the revocation endpoint |
| `--force` | `add`, `logout` | Replace a server entry / bypass a running-bridge lock |

Exit codes: `0` success, `1` error, `2` authorization required, `3` status
verification failed.

---

## Configuration

All settings are optional. New environment variables use the
`MCP_OAUTH_BRIDGE_*` prefix; the legacy `DSH_MCP_OAUTH_*` names still work.

| New name | Legacy alias | Default |
|---|---|---|
| `MCP_OAUTH_BRIDGE_DIR` | `DSH_MCP_OAUTH_DIR` | platform state dir (see below) |
| `MCP_OAUTH_BRIDGE_STORE` | `DSH_MCP_OAUTH_STORE` | `file` |
| `MCP_OAUTH_BRIDGE_PORT` | `DSH_MCP_OAUTH_PORT` | `33418` |
| `MCP_OAUTH_BRIDGE_TIMEOUT_MS` | `DSH_MCP_OAUTH_TIMEOUT_MS` | `300000` |
| `MCP_OAUTH_BRIDGE_CONNECT_TIMEOUT_MS` | — | `30000` |
| `MCP_OAUTH_BRIDGE_CALL_TIMEOUT_MS` | — | `120000` |
| `MCP_OAUTH_BRIDGE_NOTIFY_CMD` | `DSH_MCP_OAUTH_NOTIFY_CMD` | unset |
| `MCP_OAUTH_BRIDGE_OP_VAULT` | `DSH_MCP_OAUTH_OP_VAULT` | `MCP OAuth Bridge` |
| `MCP_OAUTH_BRIDGE_OP_BIN` | `DSH_MCP_OAUTH_OP_BIN` | `op` |
| `MCP_OAUTH_BRIDGE_SECRET_BIN` | `DSH_MCP_OAUTH_SECRET_BIN` | `secret-tool` |
| `MCP_OAUTH_BRIDGE_NO_OPEN` | `DSH_MCP_OAUTH_NO_OPEN` | unset |
| `MCP_OAUTH_BRIDGE_DEBUG` | `DSH_MCP_OAUTH_DEBUG` | unset |

### State directory

| Platform | Default |
|---|---|
| Linux | `$XDG_CONFIG_HOME/mcp-oauth-bridge` or `~/.config/mcp-oauth-bridge` |
| macOS | `~/Library/Application Support/mcp-oauth-bridge` |
| Windows | `%APPDATA%\mcp-oauth-bridge` |

Existing DSH users keep their old directory: if the new directory does not
exist and `~/.dsh/mcp-oauth` does, the legacy directory is used. Set
`MCP_OAUTH_BRIDGE_DIR` to move it.

`servers.json` contains no client secrets. Tokens and client secrets live in the
selected store, written with mode `0600` inside a `0700` directory on POSIX.
On Windows, file permissions rely on the user profile ACL; use the `op` store
if you need stronger isolation.

---

## Token stores

| Store | How | Notes |
|---|---|---|
| `file` (default) | `state/<name>.json`, `0600`, atomic writes | Works everywhere |
| `op` | 1Password CLI; item `mcp-oauth:<name>`, field `state` | Works with service accounts; create the vault first |
| `libsecret` | `secret-tool` | Linux keyring; requires an unlocked session |

Select per server with `--store`, or globally with
`MCP_OAUTH_BRIDGE_STORE=file|op|libsecret`.

### Client secrets

`add` never writes a client secret into `servers.json`. Use one of:

```bash
oauth-mcp-bridge add gmail https://gmailmcp.googleapis.com/mcp/v1 \
  --client-id "$GOOGLE_CLIENT_ID" --client-secret-env GOOGLE_CLIENT_SECRET

# or read it from stdin (CI, password managers)
printf '%s' "$SECRET" | oauth-mcp-bridge add github https://api.githubcopilot.com/mcp/ \
  --client-id "$GITHUB_CLIENT_ID" --client-secret-stdin
```

The secret is stored in the selected token store. `--client-secret` is accepted
for compatibility, but it is visible in shell history and `ps`; prefer the env
or stdin form. Existing `clientSecret` fields in `servers.json` are read and
migrated by the next `add`.

### Logout and revocation

`logout` revokes the refresh/access token when the authorization server
advertises a revocation endpoint (RFC 7009), then removes the tokens locally.
`--forget-client` also deletes the client registration locally and, when the
server supports RFC 7592, remotely.

A running bridge holds a per-server lock. `logout` refuses to run while the
bridge is live (stop it first, or use `--force` and accept that the live process
may refresh tokens again). `login` is allowed while a bridge is running; the
bridge picks up the new tokens on its next reconnect.

---

## Multi-server

```bash
oauth-mcp-bridge serve-all
oauth-mcp-bridge serve-all --only todoist,trello
```

One stdio process, tools exposed as `<server>__<tool>`. Servers that are down or
not authorized are skipped with a warning; the rest keep working. A server that
comes back — or is authorized later — is picked up lazily on the next request.

`serve <name>` remains the single-server mode and preserves the remote tool
names unless you pass `--prefix`.

Resource URIs are not rewritten in `serve-all`; if two servers expose the same
URI, the first one wins and a warning is logged. Prompts are prefixed like tools.

---

## Headless / SSH

```bash
# A) loopback tunnel: on your laptop
ssh -L 33418:127.0.0.1:33418 user@server
# on the server
oauth-mcp-bridge login todoist --headless
# open AUTHORIZATION_URL in the laptop browser; the callback returns over the tunnel

# B) paste-back, no tunnel
oauth-mcp-bridge login todoist --headless --paste-back
# open the URL anywhere; when it redirects to 127.0.0.1:33418/callback?...
# (even if the browser says it cannot connect), paste that URL into the terminal
```

The callback validates `state` exactly and rejects missing or mismatched state.
Modern authorization servers may include `iss`; it is validated when present.

---

## Providers

Generic OAuth servers that advertise protected-resource metadata and dynamic
client registration work with zero configuration. For Google, Microsoft, GitHub,
X, Shopify and friends — which require a pre-registered client or extra
authorization parameters — see [docs/providers.md](docs/providers.md).

Quick examples:

```bash
# Google (Desktop OAuth client; refresh token needs access_type=offline)
oauth-mcp-bridge add gmail https://gmailmcp.googleapis.com/mcp/v1 \
  --client-id "$GOOGLE_CLIENT_ID" --client-secret-env GOOGLE_CLIENT_SECRET \
  --scopes "https://www.googleapis.com/auth/gmail.readonly" \
  --redirect-url http://127.0.0.1:33418/callback \
  --auth-param access_type=offline --auth-param prompt=consent

# Microsoft / Entra (public client; offline_access for a refresh token)
oauth-mcp-bridge add outlook https://outlook.office.com/mcp \
  --client-id "$ENTRA_CLIENT_ID" \
  --scopes "offline_access https://graph.microsoft.com/.default" \
  --redirect-url http://localhost:33418/callback
```

`--auth-param` only adds parameters to the authorization URL; it does not change
the token exchange. `--token-auth-method` controls how the client secret is sent
to the token endpoint.

---

## Coverage: measured, not guessed

`npm run scan` probes the remote endpoints listed in the Cursor MCP marketplace
with the same discovery code path as the bridge.

The last snapshot (2026-11-10) found:

| Group | Count | Meaning |
|---|---:|---|
| Protected-resource metadata + dynamic client registration | 57 | Zero-config **discovery**; a successful login is not implied |
| Metadata but no DCR | 20 | Need your own OAuth app and a provider guide |
| Metadata the SDK cannot parse | 1 | e.g. SharePoint; pass `--resource-metadata-url` manually |

**README honesty:** "57" is a discovery/DCR count, not a promise that every
provider's consent screen accepts this client. The full login flow is verified
end-to-end against the local mock in CI. Provider rows in
[docs/coverage.md](docs/coverage.md) are marked `author-reported` or
`CI-verified`; add yours with a PR after a successful login.

The scan is a development tool; it is not included in the npm package.

---

## Security

- **PKCE S256** and an unpredictable `state` on every login; the state is
  compared exactly and rotated per attempt.
- **PKCE verifier and state are single-use**: removed from the store after the
  code exchange.
- **Loopback only**: the callback binds `127.0.0.1`/`localhost`/`::1`, never a
  public interface.
- **Resource indicator** (RFC 8707) is sent to the authorization server.
- **Token revocation** on logout when the provider supports it.
- **Atomic state writes** and a per-server lock prevent two processes from
  corrupting or racing the same token file.
- **No tokens in logs**. Authorization headers and token endpoint bodies are
  redacted from error messages.
- **Secrets outside `servers.json`**; client secrets can come from an env var or
  stdin and are stored in the token store.
- **File permissions**: `0600` files inside a `0700` directory on POSIX. On
  Windows the profile ACL is the boundary; use `op` for stronger isolation.

Known gaps:

- Tokens are not encrypted at rest by the default `file` store; use `op` or
  `libsecret` if that matters.
- The proxy is request/response: it does not forward **sampling**,
  **elicitation** or **roots** from the remote server back to your client.
- `serve-all` does not rewrite resource URIs; identical URIs collide.
- `--client-secret` on the command line is visible to other local users.
- No mTLS, DPoP or device-code flow yet.

See [SECURITY.md](SECURITY.md) for the threat model and reporting process.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `EADDRINUSE` on login | Another login is using the port. Use `--port 0` or `--port N`. |
| `invalid_client` | Wrong client id/secret, or the provider expects `client_secret_basic` vs `post`. Try `--token-auth-method`. |
| `redirect_uri_mismatch` | The provider requires an exact callback. Use `--redirect-url` and register the same URI. |
| No refresh token | Google needs `access_type=offline` + `prompt=consent`; Microsoft needs `offline_access`. |
| `insufficient_scope` | Add the scope with `--scopes` (or the provider's required scope) and log in again. |
| `fetch failed` | DNS/TLS/proxy. Set `NODE_EXTRA_CA_CERTS` for a private CA; on Node 24+ set `NODE_USE_ENV_PROXY=1` for `HTTPS_PROXY`. |
| `Server "x" is in use by serve` | Stop the bridge before `logout`/`tools`, or use `status --offline`. |
| `op` fails | Create the vault (`MCP_OAUTH_BRIDGE_OP_VAULT`, default `MCP OAuth Bridge`) or use the file store. |
| State mismatch | The callback was replayed or the login expired; run `login` again. |
| Debug details | `MCP_OAUTH_BRIDGE_DEBUG=1` and `status <name> --json`. |

---

## DSH integration

DSH speaks MCP over stdio and streamable HTTP with static headers, but has no
OAuth flow of its own. The bridge was originally written for that case; it is
now a general stdio bridge and DSH is one integration.

```yaml
- insert:
    - id: mcp-todoist
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: todoist
        transport: stdio
        command: oauth-mcp-bridge
        args: [serve, todoist]
        failOnStartupError: false
        toolCallTimeoutMs: 60000
```

Tools appear as `mcp__todoist__<name>`. If the server is not authorized, the
bridge starts degraded and reports a clear error on `tools/list`; run
`oauth-mcp-bridge login todoist` and the next request reconnects.

---

## Limits

- Node.js 22+ (Node 20 is EOL).
- One `serve` process per server (the lock enforces it); `serve-all` is the
  multi-server mode.
- `serve` starts degraded by default so a remote outage does not kill the
  client; use `--fail-fast` for the old exit-on-startup behavior.
- Fixed callback port for providers that require an exact redirect URI; use
  `--port 0` only when the provider supports dynamic registration with a
  per-login redirect URI.
- No sampling/elicitation/roots proxying, no device flow, no mTLS/DPoP.
- `status` verifies the live connection by default; use `--offline` in scripts
  that should not touch the network.

---

## Development

```bash
npm ci
npm test           # e2e + store/notify, against a local mock OAuth/MCP server
npm run lint
npm run typecheck  # tsc --checkJs
npm run test:pack  # pack, install in a temp prefix, run --version/--help
npm run scan       # Cursor marketplace discovery scan (dev only)
```

The tests use no real account: `test/mock-oauth-server.mjs` implements the OAuth
server and the MCP endpoint, including refresh-token rotation, pagination,
resources and prompts.

---

## License

MIT. See [LICENSE](LICENSE).
