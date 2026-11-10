/**
 * Optional failure notifications.
 *
 * Set MCP_OAUTH_BRIDGE_NOTIFY_CMD (legacy DSH_MCP_OAUTH_NOTIFY_CMD) to a shell
 * command. It runs with:
 *   MCP_OAUTH_BRIDGE_EVENT    refresh_failed | reauth_required | connect_failed
 *   MCP_OAUTH_BRIDGE_SERVER
 *   MCP_OAUTH_BRIDGE_MESSAGE  human-readable message
 * The legacy MCP_OAUTH_EVENT / MCP_OAUTH_SERVER / MCP_OAUTH_MESSAGE names are
 * also set for backwards compatibility. No tokens are ever passed.
 *
 * Each (server, event) pair notifies at most once per process.
 */
import { spawn } from 'node:child_process';
import { env } from './env.mjs';

const sent = new Set();

export function resetNotifications() {
  sent.clear();
}

export function notify(event, server, message, { log = (m) => { process.stderr.write(m + '\n'); } } = {}) {
  log(`[${server}] ❌ ${message}`);
  const cmd = env('NOTIFY_CMD');
  if (!cmd) return Promise.resolve(false);
  const key = `${server}:${event}`;
  if (sent.has(key)) return Promise.resolve(false);
  sent.add(key);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      log(`[${server}] notify hook timed out after 15000 ms`);
      finish(false);
    }, 15_000);

    let child;
    try {
      const shell = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh';
      const args = process.platform === 'win32' ? ['/d', '/s', '/c', cmd] : ['-c', cmd];
      child = spawn(shell, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
        env: {
          ...process.env,
          MCP_OAUTH_BRIDGE_EVENT: event,
          MCP_OAUTH_BRIDGE_SERVER: server,
          MCP_OAUTH_BRIDGE_MESSAGE: message,
          // Legacy names for existing hooks.
          MCP_OAUTH_EVENT: event,
          MCP_OAUTH_SERVER: server,
          MCP_OAUTH_MESSAGE: message,
        },
      });
      child.on('error', (error) => {
        log(`[${server}] notify hook could not be executed: ${error.message}`);
        finish(false);
      });
      child.on('close', (code) => {
        if (code !== 0) log(`[${server}] notify hook exited with code ${code}`);
        finish(code === 0);
      });
    } catch (error) {
      log(`[${server}] notify hook failed: ${error.message}`);
      finish(false);
    }
  });
}
