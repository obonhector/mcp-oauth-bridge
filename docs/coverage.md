# Coverage: measured, with caveats

## What the scan measures

`npm run scan` reads the remote MCP endpoints listed in a Cursor marketplace
checkout and probes them with the same discovery code path as the bridge:

1. RFC 9728 protected-resource metadata.
2. RFC 8414 / OIDC authorization-server metadata.
3. Whether the metadata advertises a `registration_endpoint` (DCR).

It does **not** complete an OAuth login, accept a consent screen, or prove that
a provider accepts this client. A row in the “PRM + DCR” group means
**discovery + DCR advertised**, not “login guaranteed”.

## Snapshot

- Date: **2026-11-10**
- Source: Cursor MCP marketplace checkout
- Command: `node tools/scan-servers.mjs --dir <marketplace>/third_party --json`
- Endpoint entries: **78**
- PRM + DCR advertised: **57**
- Metadata but no DCR: **20** (need a pre-registered client)
- Metadata the SDK cannot parse: **1** (SharePoint; use
  `--resource-metadata-url`)

The count is endpoint entries, not unique hosts; the same URL can appear in more
than one plugin. Treat it as an upper bound. The marketplace and provider
metadata change over time; re-run the scan rather than trusting these numbers
forever.

## Verified end-to-end

Only rows with a real successful login belong here. “CI-verified” means the
full flow is automated. “Author-reported” means a maintainer logged in
successfully but CI does not automate the provider.

| Provider | Status | Notes |
|---|---|---|
| Local mock OAuth/MCP server | CI-verified | Discovery, DCR, PKCE, code exchange, refresh rotation, pagination, resources, prompts, revocation |
| Todoist | Author-reported | Used as the running example; DCR; not automated in CI |

To add a provider, open a PR with a row and the exact command (redact tokens and
client ids). Do not mark a provider verified based only on the scan.

## Reproduce

```bash
# from a checkout of the Cursor marketplace repository
node tools/scan-servers.mjs --dir <checkout>/third_party
node tools/scan-servers.mjs --dir <checkout>/third_party --json > coverage.json
```

The scan is a development tool and is not included in the npm package.

## Why “57” is not “57 working logins”

- DCR can be advertised but disabled for third-party clients.
- Consent screens can reject a generic client name or require admin approval.
- A provider can require scopes, a client type, an exact redirect URI or extra
  authorization parameters that the scan cannot know.
- Login can succeed but the MCP server can still reject the token (`403`,
  `insufficient_scope`).

That is why the README calls this a **discovery/DCR** count and why provider
guides and end-to-end verification are separate.
