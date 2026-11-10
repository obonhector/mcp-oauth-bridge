# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project uses semantic
versioning.

## [1.1.0] — 2026-11-10

This release hardens the bridge for general use beyond DSH and fixes several
production bugs found in review.

### Added

- Generic naming: `MCP_OAUTH_BRIDGE_*` environment variables with working
  `DSH_MCP_OAUTH_*` aliases.
- XDG / macOS Application Support / Windows `%APPDATA%` state directories, with
  a fallback to the legacy `~/.dsh/mcp-oauth` directory.
- Dynamic client registration now uses the generic consent-screen name
  **MCP OAuth Bridge** plus a homepage.
- Pluggable token stores: `file` (atomic, 0600), `op` (1Password) and
  `libsecret` (Linux keyring), with `delete`/`describe` support.
- Client secrets are stored in the token store, never in `servers.json`.
  `--client-secret-env` and `--client-secret-stdin` are the recommended forms.
- `--redirect-url`, `--auth-param`, `--token-auth-method`,
  `--authorization-server`, `--resource-metadata-url` and repeatable
  `--scopes`/`--scope`.
- `--port 0` for an ephemeral callback port.
- Lazy connections and reconnect: a remote that is down at startup no longer
  kills `serve` or permanently removes a server from `serve-all`.
- Full pagination for `tools/list`, `resources/list`, `resourceTemplates/list`
  and `prompts/list`.
- `_meta` (including `progressToken`) is forwarded on `tools/call`; progress
  notifications and cancellation are relayed.
- Upstream `instructions` are forwarded, and `list_changed` notifications are
  re-emitted to the downstream client.
- `serve-all` now handles resources and prompts (resources are not URI-prefixed;
  collisions are logged).
- `status --json`, `status --offline`, absolute expiry, scopes, issuer, store
  name/location and exit code `3` when verification fails.
- `--version`, `-h`, `--flag=value` parsing and a complete English `--help`.
- Token revocation on `logout` (RFC 7009) and client deletion with
  `--forget-client` (RFC 7592) when supported.
- Per-server lock: `logout`/`tools` refuse to run while a bridge is live;
  `login` is allowed and the bridge picks up new tokens on reconnect.
- `CHANGELOG.md`, `SECURITY.md`, provider guides, honest coverage docs,
  an asciinema cast/GIF, CI on Node 22/24/26 across Linux/macOS/Windows, and a
  tarball installation smoke test.
- `npm run lint`, `npm run typecheck` (`tsc --checkJs`) and `npm run test:pack`.

### Fixed

- `login` no longer exits `0` without authorizing on a callback timeout.
- A callback with `?error=access_denied` now fails with a message instead of
  hanging forever.
- Re-running `login` with valid tokens no longer waits for the full callback
  timeout.
- `logout` now actually removes tokens from `op` and `libsecret` stores.
- A missing `state` is rejected (previously only a wrong state was rejected).
- Server names are validated, closing a path-traversal hole in state paths.
- `--port 0` no longer advertises a `:0` redirect URI.
- `status` exits non-zero when it cannot verify the connection.
- Corrupt `servers.json`/state files produce a clear error instead of looking
  like “not registered”/“no tokens”.
- `status` and `tools` no longer open a browser on a 401.
- Connections are closed on error paths instead of leaking sockets.
- Scopes passed with commas are normalized to OAuth's space-delimited form.

### Changed

- `serve` starts in degraded mode by default; `--fail-fast` restores the old
  exit-code behavior.
- `login` can run while a bridge is live; restart the bridge if it was already
  authenticated.
- `logout`/`tools` require the bridge to be stopped (or `logout --force`).
- Node.js 22+ is required (Node 20 is EOL).
- `status` verifies the live connection by default; use `--offline` in scripts.
- The package/repository is now `oauth-mcp-bridge` (the unrelated npm package
  `mcp-oauth-bridge` is not this project).

### Security

- `state` is mandatory and single-use.
- The PKCE verifier is removed after the code exchange.
- Client secrets never enter `servers.json`.
- Atomic token writes and a per-server lock.
- Callback headers hardened (`no-store`, `no-referrer`, `nosniff`).

## [1.0.0] — 2026-10-15

Initial release: OAuth dance, token refresh, stdio proxy, `serve-all`, headless
login, pluggable stores and the mock OAuth/MCP end-to-end tests.
