# Security policy

## Supported versions

The latest `1.x` release receives security fixes. Please reproduce issues on
Node.js 22 or newer.

## Reporting a vulnerability

Use **GitHub private vulnerability reporting** on
<https://github.com/obonhector/oauth-mcp-bridge/security/advisories/new>.
Please do not open a public issue for a suspected vulnerability.

Include the version, platform, Node version, the command you ran, and a minimal
reproduction with **redacted** tokens. Never send a live access or refresh
token.

## Threat model

Assets:

- OAuth access tokens, refresh tokens and client secrets.
- The PKCE verifier and the authorization `state`.
- The ability to act on the user's remote MCP account.

Adversaries considered:

- A malicious web page that can make the browser request
  `http://127.0.0.1:<port>/callback` while a login is in progress.
- Another local process running as the same user (or a shared machine user).
- A malicious or compromised remote MCP / authorization server.
- A network attacker without TLS interception ability.

Out of scope:

- A local attacker who can already read the user's home directory or process
  memory.
- A compromised npm registry or GitHub account.
- Vulnerabilities in the remote provider itself.

## Controls

- **PKCE S256** is mandatory; the verifier never leaves the machine.
- **`state` is exact-match**: a callback with a missing or different state is
  rejected and the login fails. The state is rotated on every attempt.
- The verifier and state are **single-use** and removed after the code exchange.
- The callback binds only loopback (`127.0.0.1`, `localhost`, `::1`).
- The callback response is `no-store`, `no-referrer` and `nosniff`.
- The authorization request includes the **RFC 8707 resource indicator**.
- Tokens are stored with `0600` in a `0700` directory on POSIX. The default
  `file` store does **not** encrypt at rest; use `op` or `libsecret` for
  stronger isolation.
- **Client secrets are not written to `servers.json`**. Prefer
  `--client-secret-env` or `--client-secret-stdin`; `--client-secret` is visible
  in shell history and `ps`.
- State writes are **atomic** (temp file + rename), and a **per-server lock**
  prevents two processes from racing refresh-token rotation.
- `logout` attempts **RFC 7009 revocation** and, with `--forget-client`,
  **RFC 7592** client deletion when the server supports it.
- Error messages are redacted for common token fields. Tokens are never logged
  by the bridge itself.

## Known limitations

- The default `file` store is plaintext JSON protected by filesystem
  permissions. On Windows those are the profile ACL, not POSIX `0600`.
- A live `serve` process holds tokens in memory. `logout` refuses to run while
  it is alive; `--force` can delete the state but the live process may refresh
  and write tokens again. Stop the bridge before logging out.
- `--client-secret` on the command line can leak via shell history, process
  listings, or terminal scrollback.
- The proxy does not forward **sampling**, **elicitation** or **roots**
  requests from the remote server to the downstream client. A tool that needs
  those will fail.
- `serve-all` does not rewrite resource URIs; two servers exposing the same URI
  collide (the first wins, with a warning).
- The npm install path is a supply-chain boundary. Releases are published from
  GitHub Actions with npm provenance once trusted publishing is configured.

## Operational guidance

- Use a dedicated OAuth app per machine when the provider supports it.
- Prefer `op`/`libsecret` on shared machines.
- Keep `MCP_OAUTH_BRIDGE_DIR` on a private filesystem, not a world-readable
  network share.
- Run `oauth-mcp-bridge status <name> --json` to audit expiry and scopes.
- Revoke access in the provider's web console as well if you suspect a token
  leak; local deletion alone may not invalidate it if the provider has no
  revocation endpoint.
