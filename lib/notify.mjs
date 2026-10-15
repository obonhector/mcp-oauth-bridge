/**
 * Optional failure notifications.
 *
 * Set DSH_MCP_OAUTH_NOTIFY_CMD to a shell command; it runs via `sh -c` with:
 *   MCP_OAUTH_EVENT    e.g. refresh_failed | reauth_required | connect_failed
 *   MCP_OAUTH_SERVER   server name
 *   MCP_OAUTH_MESSAGE  human-readable message (Spanish)
 * No tokens are ever passed. Example (Telegram, secrets come from your env):
 *   DSH_MCP_OAUTH_NOTIFY_CMD='curl -fsS "https://api.telegram.org/bot$TG_TOKEN/sendMessage" \
 *     -d chat_id="$TG_CHAT" --data-urlencode text="[mcp-oauth] $MCP_OAUTH_SERVER: $MCP_OAUTH_MESSAGE"'
 * Each (server,event) pair notifies at most once per process.
 */
import { spawn } from 'node:child_process';

const sent = new Set();

export function notify(event, server, message, { log = (m) => process.stderr.write(m + '\n') } = {}) {
  log(`[${server}] ❌ ${message}`);
  const cmd = process.env.DSH_MCP_OAUTH_NOTIFY_CMD;
  if (!cmd) return Promise.resolve(false);
  const key = `${server}:${event}`;
  if (sent.has(key)) return Promise.resolve(false);
  sent.add(key);
  return new Promise((resolve) => {
    try {
      const child = spawn('sh', ['-c', cmd], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, MCP_OAUTH_EVENT: event, MCP_OAUTH_SERVER: server, MCP_OAUTH_MESSAGE: message },
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
      child.on('error', (e) => {
        clearTimeout(timer);
        log(`[${server}] notify hook no se pudo ejecutar: ${e.message}`);
        resolve(false);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) log(`[${server}] notify hook salió con código ${code}`);
        resolve(code === 0);
      });
    } catch (e) {
      log(`[${server}] notify hook falló: ${e.message}`);
      resolve(false);
    }
  });
}
