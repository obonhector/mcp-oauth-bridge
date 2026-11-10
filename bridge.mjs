#!/usr/bin/env node
/**
 * Entry point for the oauth-mcp-bridge CLI.
 * Everything human-facing goes to stderr; stdout is reserved for MCP traffic
 * and for machine-readable CLI output (`--json`, `--version`).
 */
import { main } from './lib/cli.mjs';

main().catch((error) => {
  process.stderr.write(`Error: ${error?.message || error}\n`);
  if (process.env.MCP_OAUTH_BRIDGE_DEBUG || process.env.DSH_MCP_OAUTH_DEBUG) {
    process.stderr.write(`${error?.stack || String(error)}\n`);
  }
  process.exitCode = 1;
});
