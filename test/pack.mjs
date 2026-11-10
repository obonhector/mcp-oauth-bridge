#!/usr/bin/env node
/**
 * Smoke test for the published tarball: pack it, install it in a temp prefix,
 * then run the installed binary. This catches missing files in `files` and a
 * broken `bin` entry that the unit tests cannot see.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const packDir = mkdtempSync(path.join(tmpdir(), 'oauth-mcp-pack-'));
const installDir = mkdtempSync(path.join(tmpdir(), 'oauth-mcp-install-'));
let failed = false;

function check(name, ok, detail = '') {
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    ...options,
  });
  return result;
}

try {
  const packed = run(npm, ['pack', '--silent', '--pack-destination', packDir]);
  check('npm pack succeeds', packed.status === 0, (packed.stderr || '').trim().split('\n').pop());
  const tarballName = readdirSync(packDir).find((name) => name.endsWith('.tgz'));
  check('tarball was produced', Boolean(tarballName), tarballName || 'not found');
  if (!tarballName) throw new Error('no tarball');
  const tarball = path.join(packDir, tarballName);

  const installed = run(npm, ['install', '--silent', '--no-audit', '--no-fund', '--prefix', installDir, tarball]);
  check('tarball installs in a clean prefix', installed.status === 0, (installed.stderr || '').trim().split('\n').pop());
  if (installed.status !== 0) throw new Error('install failed');

  const bin = path.join(installDir, 'node_modules', 'oauth-mcp-bridge', 'bridge.mjs');
  const version = run(process.execPath, [bin, '--version']);
  check('installed binary reports a version', version.status === 0 && /MCP OAuth Bridge \d+\.\d+\.\d+/.test(version.stdout), version.stdout.trim());
  const help = run(process.execPath, [bin, '--help']);
  check('installed binary prints usage', help.status === 0 && /Usage:/.test(help.stderr), help.stderr.split('\n').find((line) => /Usage:/.test(line)) || '');
} finally {
  rmSync(packDir, { recursive: true, force: true });
  rmSync(installDir, { recursive: true, force: true });
}

console.log(failed ? '\n❌ package smoke test failed' : '\n🎉 package smoke test OK');
process.exitCode = failed ? 1 : 0;
