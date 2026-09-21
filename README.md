# OpenClaw + opencode Proxy (v4.0)

OpenAI-compatible proxy (`opencode-proxy.js`) that exposes free opencode models
(Big Pickle, MiMo, Nemotron, Muse Spark, …) to OpenClaw through `opencode serve`.

No opencode API key needed — the proxy reuses the models and limits of your local
`opencode serve` instance.

## Architecture

```
OpenClaw (port 18789)
   │  OpenAI-compatible API
   ▼
opencode-proxy.js v4.0 (127.0.0.1:5200)
   │  opencode serve v2 HTTP API + Basic password auth
   ▼
opencode serve (127.0.0.1:5100)
   ▼
opencode free models
```

Per chat request the proxy does:

1. `POST /api/session` with `{ model, permissions: [{ action: "*", resource: "*", effect: "allow" }] }`
2. `POST /api/session/{id}/prompt` with `{ text, files? }`
3. `POST /api/experimental/session/{id}/wait` (blocks until the agent loop is idle,
   auto-approving permission requests concurrently)
4. `GET /api/session/{id}/message` → last `assistant` message → OpenAI response shape

## Prerequisites

- Node.js 18+
- `opencode` binary (v2.x, provides `opencode serve`)
- No `@opencode-ai/sdk` needed — v4.0 uses plain `fetch` (the 1.x SDK targets the removed sync API)

## Password auth (required)

Since opencode v2, `opencode serve` requires Basic auth (`opencode:<password>`) on
every API call. The proxy and the server **must share one password**.

```bash
# 1. Generate ONE password and store it (done once)
openssl rand -hex 32 > ~/.openclaw/.opencode-password
chmod 600 ~/.openclaw/.opencode-password

# 2. Export it before starting EITHER process
export OPENCODE_SERVER_PASSWORD=$(cat ~/.openclaw/.opencode-password)

# 3a. Start the server
opencode serve --hostname=127.0.0.1 --port=5100 &

# 3b. Start the proxy (same shell, same env)
cd ~/.openclaw && node opencode-proxy.js &
```

The included `start-openclaw.sh` does exactly this (generates the file if missing,
exports it, starts server → proxy in order with port checks). Preferred:

```bash
~/.openclaw/start-openclaw.sh   # start
~/.openclaw/stop-openclaw.sh    # stop
```

### systemd (recommended — survives SSH logout)

Shell-started processes die with your SSH session. User systemd units with
lingering keep everything alive after logout:

```bash
# 1. Portable password env file (no secrets in unit files)
printf 'OPENCODE_SERVER_PASSWORD=%s\n' "$(cat ~/.openclaw/.opencode-password)" \
  > ~/.openclaw/.opencode-password.env
chmod 600 ~/.openclaw/.opencode-password.env

# 2. Install the units from this repo
cp systemd/opencode.service systemd/opencode-proxy.service ~/.config/systemd/user/

# 3. Enable + start, allow lingering
systemctl --user daemon-reload
systemctl --user enable --now opencode.service opencode-proxy.service
loginctl enable-linger  # one-time: keeps user services running after logout

# 4. Confirm
systemctl --user is-active opencode opencode-proxy
curl http://127.0.0.1:5200/health   # "sdk":"reachable"
```

You can now exit SSH — both services keep running (`Restart=always` also
recovers them from crashes).

If the proxy exits with `OPENCODE_SERVER_PASSWORD is required`, or the SDK keeps
returning `401`, the password env is missing or doesn't match the server's —
restart both from the same exported value.

## Install from this repo

```bash
git clone <this-repo>
cd openclaw-opencode-agent
mkdir -p ~/.openclaw/logs
cp opencode-proxy.js start-openclaw.sh stop-openclaw.sh ~/.openclaw/
chmod +x ~/.openclaw/start-openclaw.sh ~/.openclaw/stop-openclaw.sh
~/.openclaw/start-openclaw.sh
```

