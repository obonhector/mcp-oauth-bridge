# oauth-mcp-bridge

**Your MCP client speaks stdio. The remote MCP server wants OAuth. This bridges them.**

It performs the MCP OAuth dance once — resource metadata discovery (RFC 9728),
dynamic client registration (RFC 7591), authorization code with PKCE S256
(RFC 7636), resource indicator (RFC 8707) — stores the tokens, refreshes them on
401, and then exposes the remote server to your client over plain stdio. Multiple
servers, one process, no secrets in your config files.

## Install

```bash
# no install needed
npx oauth-mcp-bridge add todoist https://ai.todoist.net/mcp
npx oauth-mcp-bridge login todoist          # opens your browser, listens on 127.0.0.1:33418
npx oauth-mcp-bridge serve todoist          # stdio MCP server your client can spawn
```

Or globally: `npm i -g oauth-mcp-bridge`.

Works with any stdio client (Claude Desktop, Cursor, DSH, custom agents). Then
point the client at the `serve` command:

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

```bash
oauth-mcp-bridge status todoist   # tokens, expiry, scopes
oauth-mcp-bridge tools todoist    # list tools
oauth-mcp-bridge login todoist --headless   # no browser on the box? paste the redirect URL back
oauth-mcp-bridge serve-all        # every authorized server, prefixed by name
oauth-mcp-bridge logout todoist
```

**Measured coverage** (`npm run scan`): of 78 remote endpoints listed in the
Cursor MCP marketplace, **57 work with zero configuration** (metadata + dynamic
client registration): ahrefs, calendly, coda, gamma, gong, hunter, intercom,
jotform, klaviyo, square, statsig, todoist, trello, typeform, upwork and more.
20 need your own OAuth app (`--client-id`/`--client-secret`); 1 has malformed
metadata.

**Security**: tokens live in `~/.dsh/mcp-oauth/state/<name>.json` at mode `0600`
inside a `0700` directory, or in 1Password/libsecret if you prefer — never in the
client config. PKCE verifier never leaves the machine, `state` is validated,
callback binds to `127.0.0.1` only.

MIT licensed. Node >= 20.

---

## Detalle en español: por qué existe

Puente OAuth MCP para DeepSeek Harness (DSH).

DSH habla MCP por **stdio** y por **streamable-http con cabeceras estáticas**; no
tiene flujo OAuth. Comprobado en el código del plugin que trae el propio harness:

- `@deepseek-ai/dsh-mcp-client` solo acepta `command/args/env` (stdio) y
  `url/headers` (streamable-http) — su README documenta `headers` como única vía
  de autenticación remota.
- En su `lib/` no hay ninguna referencia a `authProvider`, `oauth` ni
  `Authorization` más allá de las cabeceras del usuario.

Este puente cubre ese hueco: hace **una vez** el baile OAuth del spec de MCP y
luego expone el servidor remoto a DSH por stdio, refrescando tokens solo.

```
DSH ──stdio──▶ bridge.mjs ──streamable-http + Bearer──▶ MCP remoto
                   │
                   └── tokens en ~/.dsh/mcp-oauth/state/<nombre>.json (0600)
```

## Qué implementa

| Paso | Estándar |
|---|---|
| Descubrimiento del recurso protegido | RFC 9728 (`/.well-known/oauth-protected-resource`) |
| Metadatos del servidor de autorización | RFC 8414 |
| Registro dinámico de cliente | RFC 7591 (`registration_endpoint`) |
| Authorization code + PKCE S256 | RFC 7636, con `state` anti-CSRF |
| Resource indicator | RFC 8707 (`resource=`) |
| Refresh automático | el SDK MCP refresca al recibir 401 |

Usa el SDK oficial (`@modelcontextprotocol/sdk`, instalado en este directorio).

## Uso

```bash
cd ~/.dsh/mcp-oauth

# 1. registrar el servidor
node bridge.mjs add todoist https://ai.todoist.net/mcp
#    o con cliente pre-registrado (Google, Microsoft, X, Zoom, Shopify...):
node bridge.mjs add gmail https://gmailmcp.googleapis.com/mcp/v1 --client-id XXX --client-secret YYY

# 2. autorizar (abre el navegador; el callback escucha en 127.0.0.1:33418)
node bridge.mjs login todoist

# 3. comprobar
node bridge.mjs status todoist
node bridge.mjs tools  todoist

# servidor stdio que consume DSH
node bridge.mjs serve todoist
```

Otros comandos: `logout <nombre>` (borra tokens), `logout <nombre> --forget-client`
(borra también el cliente registrado), `--port N` para el callback,
`--prefix p` para prefijar los nombres de herramienta.

## Enchufarlo a DSH

Añade una entrada en el patch layer del perfil que uses
(`~/.dsh/profiles/<perfil>/cordis.patch.yml`), igual que las que ya tienes:

```yaml
- insert:
    - id: mcp-todoist
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: todoist
        transport: stdio
        command: /Users/hector/.local/bin/node
        args:
          - /Users/hector/.dsh/mcp-oauth/bridge.mjs
          - serve
          - todoist
        failOnStartupError: false
        toolCallTimeoutMs: 60000
```

Las herramientas aparecen como `mcp__todoist__<nombre>`. Si aún no has hecho
`login`, el puente sale con código 2 y DSH lo registra como error de arranque
(el harness sigue funcionando: `failOnStartupError: false`).

## Cobertura real (medida, no estimada)

`node tools/scan-servers.mjs` recorre los 78 endpoints remotos del marketplace de
Cursor con el mismo código de descubrimiento que usa el puente:

