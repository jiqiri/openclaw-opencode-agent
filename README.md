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
| `start-openclaw.sh` | Starts server + proxy with shared password file |
| `stop-openclaw.sh` | Stops server + proxy |
| `openclaw.json` / `install.sh` / `update.sh` / `openclaw.service` | Legacy (pre-2026.9 OpenClaw format), kept for reference |

## Security

- Everything binds `127.0.0.1` — nothing is exposed publicly.
- Never commit `~/.openclaw/.opencode-password`, gateway tokens, or API keys
  (`.gitignore` covers the password file; the repo contains no secrets).
- Educational/personal use; respect opencode's Terms of Service and model rate limits.