> Note: `openclaw.json` / `install.sh` / `update.sh` in this repo target the legacy
> OpenClaw config format (pre-2026.9). OpenClaw ≥ 2026.9 uses a native `opencode`
> provider plugin — do **not** overwrite `~/.openclaw/openclaw.json` with it.
> To route OpenClaw through the proxy, register a custom OpenAI-compatible
> provider with base URL `http://127.0.0.1:5200/`.

### Wire OpenClaw chat to the free models (additive, no breakage)

OpenClaw ≥ 2026.9 merges custom providers over its built-ins
(`models.mode: "merge"`), so this only *adds* a provider and switches two model
ids — plugins, channels, gateway settings are untouched:

```bash
# 1. Back up (one-off safety net)
cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.pre-proxy-bak

# 2. Register the proxy as provider "proxy" (dry-run first)
openclaw config patch --file - --dry-run <<'EOF'
{ models: { mode: "merge", providers: { proxy: {
  baseUrl: "http://127.0.0.1:5200/", api: "openai-completions", models: [
    { id: "proxy/big-pickle", name: "Big Pickle (local proxy)",
      api: "openai-completions", input: ["text"], contextWindow: 200000, maxTokens: 32000 },
    { id: "proxy/mimo-v2.5-free", name: "MiMo V2.5 Free (local proxy)",
      api: "openai-completions", input: ["text", "image"], contextWindow: 200000, maxTokens: 32000 }
  ] } } } }
EOF
# remove --dry-run to apply (no gateway restart needed)

# 3. Point the default agent at the proxy model
openclaw config set agents.defaults.model.primary proxy/big-pickle
openclaw config set agents.entries.main.model proxy/big-pickle

# 4. Verify — expect provider "proxy", cost 0
openclaw agent -m "Reply with exactly: TEST_OK. Do not use any tools." \
  --json --timeout 180
```

Rollback is one copy: `cp ~/.openclaw/openclaw.json.pre-proxy-bak ~/.openclaw/openclaw.json`.

### Tool bridge v4.1 (OpenClaw tools work through the proxy)

Text-only proxying can't trigger OpenClaw's tool loop (the harness acts only on
`tool_calls`, which a plain completion never returns). v4.1 adds a bridge so UI
chat gets **free model + OpenClaw tools**, no billing, no OpenClaw core changes:

```
OpenClaw harness --tools--> proxy --prompt + tool catalog--> opencode loop
      ^                         |  oc_call capture files  |
      └-- executes real tools --┘<---- tool_calls ---------┘
```

How it works:

1. A static MCP server (`bridge/ocbridge.cjs`) exposes exactly ONE tool,
   `oc_call {tool, arguments}`. It never executes anything — it records the
   call under `~/.openclaw/bridge-calls/<sessionId>.jsonl` and returns a
   stop sentinel.
2. On any chat request containing `tools`, the proxy spawns a throwaway
   session, injects the caller's function schemas as `<openclaw_tools>` JSON
   plus a strict call-only-that-tool protocol, and polls the capture files.
3. On capture it interrupts the loop and returns real OpenAI `tool_calls`
   (`finish_reason: tool_calls`, streaming supported). OpenClaw executes with
   its own tools; results come back next turn and the loop continues.
4. No capture by timeout → falls back to the text answer (v4.0 behavior).

Setup (one-time, on top of the proxy install):

```bash
cp bridge/ocbridge.cjs ~/.openclaw/
mkdir -p ~/.openclaw/bridge-calls
# merge bridge/opencode-mcp-snippet.jsonc into ~/.config/opencode/opencode.jsonc
# under mcp.servers, then:
systemctl --user restart opencode.service   # picks up the MCP server
```

Env flags: `BRIDGE_ENABLED` (default `true`; `false` = pure v4.0 text),
`BRIDGE_DIR` (capture dir, default `~/.openclaw/bridge-calls`).
`tool_choice: "none"` also bypasses the bridge per request.

Limits: tool *selection* relies on the model reading the injected catalog
(verified working on big-pickle/mimo-v2.5-free, incl. parallel calls);
each bridge turn costs one extra loop pass; bridge sessions are deleted after
every turn (no cross-talk, no leaks).

## Verify