- **57 listos** (metadata + registro dinámico): ahrefs, calendly, circleback,
  clay, coda, coinbase, craft, gamma, gong, greenhouse, guru, hunter, intercom,
  jotform, klaviyo, mem, navan, otter, outreach, readwise, semrush, square,
  statsig, todoist, trello, typeform, upwork, webull, workable…
- **20 con metadata pero sin DCR** → necesitan `--client-id` propio: github,
  gmail, google-calendar, google-cloud-bigquery, onedrive, outlook,
  outlook-calendar, teams, shopify-store, smartsheet, wrike, x, x-ads, x-money,
  zoom, docusign, excalidraw, godaddy, hubspot, finance.
- **1 anomalía**: sharepoint devuelve metadata que el SDK no puede validar
  (`ZodError`); se resolvería pasando `resourceMetadataUrl` a mano.

Los 9 proxys `api.cursor.com/rest-mcp/*` (google-docs/drive/sheets/slides,
onedrive, outlook, outlook-calendar, sharepoint, teams) exponen un servidor de
autorización de Cursor: el flujo se puede intentar, pero quien autoriza es la
cuenta de Cursor y no está garantizado que acepte clientes de terceros.

## Seguridad

- Tokens y cliente registrado en `~/.dsh/mcp-oauth/state/<nombre>.json`, modo
  `0600`, directorio `0700`. Nada de secretos en el YAML de DSH.
- `login` valida el parámetro `state` y usa PKCE S256; el `verifier` no sale de
  la máquina.
- `logout` borra los tokens en local; revocar el acceso en el proveedor es un
  paso manual en su web.
- El callback escucha solo en `127.0.0.1`.

## Límites conocidos

- El navegador hace falta una vez por servidor (no hay device-code flow).
- Los servidores sin DCR requieren que registres una app OAuth y pases
  `--client-id`/`--client-secret`.
- Puerto de callback fijo (33418) salvo `--port`; dos logins a la vez chocan.
- Pensado para un usuario: el estado es por máquina, no cifrado en reposo más
  allá de los permisos de fichero.

## Tests

```bash
node test/e2e.mjs
```

Levanta un servidor OAuth+MCP local (`test/mock-oauth-server.mjs`) y verifica
19 comprobaciones: fallo ruidoso sin autorizar, descubrimiento, registro
dinámico, PKCE, canje de código, proxy de `tools/list` y `tools/call`, refresh
al caducar el token y cliente pre-registrado sin DCR.

## Novedades v1.1 (PC Linux / headless)

### Almacén de tokens enchufable

| Backend | Cómo | Notas |
|---|---|---|
| `file` (defecto) | `state/<nombre>.json`, 0600, dir 0700 | igual que antes |
| `op` | 1Password vía `op` CLI; ítem `mcp-oauth:<nombre>`, campo `state` | funciona con service account (`OP_SERVICE_ACCOUNT_TOKEN`, p. ej. con `with-op-token`). Vault: `DSH_MCP_OAUTH_OP_VAULT` (defecto `DSH MCP OAuth`) |
| `libsecret` | `secret-tool` (service=mcp-oauth-bridge, server=<nombre>) | necesita un keyring desbloqueado en la sesión |

Se elige por servidor (`"store": "op"` en `servers.json`) o global con
`DSH_MCP_OAUTH_STORE=file|op|libsecret`. `servers.json` siempre es fichero.

### Refresh fallido: error claro + hook de aviso

Si el refresh token se rechaza, `serve` / `serve-all` escriben
`[<nombre>] ❌ el refresh del token falló; hace falta volver a autorizar: ... login <nombre> --headless`
y, si existe `DSH_MCP_OAUTH_NOTIFY_CMD`, lo ejecutan con `sh -c` y las variables
`MCP_OAUTH_EVENT` (`refresh_failed|reauth_required|connect_failed`),
`MCP_OAUTH_SERVER`, `MCP_OAUTH_MESSAGE`. Una vez por (servidor, evento) y proceso.
Nunca se pasan tokens. Ejemplo Telegram (los secretos vienen de tu entorno):

```bash
export DSH_MCP_OAUTH_NOTIFY_CMD='curl -fsS "https://api.telegram.org/bot$TG_TOKEN/sendMessage" -d chat_id="$TG_CHAT" --data-urlencode text="[mcp-oauth] $MCP_OAUTH_SERVER: $MCP_OAUTH_MESSAGE"'
```

### Multi-servidor: `serve-all`

```bash
node bridge.mjs serve-all              # todos los de servers.json
node bridge.mjs serve-all --only todoist,trello
```

Un solo proceso stdio; tools como `<servidor>__<tool>`. Los servidores sin
autorizar o caídos se omiten con aviso, el resto sigue. `serve <nombre>` sigue
existiendo y comparte el mismo código de proxy.

### Login sin navegador (SSH / Tailscale)

```bash
# A) túnel loopback: en el portátil
ssh -L 33418:127.0.0.1:33418 bots@berthier-pc
#    en el PC
node bridge.mjs login todoist --headless
#    abre AUTHORIZATION_URL en el navegador del portátil; el callback vuelve por el túnel.

# B) paste-back, sin túnel
node bridge.mjs login todoist --headless --paste-back
#    abre la URL en cualquier navegador; cuando redirija a 127.0.0.1:33418/callback?... 
#    (aunque diga "no se puede conectar") copia esa URL y pégala en la terminal.
```

Se valida `state` y el path del callback en la URL pegada.

### Tests

`npm test` = `test/e2e.mjs` (19 comprobaciones originales) + `test/store-notify.mjs`
(21: backends file/op/libsecret con CLIs simulados, notify + dedup, serve-all,
paste-back, refresh revocado → código 2 + aviso).
