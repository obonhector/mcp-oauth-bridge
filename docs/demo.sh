#!/usr/bin/env bash
# Record with:
#   asciinema rec --overwrite docs/demo.cast -c "bash docs/demo.sh"
#   agg docs/demo.cast docs/demo.gif
set -euo pipefail
cd "$(dirname "$0")/.."

BIN=(node bridge.mjs)
TMP="$(mktemp -d /tmp/mcp-oauth-demo.XXXXXX)"
MOCK_PID=""
cleanup() {
  [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

export MCP_OAUTH_BRIDGE_DIR="$TMP"
export MCP_OAUTH_BRIDGE_NO_OPEN=1
export MOCK_ACCESS_TTL=60
export MOCK_RESOURCES=1
export MOCK_PROMPTS=1
export MOCK_META=1
export MOCK_PAGINATE=1

node test/mock-oauth-server.mjs >"$TMP/mock.log" 2>"$TMP/mock.err" &
MOCK_PID=$!
for _ in $(seq 1 50); do
  grep -q 'PORT=' "$TMP/mock.log" 2>/dev/null && break
  sleep 0.1
done
PORT="$(grep -o 'PORT=[0-9]*' "$TMP/mock.log" | cut -d= -f2)"
URL="http://127.0.0.1:$PORT/mcp"

banner() {
  printf '\n\033[1;36m$ %s\033[0m\n' "$*"
  sleep 0.5
}

printf '\033[1mMCP OAuth Bridge — local demo (no real account, mock OAuth server)\033[0m\n'
sleep 1

banner "oauth-mcp-bridge --version"
"${BIN[@]}" --version
sleep 0.8

banner "oauth-mcp-bridge add demo $URL --scopes test:read,test:write"
"${BIN[@]}" add demo "$URL" --scopes test:read,test:write
sleep 0.8

banner "oauth-mcp-bridge login demo --no-open --port 0"
"${BIN[@]}" login demo --no-open --skip-verify --port 0 >"$TMP/login.out" 2>"$TMP/login.err" &
LOGIN_PID=$!
for _ in $(seq 1 100); do
  grep -q 'AUTHORIZATION_URL=' "$TMP/login.err" 2>/dev/null && break
  sleep 0.1
done
AUTH_URL="$(grep -o 'AUTHORIZATION_URL=[^ ]*' "$TMP/login.err" | head -1 | cut -d= -f2-)"
printf '  AUTHORIZATION_URL=%s\n' "$AUTH_URL" | fold -w 100
sleep 0.8
printf '\n  (following the redirect as the browser would)\n'
curl -sL "$AUTH_URL" >/dev/null
wait "$LOGIN_PID"
grep -E 'Authorized|access_token|refresh_token|scope|client_id|store' "$TMP/login.err" | grep -v AUTHORIZATION_URL | sed 's/^/  /'
sleep 1

banner "oauth-mcp-bridge status demo --offline"
"${BIN[@]}" status demo --offline
sleep 1

banner "oauth-mcp-bridge tools demo"
"${BIN[@]}" tools demo
sleep 1

banner "stdio client -> oauth-mcp-bridge serve demo -> mock MCP"
node docs/demo-client.mjs
sleep 1

printf '\n\033[1;32mDone.\033[0m The token lives in the token store, not in the client config.\n'
sleep 1