```bash
curl http://127.0.0.1:5200/health
# {"status":"ok","version":"4.0","proxy":"running","sdk":"reachable",...}
# "sdk":"unreachable" almost always means a password mismatch (see above).

curl http://127.0.0.1:5200/v1/models

curl -X POST http://127.0.0.1:5200/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"opencode/big-pickle",
       "messages":[{"role":"user","content":"Say hello"}],
       "stream":false}'
```

## Models

Live `opencode` provider lineup (refresh with
`curl -su opencode:$OPENCODE_SERVER_PASSWORD http://127.0.0.1:5100/api/model`):

| Proxy id | Context |
|----------|---------|
| `opencode/big-pickle` | 200,000 |
| `opencode/mimo-v2.5-free` | 200,000 |
| `opencode/nemotron-3-ultra-free` | 1,000,000 |
| `opencode/nemotron-3.5-lightning-free` | 262,144 |
| `opencode/muse-spark-1.3-contributor-free` | 1,048,576 |
| `opencode/muse-spark-1.2-contributor-free` | 1,048,576 |
| `opencode/ling-3.0-flash-fin-free` | 262,144 |

Retired ids (`mimo-v2-pro-free`, `mimo-v2-omni-free`, `minimax-m2.5-free`,
`nemotron-3-super-free`, `qwen3.6-plus-free`, `gpt-5-nano`, `:high`/`:max`/… variants)
are auto-mapped to the closest live model with a warning. Unknown ids return 400
listing the valid ones.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCODE_SERVER_PASSWORD` | — (required) | Must match `opencode serve` password |
| `PROXY_PORT` | `5200` | Proxy listen port |
| `SDK_URL` | `http://127.0.0.1:5100` | `opencode serve` URL |
| `BIND_HOST` | `127.0.0.1` | Proxy bind host (keep loopback) |
| `REQUEST_TIMEOUT_MS` | `180000` | Timeout for prompt+wait cycle |
| `STREAM_CHUNK_SIZE` / `STREAM_CHUNK_DELAY_MS` | `80` / `15` | Fake-stream chunking |
| `LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` |
| `AUTO_APPROVE_PERMISSIONS` | `true` | Auto-reply `always` to tool permission requests (disable only if you reply manually — otherwise requests stall) |
| `POLL_INTERVAL_MS` | `750` | Permission/form sweep interval while waiting |
| `REASONING_FORMAT` | `blockquote` | `blockquote`/`details`/`hidden`/`inline` |
| `SYSTEM_PROMPT_INJECTION` | (see proxy header) | Prepended to every prompt (`/prompt` has no native `system` field) |

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| Proxy exits: `OPENCODE_SERVER_PASSWORD is required` | Env not exported — export it (see above) or use `start-openclaw.sh` |
| `/health` shows `sdk: unreachable`, or SDK `401` | Password mismatch between proxy and server — regenerate once, restart **both** from the same value |
| `Unknown model "…"` (400) | Retired/typo'd id — error lists valid `opencode/…` ids |
| `504` timeout | Model slow — raise `REQUEST_TIMEOUT_MS`, retry |
| `[No response from model]` | Session produced no assistant message — check `opencode serve` logs, model availability |

## Files

| File | Description |
|------|-------------|
| `opencode-proxy.js` | Proxy v4.0 (OpenAI API → `opencode serve` v2 API) |
| `start-openclaw.sh` | Starts server + proxy with shared password file (manual/shell use) |
| `stop-openclaw.sh` | Stops server + proxy (manual/shell use) |
| `opencode.service` / `opencode-proxy.service` | systemd user units (`systemd/`, copy to `~/.config/systemd/user/`) |
| `openclaw.json` / `install.sh` / `update.sh` / `openclaw.service` | Legacy (pre-2026.9 OpenClaw format), kept for reference |

## Security

- Everything binds `127.0.0.1` — nothing is exposed publicly.
- Never commit `~/.openclaw/.opencode-password`, gateway tokens, or API keys
  (`.gitignore` covers the password file; the repo contains no secrets).
- Educational/personal use; respect opencode's Terms of Service and model rate limits.
