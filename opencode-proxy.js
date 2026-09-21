#!/usr/bin/env node
// OpenCode SDK Proxy — v4.3 (opencode serve v2 API)
// Talks to `opencode serve` v2.x HTTP API with pure fetch (no @opencode-ai/sdk,
// whose 1.x client targets the old /message sync API).
//
// Flow per chat request:
//   1. POST /api/session {model, permissions}            → session id
//   2. POST /api/session/{id}/prompt {text, files?}      → queues user msg
//   3. POST /api/experimental/session/{id}/wait          → blocks until idle
//      (concurrently: GET .../permission → POST .../reply {decision:'always'},
//       best-effort form replies)
//   4. GET  /api/session/{id}/message?order=asc          → last assistant msg
//
// Env: PROXY_PORT, SDK_URL, BIND_HOST, REQUEST_TIMEOUT_MS, STREAM_CHUNK_SIZE,
// STREAM_CHUNK_DELAY_MS, LOG_LEVEL, REASONING_FORMAT, AUTO_APPROVE_PERMISSIONS,
// POLL_INTERVAL_MS, SYSTEM_PROMPT_INJECTION, OPENCODE_SERVER_PASSWORD (required —
// must match the password of `opencode serve`; Basic auth user is `opencode`).

import http from 'http';

// ─── Configuration ──────────────────────────────────────────────────────────
const CONFIG = {
  port: parseInt(process.env.PROXY_PORT || '5200', 10),
  sdkUrl: (process.env.SDK_URL || 'http://127.0.0.1:5100').replace(/\/$/, ''),
  bindHost: process.env.BIND_HOST || '127.0.0.1',
  requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS || '180000', 10),
  streamChunkSize: parseInt(process.env.STREAM_CHUNK_SIZE || '80', 10),
  streamChunkDelayMs: parseInt(process.env.STREAM_CHUNK_DELAY_MS || '15', 10),
  logLevel: process.env.LOG_LEVEL || 'info',
  // Reasoning format: blockquote | details | hidden | inline
  reasoningFormat: process.env.REASONING_FORMAT || 'blockquote',
  // Auto-approve tool/file permission requests (else the agent loop stalls)
  autoApprovePermissions: process.env.AUTO_APPROVE_PERMISSIONS !== 'false',
  // Polling interval while waiting for the agent loop
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '750', 10),
  // Prepended to every prompt (v2 /prompt has no native `system` field)
  systemPromptInjection: process.env.SYSTEM_PROMPT_INJECTION ||
    'IMPORTANT: If you need to ask the user a question, a preference, or offer options — write it directly as text in your response. NEVER use internal interactive question/form tools. List options as a numbered list and end with "Please reply with your choice." The user will respond in their next message.',
  // Tool bridge (v4.1): translate OpenAI `tools` into oc_call bridge captures.
  // Requires the ocbridge MCP server in opencode config (see README).
  bridgeEnabled: process.env.BRIDGE_ENABLED !== 'false',
  bridgeDir: process.env.BRIDGE_DIR || (process.env.HOME + '/.openclaw/bridge-calls'),
  // After the first capture, keep the loop alive this long to collect
  // parallel batch mates before interrupting (native parity: N calls/turn).
  bridgeBatchMs: parseInt(process.env.BRIDGE_BATCH_MS || '12000', 10),
  // v4.2: reuse one bridge session per (auth,model) so the loop keeps memory
  // across turns (no more lost-results/redo). Reset after this many turns.
  bridgeMaxTurns: parseInt(process.env.BRIDGE_MAX_TURNS || '40', 10),
  // v4.3: bridge health + unavailability classifier. No serve API exposes
  // per-session tool attachment, so detection is reactive: scan the fresh
  // assistant text/reasoning produced during the turn for attach-loss signals.
  bridgeHealthUrl: process.env.BRIDGE_HEALTH_URL || 'http://127.0.0.1:8899/mcp',
  // v4.3: helper retained for manual/opt-in use, but the recovery flow does
  // NOT bounce the bridge automatically: restarting it severs opencode's
  // live MCP connections and the client does not reconnect cleanly
  // (observed death spiral). Default OFF; serve restart is the refresh lever.
  bridgeRestartUnit: process.env.BRIDGE_RESTART_UNIT || '',
};

const SDK_PASSWORD = process.env.OPENCODE_SERVER_PASSWORD;
if (!SDK_PASSWORD) {
  console.error(
    '❌ [ERROR] OPENCODE_SERVER_PASSWORD is required.\n' +
    '   Start the proxy with the same password as `opencode serve`, e.g.:\n' +
    '   export OPENCODE_SERVER_PASSWORD=$(tr \'\\0\' \'\\n\' < /proc/$(pgrep -f "opencode serve" | head -n1)/environ | grep OPENCODE_SERVER_PASSWORD | cut -d= -f2-)\n' +
    '   (Better: generate one password, store it in ~/.openclaw/.opencode-password,\n' +
    '    and export it before starting BOTH `opencode serve` and this proxy.)'
  );
  process.exit(1);
}
const SDK_AUTH = 'Basic ' + Buffer.from(`opencode:${SDK_PASSWORD}`).toString('base64');

// ─── Logger ─────────────────────────────────────────────────────────────────
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
function log(level, msg) {
  if (LOG_LEVELS[level] >= LOG_LEVELS[CONFIG.logLevel]) {
    const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : level === 'debug' ? '🔍' : 'ℹ️';
    console.log(`[${new Date().toISOString()}] ${prefix} [${level.toUpperCase()}] ${msg}`);
  }
}

// ─── Model Catalog (live `opencode` provider, refreshed 2026-09) ────────────
// NOTE: opencode's free-model lineup rotates. Refresh with:
//   curl -su opencode:$OPENCODE_SERVER_PASSWORD $SDK_URL/api/model
const MODEL_CATALOG = [
  { id: 'big-pickle', name: 'Big Pickle', contextWindow: 200000, maxTokens: 32000, input: ['text'], reasoning: true },
  { id: 'mimo-v2.5-free', name: 'MiMo V2.5 Free', contextWindow: 200000, maxTokens: 32000, input: ['text', 'image'], reasoning: true },
  { id: 'nemotron-3-ultra-free', name: 'Nemotron 3 Ultra Free', contextWindow: 1000000, maxTokens: 128000, input: ['text'], reasoning: false },
  { id: 'nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning Free', contextWindow: 262144, maxTokens: 262144, input: ['text'], reasoning: false },
  { id: 'muse-spark-1.3-contributor-free', name: 'Muse Spark 1.3 Free', contextWindow: 1048576, maxTokens: 131072, input: ['text', 'image'], reasoning: true },
  { id: 'muse-spark-1.2-contributor-free', name: 'Muse Spark 1.2 Free', contextWindow: 1048576, maxTokens: 131072, input: ['text', 'image'], reasoning: true },
  { id: 'ling-3.0-flash-fin-free', name: 'Ling 3.0 Flash Fin Free', contextWindow: 262144, maxTokens: 32768, input: ['text'], reasoning: false },
];

// Deprecated ids from older proxy versions → live replacement (else clear 400)
const MODEL_ALIASES = {
  'mimo-v2-pro-free': 'mimo-v2.5-free',
  'mimo-v2-omni-free': 'mimo-v2.5-free',
  'minimax-m2.5-free': 'mimo-v2.5-free',
  'nemotron-3-super-free': 'nemotron-3-ultra-free',
  'qwen3.6-plus-free': 'ling-3.0-flash-fin-free',
  'gpt-5-nano': 'ling-3.0-flash-fin-free',
};

const MODEL_LOOKUP = new Map(MODEL_CATALOG.map((m) => [m.id, m]));

function buildModelsResponse() {
  return JSON.stringify({
    data: MODEL_CATALOG.map((m) => ({ id: `opencode/${m.id}`, name: m.name, context_window: m.contextWindow })),
  });
}
const MODELS_RESPONSE_JSON = buildModelsResponse();

// ─── Session Manager ────────────────────────────────────────────────────────
// Sessions are bound to a model at creation (v2 sets model on create/switch).
const sessions = new Map();
function sessionKey(authKey, modelId, variant) {
  return `${authKey}::${modelId}::${variant || 'default'}`;
}

// ─── SDK HTTP helpers (pure fetch, Basic auth) ──────────────────────────────
function authHeaders(extra) {
  return { 'Content-Type': 'application/json', Authorization: SDK_AUTH, ...(extra || {}) };
}

async function parseJsonOrEmpty(resp) {
  const text = await resp.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

async function sdkPost(urlPath, body, timeoutMs) {
  const controller = new AbortController();
  const timeout = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const resp = await fetch(`${CONFIG.sdkUrl}${urlPath}`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body === undefined ? {} : body),
      signal: controller.signal,
    });
    if (timeout) clearTimeout(timeout);
    if (resp.status === 204) return null;
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`SDK ${urlPath} returned ${resp.status}: ${errText.slice(0, 500)}`);
    }
    return await parseJsonOrEmpty(resp);
  } catch (err) {
    if (timeout) clearTimeout(timeout);
    if (err.name === 'AbortError') throw new Error(`SDK request timed out after ${timeoutMs}ms`);
    throw err;
  }
}

async function sdkGet(urlPath) {
  const resp = await fetch(`${CONFIG.sdkUrl}${urlPath}`, {
    headers: { Authorization: SDK_AUTH },
  });
  if (!resp.ok) return null;
  return await parseJsonOrEmpty(resp);
}

// ─── Permission / form auto-approval (per-session, v2 endpoints) ────────────
async function autoReplyPermissions(sessionId) {
  if (!CONFIG.autoApprovePermissions) return;
  let list;
  try {
    list = await sdkGet(`/api/session/${sessionId}/permission`);
  } catch (e) {
    log('debug', `perm list failed: ${e.message}`);
    return;
  }
  const reqs = list?.data;
  if (!Array.isArray(reqs) || reqs.length === 0) return;
  for (const req of reqs) {
    if (!req?.id) continue;
    log('info', `Auto-approving permission: ${req.action} [${(req.resources || []).join(', ')}]`);
    try {
      await sdkPost(`/api/session/${sessionId}/permission/${req.id}/reply`, { decision: 'always' });
    } catch (e) {
      log('warn', `Failed to approve permission ${req.id}: ${e.message}`);
    }
  }
}

async function autoReplyForms(sessionId) {
  // Best-effort: answer pending forms with the first option so the loop
  // doesn't stall. Failures are non-fatal (logged at debug).
  let list;
  try {
    list = await sdkGet(`/api/session/${sessionId}/form`);
  } catch { return; }
  const forms = list?.data;
  if (!Array.isArray(forms) || forms.length === 0) return;
  for (const f of forms) {
    if (!f?.id) continue;
    try {
      const questions = f.questions || f.fields || [];
      const answer = {};
      for (const q of questions) {
        const key = q.id || q.name || q.key;
        if (!key) continue;
        if (Array.isArray(q.options) && q.options.length > 0) {
          const o = q.options[0];
          answer[key] = o.value !== undefined ? o.value : (o.label !== undefined ? o.label : o);
        } else {
          answer[key] = 'yes';
        }
      }
      log('info', `Auto-answering form ${f.id}`);
      await sdkPost(`/api/session/${sessionId}/form/${f.id}/reply`, { answer });
    } catch (e) {
      log('debug', `Form ${f.id} auto-reply failed: ${e.message}`);
    }
  }
}

// Wait for the agent loop to go idle while sweeping permissions/forms.
async function waitForIdle(sessionId) {
  const poller = setInterval(() => {
    autoReplyPermissions(sessionId).catch(() => {});
    autoReplyForms(sessionId).catch(() => {});
  }, CONFIG.pollIntervalMs);
  try {
    await sdkPost(`/api/experimental/session/${sessionId}/wait`, {}, CONFIG.requestTimeoutMs);
  } finally {
    clearInterval(poller);
  }
  await autoReplyPermissions(sessionId).catch(() => {});
}

const fs = await import('fs');

// ─── Tool bridge (v4.1) ─────────────────────────────────────────────────────
// OpenAI tools -> oc_call MCP captures -> OpenAI tool_calls.
// The ocbridge MCP server (static, in opencode config) exposes ONE tool:
//
//   oc_call { tool: "<exact OpenClaw function name>", arguments: "<JSON string>" }
//
// Per request the proxy injects the caller's function schemas as
// <openclaw_tools> JSON + a strict protocol. When the loop calls oc_call,
// this server records {tool, arguments} to BRIDGE_DIR/<sessionId>.jsonl.
// The proxy polls those files, interrupts the loop, and returns real
// OpenAI tool_calls for OpenClaw to execute with its own tools.
function buildBridgeProtocol(tools) {
  const fns = (tools || [])
    .filter((t) => t?.type === 'function' && t?.function?.name)
    .map((t) => ({ name: t.function.name, description: t.function.description || '', parameters: t.function.parameters || { type: 'object', properties: {} } }));
  return `You have exactly ONE tool available: oc_call. Its input schema is {"tool": "string (exact function name below)", "arguments": "string (JSON object string for that function)"}.
<openclaw_tools>
${JSON.stringify(fns)}
</openclaw_tools>
PROTOCOL (follow exactly):
1. If the user request needs OpenClaw functions, call oc_call with the exact "tool" name and "arguments" as a JSON string. Match "tool" character-for-character against <openclaw_tools> — never invent, rename, or substitute names.
2. If several INDEPENDENT OpenClaw functions are needed, call oc_call once per function BACK-TO-BACK in the same turn before stopping (batch them like a native parallel tool call).
3. Do NOT use any built-in tools (no file/shell/web tools) when an OpenClaw function applies — the caller executes OpenClaw functions itself.
4. After calling oc_call, STOP. Do not write any text after the calls.
5. If no OpenClaw function applies, answer with plain text and call nothing.`;
}

function renderConversation(messages) {
  // OpenAI messages (incl. prior assistant tool_calls + tool results) -> text.
  const parts = [];
  for (const msg of messages) {
    if (msg.role === 'system') continue;
    if (typeof msg.content === 'string' && msg.content) {
      parts.push(msg.role === 'assistant' ? `[Assistant]\n${msg.content}` : `[User]\n${msg.content}`);
    } else if (Array.isArray(msg.content)) {
      const t = msg.content.filter((p) => p.type === 'text' && p.text).map((p) => p.text).join('\n');
      if (t) parts.push(`[User]\n${t}`);
    }
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        parts.push(`[Assistant requested tool: ${tc.function?.name} ${tc.function?.arguments || ''}]`);
      }
    }
    if (msg.role === 'tool') {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      parts.push(`[Tool ${msg.name || ''} returned: ${content}]`);
    }
  }
  return parts.join('\n\n') || ' ';
}

function readCaptures(sessionId) {
  try {
    const raw = fs.readFileSync(`${CONFIG.bridgeDir}/${sessionId}.jsonl`, 'utf8');
    return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

function clearCaptures(sessionId) {
  try { fs.unlinkSync(`${CONFIG.bridgeDir}/${sessionId}.jsonl`); } catch {}
}

async function deleteSession(sessionId) {
  try {
    await fetch(`${CONFIG.sdkUrl}/api/session/${sessionId}`, {
      method: 'DELETE', headers: { Authorization: SDK_AUTH },
    });
  } catch {}
}

async function interruptSession(sessionId) {
  try {
    await fetch(`${CONFIG.sdkUrl}/api/experimental/session/${sessionId}/interrupt`, {
      method: 'POST', headers: authHeaders(), body: '{}',
    });
  } catch {}
  try {
    await fetch(`${CONFIG.sdkUrl}/api/session/${sessionId}/interrupt`, {
      method: 'POST', headers: authHeaders(), body: '{}',
    });
  } catch {}
}

// v4.2: persistent bridge sessions. The loop keeps memory across turns, so
// follow-ups send ONLY new messages (catalog + protocol injected once at
// creation). Reset when the client history shrinks (new conversation),
// on error, or after BRIDGE_MAX_TURNS.
const bridgeSessions = new Map(); // sKey -> { sessionId, sentCount, turns }

async function getOrCreateBridgeSession(authKey, modelId, variant) {
  const sKey = sessionKey(authKey, modelId, variant);
  const cached = bridgeSessions.get(sKey);
  if (cached) return { ...cached, sKey, isNew: false };
  const modelRef = { providerID: 'opencode', id: modelId };
  if (variant) modelRef.variant = variant;
  const created = await sdkPost('/api/session', {
    model: modelRef,
    permissions: [{ action: '*', resource: '*', effect: 'allow' }],
  });
  const sessionId = created?.data?.id;
  if (!sessionId) throw new Error('Failed to create bridge session');
  const entry = { sessionId, sKey, sentCount: 0, turns: 0, isNew: true };
  bridgeSessions.set(sKey, entry);
  log('info', `New bridge session: ${sessionId} for ${modelId}`);
  return entry;
}

function dropBridgeSession(sKey) {
  const e = bridgeSessions.get(sKey);
  bridgeSessions.delete(sKey);
  if (e) { clearCaptures(e.sessionId); deleteSession(e.sessionId); }
}

// v4.3: bounce the bridge unit so opencode's MCP client reconnects clean.
// Returns true when the unit is active again afterwards.
import { execFile as _execFile } from 'child_process';
function execFileAsync(cmd, args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    _execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.join(' ')}: ${err.message}`));
      else resolve(stdout);
    });
  });
}
async function restartBridgeUnit(reason) {
  const unit = CONFIG.bridgeRestartUnit;
  if (!unit) { log('warn', `Bridge restart skipped (BRIDGE_RESTART_UNIT empty), reason=${reason}`); return false; }
  try {
    log('warn', `Bridge bounce unit=${unit} reason=${reason}`);
    await execFileAsync('systemctl', ['--user', 'restart', unit]);
    await new Promise((r) => setTimeout(r, 3000));
    const st = (await execFileAsync('systemctl', ['--user', 'is-active', unit])).trim();
    log('info', `Bridge bounce unit=${unit} state=${st}`);
    return st === 'active';
  } catch (e) {
    log('warn', `Bridge bounce unit=${unit} FAILED: ${e.message}`);
    return false;
  }
}

// v4.3: case split for bridge health. A=bridge down, B+=bridge up (per-turn
// evidence decides B vs normal-text inside the race).
async function checkBridgeHealth() {
  const started = Date.now();
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch(CONFIG.bridgeHealthUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'health', method: 'tools/list', params: {} }),
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!resp.ok) return { ok: false, ms: Date.now() - started, detail: `http ${resp.status}` };
    const data = await resp.json().catch(() => null);
    const tools = data?.result?.tools;
    if (!Array.isArray(tools) || !tools.some((x) => x?.name === 'oc_call')) {
      return { ok: false, ms: Date.now() - started, detail: 'oc_call missing from tools/list' };
    }
    return { ok: true, ms: Date.now() - started, detail: 'oc_call listed' };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, detail: e.message };
  }
}

// v4.3: attach-loss signal. Matches model wording observed when opencode's
// MCP client has the tool cataloged but execution fails ("No tool named
// 'tools.ocbridge.oc_call' ... not available ...").
const UNAVAIL_RE = /not available|isn'?t available|unavailable|cannot (see|find|access|use|call).{0,60}tool|no .*tool (named|called)|tool .* (missing|unavailable)|doesn'?t (have|show|list).{0,40}tool/i;

function scanUnavail(text, reasoning) {
  const hay = `${text || ''}\n${reasoning || ''}`;
  return UNAVAIL_RE.test(hay);
}

// v4.3: one turn race. Returns { toolCalls } on capture, else
// { textResult, sawUnavail } where sawUnavail flags attach-loss evidence.
async function raceBridgeTurn(sessionId, sentAt, validNames, modelId) {
  const tag = `Bridge [sid=${sessionId} model=${modelId}]`;
  const poller = setInterval(() => {
    autoReplyPermissions(sessionId).catch(() => {});
    autoReplyForms(sessionId).catch(() => {});
  }, CONFIG.pollIntervalMs);
  const deadline = Date.now() + CONFIG.requestTimeoutMs;
  let firstCaptureAt = 0;
  let sawUnavail = false;
  let lastDropped = 0;
  const checkText = (t, r) => { if (!sawUnavail && scanUnavail(t, r)) { sawUnavail = true; log('warn', `${tag} availability-check=MISSING (unavail signal in model output)`); } };
  try {
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, CONFIG.pollIntervalMs));
      const all = readCaptures(sessionId);
      const captures = all.filter((c) => validNames.has(String(c.arguments?.tool || '')));
      if (all.length - captures.length !== lastDropped) {
        lastDropped = all.length - captures.length;
        if (lastDropped > 0) log('warn', `${tag} case=C dropped ${lastDropped} capture(s) with unknown tool name`);
      }
      if (captures.length > 0) {
        log('info', `${tag} availability-check=ATTACHED (${captures.length} capture(s))`);
        if (!firstCaptureAt) firstCaptureAt = Date.now();
        if (Date.now() - firstCaptureAt < CONFIG.bridgeBatchMs) continue;
        await interruptSession(sessionId);
        const toolCalls = captures.map((c, i) => ({
          id: `call_${Date.now().toString(36)}${i}`,
          type: 'function',
          function: {
            name: String(c.arguments?.tool || ''),
            arguments: typeof c.arguments?.arguments === 'string'
              ? c.arguments.arguments
              : JSON.stringify(c.arguments?.arguments ?? {}),
          },
        })).filter((tc) => tc.function.name);
        if (toolCalls.length > 0) return { toolCalls };
      }
      // Fresh assistant text after our prompt => direct answer, no tools.
      try {
        const listed = await sdkGet(`/api/session/${sessionId}/message?order=desc&limit=5`);
        const fresh = (listed?.data || []).find((m) =>
          m?.type === 'assistant' && (m?.time?.created || 0) >= sentAt &&
          (m?.content || []).some((c) => c.type === 'text' && c.text));
        if (fresh) {
          const out = extractAssistant([fresh]);
          if (out?.textContent) {
            checkText(out.textContent, out.reasoningContent);
            await interruptSession(sessionId); // stop background loop before reuse
            return { textResult: out, sawUnavail };
          }
        }
      } catch {}
    }
  } finally {
    clearInterval(poller);
  }
  await interruptSession(sessionId);
  // Fallback: no bridge call -> latest text from the session.
  await waitForIdle(sessionId).catch(() => {});
  const listed = await sdkGet(`/api/session/${sessionId}/message?order=asc&limit=100`);
  const result = extractAssistant(listed?.data);
  if (result) checkText(result.responseText, result.reasoningContent);
  return { textResult: result, sawUnavail };
}

// v4.3: recovery retry for case B. Fresh session, system + catalog injected
// ONCE (new session needs it), ONLY the current turn's messages (no replay of
// completed calls/history). Single attempt, no nested recovery.
async function bridgeRecoveryTurn(authKey, modelId, variant, retryMsgs, fullCount, files, systemPrompt, tools) {
  let entry;
  try {
    entry = await getOrCreateBridgeSession(authKey, modelId, variant);
  } catch (e) {
    log('warn', `Bridge [model=${modelId}] recovery reattach FAILED at session create: ${e.message}`);
    return null;
  }
  const { sessionId, sKey } = entry;
  log('info', `Bridge [sid=${sessionId} model=${modelId}] reattach OK (fresh session), retry msgs=${retryMsgs.length} catalog=injected`);
  try {
    await ensureModel(sessionId, modelId, variant);
    const convText = renderConversation(retryMsgs);
    const fullText = [systemPrompt, buildBridgeProtocol(tools), convText].filter(Boolean).join('\n\n');
    const body = { text: fullText };
    if (files.length > 0) body.files = files;
    const sentAt = Date.now();
    clearCaptures(sessionId);
    await sdkPost(`/api/session/${sessionId}/prompt`, body, 30000);
    entry.sentCount = fullCount; // future turns continue incrementally off full history
    entry.turns = 1;
    bridgeSessions.set(sKey, entry);
    const validNames = new Set(
      (tools || []).filter((t) => t?.type === 'function' && t?.function?.name).map((t) => t.function.name));
    return await raceBridgeTurn(sessionId, sentAt, validNames, modelId);
  } catch (e) {
    log('warn', `Bridge [sid=${sessionId} model=${modelId}] recovery retry FAILED: ${e.message}`);
    dropBridgeSession(sKey);
    return null;
  }
}

async function sendPromptWithTools(authKey, modelId, variant, messages, files, systemPrompt, tools) {
  const maxRetries = 2;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let entry = await getOrCreateBridgeSession(authKey, modelId, variant);
    let { sessionId, sKey } = entry;
    try {
      await ensureModel(sessionId, modelId, variant);

      // New conversation on a reused key? History did not grow (same length
      // = retry/duplicate, shorter = new chat) -> reset to a fresh session.
      // Only a strictly longer history is a true continuation.
      if (!entry.isNew && messages.length <= entry.sentCount) {
        log('info', 'Bridge history did not grow, resetting session (new conversation)');
        dropBridgeSession(sKey);
        entry = await getOrCreateBridgeSession(authKey, modelId, variant);
        sessionId = entry.sessionId;
      }

      // Incremental forward: only messages the loop hasn't seen yet.
      const fresh = messages.slice(entry.sentCount);
      const retryMsgs = fresh.length > 0 ? fresh : messages; // current turn only (recovery-safe)
      const convText = renderConversation(retryMsgs);
      const validNames = new Set(
        (tools || []).filter((t) => t?.type === 'function' && t?.function?.name).map((t) => t.function.name));
      const isFirstTurn = entry.sentCount === 0;
      // Catalog + protocol injected once (creation turn); later turns rely
      // on loop memory. System prompt likewise (avoids duplication noise).
      const fullText = isFirstTurn
        ? [systemPrompt, buildBridgeProtocol(tools), convText].filter(Boolean).join('\n\n')
        : convText;
      if (isFirstTurn) log('info', `Bridge [sid=${sessionId} model=${modelId}] catalog=injected (first turn, msgs=${messages.length})`);
      const body = { text: fullText };
      if (files.length > 0) body.files = files;
      const sentAt = Date.now();
      clearCaptures(sessionId); // stale captures from a prior turn must not retrigger
      await sdkPost(`/api/session/${entry.sessionId}/prompt`, body, 30000);
      entry.sentCount = messages.length;
      entry.turns += 1;
      if (entry.turns >= CONFIG.bridgeMaxTurns) {
        log('info', `Bridge session hit ${entry.turns} turns, will reset next turn`);
        dropBridgeSession(sKey);
      } else {
        bridgeSessions.set(sKey, entry);
      }

    // v4.3: race for captures vs direct text; the outcome carries an
    // attach-loss flag so the orchestrator below can classify + recover.
    const outcome = await raceBridgeTurn(sessionId, sentAt, validNames, modelId);
    if (outcome.toolCalls) return outcome;

    // v4.3 classifier: text answer that reports missing tools?
    if (!outcome.sawUnavail) return outcome; // normal text answer, no recovery
    let health = await checkBridgeHealth();
    log('info', `Bridge [sid=${sessionId} model=${modelId}] check health=${health.ok ? 'ok' : 'DOWN'} (${health.ms}ms ${health.detail}) tool=pending`);
    if (!health.ok) {
      // Case A: bridge itself unreachable. Do NOT bounce it here: restarting
      // the bridge severs opencode's in-flight MCP connections and the client
      // does not reconnect cleanly (serve restart required). Keep the session,
      // fall back to text, and let the operator recycle serve when convenient.
      log('warn', `Bridge [sid=${sessionId} model=${modelId}] case=A bridge-down, keep session, text fallback`);
      return outcome; // graceful, no session churn
    }
    // Case B: bridge healthy but this session lost MCP attachment.
    // Recycle ONLY the session (fresh handshake); never bounce the bridge
    // unit mid-traffic — that severs all live MCP connections.
    log('warn', `Bridge [sid=${sessionId} model=${modelId}] case=B attach-lost, recovery attempt: recycle session`);
    dropBridgeSession(sKey);
    const retried = await bridgeRecoveryTurn(authKey, modelId, variant, retryMsgs, messages.length, files, systemPrompt, tools);
    if (retried?.toolCalls) {
      log('info', `Bridge [model=${modelId}] recovery retry OK: ${retried.toolCalls.length} call(s)`);
      return retried;
    }
    log('warn', `Bridge [model=${modelId}] recovery failed, text fallback (UI unaffected)`);
    return (retried && retried.textResult) ? retried : outcome;
    } catch (err) {
      dropBridgeSession(sKey); // poisoned session must not be reused
      if (err.message.includes('timed out')) throw err;
      log('warn', `Bridge [model=${modelId}] case=D session-dead turn failed (attempt ${attempt + 1}): ${err.message}`);
      if (attempt < maxRetries - 1) {
        log('warn', `Bridge turn failed (attempt ${attempt + 1}), retrying fresh: ${err.message}`);
        continue;
      }
      throw err;
    }
  }
}

// ─── Message helpers ────────────────────────────────────────────────────────
function parseModel(rawModel) {
  let modelId = rawModel.includes('/') ? rawModel.split('/')[1] : rawModel;
  let variant = '';
  if (modelId.includes(':')) {
    const i = modelId.indexOf(':');
    variant = modelId.slice(i + 1);
    modelId = modelId.slice(0, i);
  }
  if (MODEL_ALIASES[modelId]) {
    log('warn', `Model "${modelId}" is retired, mapping to "${MODEL_ALIASES[modelId]}"`);
    modelId = MODEL_ALIASES[modelId];
  }
  return { modelId, variant };
}

function buildPromptInput(messages) {
  const textParts = [];
  const files = [];
  for (const msg of messages) {
    if (msg.role === 'system') continue;
    const role = msg.role || 'user';
    let text = '';
    if (typeof msg.content === 'string') {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
      for (const p of msg.content) {
        if (p.type === 'image_url' && p.image_url?.url) {
          files.push({ uri: p.image_url.url });
        }
      }
    }
    if (!text && files.length === 0) continue;
    if (text) textParts.push(role === 'assistant' ? `[Assistant]\n${text}` : `[User]\n${text}`);
  }
  return { text: textParts.join('\n\n') || ' ', files };
}

function extractSystemPrompt(messages) {
  return messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .filter(Boolean)
    .join('\n');
}

function formatReasoning(text) {
  if (!text) return '';
  switch (CONFIG.reasoningFormat) {
    case 'hidden': return '';
    case 'details': return `<details>\n<summary>💭 Thinking...</summary>\n\n${text}\n\n</details>\n\n`;
    case 'inline': return text + '\n\n';
    case 'blockquote':
    default:
      return `> 💭 *Thinking...*\n${text.split('\n').map((l) => `> ${l}`).join('\n')}\n\n`;
  }
}

// v2 assistant message: {type:'assistant', content:[{type:'text'|'reasoning',text}], tokens:{...}}
function extractAssistant(messagesData) {
  const assistants = (messagesData || []).filter((m) => m?.type === 'assistant');
  const last = assistants[assistants.length - 1];
  if (!last) return null;
  let textContent = '';
  let reasoningContent = '';
  for (const c of last.content || []) {
    if (c.type === 'text' && c.text) textContent += c.text;
    else if (c.type === 'reasoning' && c.text) reasoningContent += c.text;
  }
  const t = last.tokens || {};
  return {
    textContent,
    reasoningContent,
    responseText: formatReasoning(reasoningContent) + textContent,
    tokenUsage: {
      input: t.input || 0,
      output: t.output || 0,
      reasoning: t.reasoning || 0,
      cacheRead: t.cache?.read || 0,
      cacheWrite: t.cache?.write || 0,
      total: (t.input || 0) + (t.output || 0),
    },
  };
}

// ─── Session + prompt (v2) ──────────────────────────────────────────────────
async function getOrCreateSession(authKey, modelId, variant) {
  const sKey = sessionKey(authKey, modelId, variant);
  const cached = sessions.get(sKey);
  if (cached) return { sessionId: cached, sKey };
  const modelRef = { providerID: 'opencode', id: modelId };
  if (variant) modelRef.variant = variant;
  const created = await sdkPost('/api/session', {
    model: modelRef,
    permissions: [{ action: '*', resource: '*', effect: 'allow' }],
  });
  const sessionId = created?.data?.id;
  if (!sessionId) throw new Error('Failed to create session (empty response)');
  sessions.set(sKey, sessionId);
  log('info', `New session: ${sessionId} for ${modelId}${variant ? ':' + variant : ''}`);
  return { sessionId, sKey };
}

async function ensureModel(sessionId, modelId, variant) {
  const modelRef = { providerID: 'opencode', id: modelId };
  if (variant) modelRef.variant = variant;
  try {
    await sdkPost(`/api/session/${sessionId}/model`, { model: modelRef });
  } catch (e) {
    log('debug', `ensureModel (non-fatal): ${e.message}`);
  }
}

async function sendPrompt(authKey, modelId, variant, promptText, files, systemPrompt) {
  const maxRetries = 2;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const { sessionId, sKey } = await getOrCreateSession(authKey, modelId, variant);
    try {
      await ensureModel(sessionId, modelId, variant);
      const fullText = systemPrompt ? `${systemPrompt}\n\n${promptText}` : promptText;
      const body = { text: fullText };
      if (files.length > 0) body.files = files;
      await sdkPost(`/api/session/${sessionId}/prompt`, body, 30000);
      await waitForIdle(sessionId);
      const listed = await sdkGet(`/api/session/${sessionId}/message?order=asc&limit=100`);
      const result = extractAssistant(listed?.data);
      if (!result || (!result.textContent && !result.reasoningContent)) {
        throw new Error('Model returned no assistant message (check SDK logs / model availability)');
      }
      return result;
    } catch (err) {
      sessions.delete(sKey);
      if (err.message.includes('timed out')) throw err;
      if (attempt < maxRetries - 1) {
        log('warn', `Prompt failed (attempt ${attempt + 1}), retrying with fresh session: ${err.message}`);
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      throw err;
    }
  }
}

// ─── Streaming (fake-chunked, OpenAI SSE shape) ─────────────────────────────
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function writeStreamedResponse(res, responseText, model, tokenUsage) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const chatId = 'chatcmpl-' + Date.now();
  const created = Math.floor(Date.now() / 1000);
  res.write(`data: ${JSON.stringify({
    id: chatId, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
  })}\n\n`);
  const cs = CONFIG.streamChunkSize;
  for (let i = 0; i < responseText.length; i += cs) {
    res.write(`data: ${JSON.stringify({
      id: chatId, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta: { content: responseText.slice(i, i + cs) }, finish_reason: null }],
    })}\n\n`);
    if (CONFIG.streamChunkDelayMs > 0) await sleep(CONFIG.streamChunkDelayMs);
  }
  res.write(`data: ${JSON.stringify({
    id: chatId, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: tokenUsage.input, completion_tokens: tokenUsage.output, total_tokens: tokenUsage.input + tokenUsage.output },
  })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function buildToolCallsResponse(toolCalls, model) {
  return {
    id: 'chatcmpl-' + Date.now(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    provider: 'opencode',
    system_fingerprint: null,
    choices: [{
      index: 0, logprobs: null, finish_reason: 'tool_calls',
      message: { role: 'assistant', content: null, refusal: null, tool_calls: toolCalls },
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost: 0, is_byok: false },
  };
}

async function writeStreamedToolCalls(res, toolCalls, model) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const chatId = 'chatcmpl-' + Date.now();
  const created = Math.floor(Date.now() / 1000);
  res.write(`data: ${JSON.stringify({
    id: chatId, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }],
  })}\n\n`);
  res.write(`data: ${JSON.stringify({
    id: chatId, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null }],
  })}\n\n`);
  res.write(`data: ${JSON.stringify({
    id: chatId, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
  })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function buildCompletionResponse(responseText, model, tokenUsage, contextWindow) {
  return {
    id: 'chatcmpl-' + Date.now(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    provider: 'opencode',
    system_fingerprint: null,
    choices: [{
      index: 0, logprobs: null, finish_reason: 'stop',
      message: { role: 'assistant', content: responseText, refusal: null, reasoning: null },
    }],
    usage: {
      prompt_tokens: tokenUsage.input,
      completion_tokens: tokenUsage.output,
      total_tokens: tokenUsage.input + tokenUsage.output,
      cost: 0, is_byok: false,
      prompt_tokens_details: { cached_tokens: tokenUsage.cacheRead, cache_write_tokens: tokenUsage.cacheWrite, audio_tokens: 0, video_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: tokenUsage.reasoning, image_tokens: 0, audio_tokens: 0 },
    },
    context: { used: tokenUsage.total, available: contextWindow },
  };
}

// ─── HTTP Server ────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = (req.url || '/').split('?')[0].replace(/\/$/, '') || '/';

  if (url === '/health' && req.method === 'GET') {
    let sdkStatus = 'unreachable';
    try {
      const r = await fetch(`${CONFIG.sdkUrl}/api/model`, { headers: { Authorization: SDK_AUTH } });
      if (r.ok) sdkStatus = 'reachable';
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok', version: '4.3', proxy: 'running',
      sdk: sdkStatus, uptime: process.uptime(), sessions: sessions.size,
      autoApprove: CONFIG.autoApprovePermissions,
      reasoningFormat: CONFIG.reasoningFormat,
    }));
    return;
  }

  if ((url === '/v1/models' || url === '/models') && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(MODELS_RESPONSE_JSON);
    return;
  }

  if ((url === '/v1/chat/completions' || url === '/chat/completions') && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      try {
        let data;
        try { data = JSON.parse(body); } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid JSON', type: 'invalid_request_error' } }));
          return;
        }
        const messages = data.messages;
        if (!Array.isArray(messages) || messages.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: '"messages" must be a non-empty array', type: 'invalid_request_error' } }));
          return;
        }
        const rawModel = data.model || 'big-pickle';
        const { modelId, variant } = parseModel(rawModel);
        const catalogEntry = MODEL_LOOKUP.get(modelId);
        if (!catalogEntry) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: {
              message: `Unknown model "${rawModel}". Available: ${MODEL_CATALOG.map((m) => 'opencode/' + m.id).join(', ')}`,
              type: 'invalid_request_error',
            },
          }));
          return;
        }
        const isStreaming = data.stream === true;
        const userSystem = extractSystemPrompt(messages);
        const fullSystem = [CONFIG.systemPromptInjection, userSystem].filter(Boolean).join('\n\n');
        const { text, files } = buildPromptInput(messages);
        const tools = Array.isArray(data.tools) ? data.tools.filter((t) => t?.type === 'function') : [];
        const toolChoice = data.tool_choice;
        const toolChoiceNone = toolChoice === 'none' || toolChoice?.type === 'none' || toolChoice?.function === 'none';
        const useBridge = CONFIG.bridgeEnabled && tools.length > 0 && !toolChoiceNone;
        log('info', `Request: model=${modelId}${variant ? ':' + variant : ''}, msgs=${messages.length}, stream=${isStreaming}, files=${files.length}, tools=${tools.length}, bridge=${useBridge}`);
        const authKey = req.headers.authorization || 'default';

        if (useBridge) {
          const result = await sendPromptWithTools(authKey, modelId, variant, messages, files, fullSystem, tools);
          if (result.toolCalls) {
            log('info', `Bridge: ${result.toolCalls.length} tool call(s): ${result.toolCalls.map((t) => t.function.name).join(', ')}`);
            if (isStreaming) {
              await writeStreamedToolCalls(res, result.toolCalls, rawModel);
            } else {
              res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
              res.end(JSON.stringify(buildToolCallsResponse(result.toolCalls, rawModel)));
            }
            return;
          }
          // Fallback to text below.
          const tr = result.textResult;
          const finalText = (tr?.responseText) || '[No response from model]';
          log('info', `Bridge fallback to text: ${finalText.length}c`);
          if (isStreaming) {
            await writeStreamedResponse(res, finalText, rawModel, tr?.tokenUsage || { input: 0, output: 0 });
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
            res.end(JSON.stringify(buildCompletionResponse(finalText, rawModel, tr?.tokenUsage || { input: 0, output: 0 }, catalogEntry.contextWindow)));
          }
          return;
        }

        const { responseText, reasoningContent, tokenUsage } = await sendPrompt(authKey, modelId, variant, text, files, fullSystem);
        const finalText = responseText || '[No response from model]';
        log('info', `Response: ${finalText.length}c (reasoning: ${reasoningContent.length}c), tokens: in=${tokenUsage.input} out=${tokenUsage.output}`);
        if (isStreaming) {
          await writeStreamedResponse(res, finalText, rawModel, tokenUsage);
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
          res.end(JSON.stringify(buildCompletionResponse(finalText, rawModel, tokenUsage, catalogEntry.contextWindow)));
        }
      } catch (err) {
        log('error', `Error: ${err.message}`);
        if (!res.headersSent) {
          const code = err.message.includes('timed out') ? 504 : 500;
          res.writeHead(code, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: err.message, type: code === 504 ? 'timeout' : 'internal_error' } }));
        }
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Not found' } }));
});

// ─── Start ──────────────────────────────────────────────────────────────────
server.listen(CONFIG.port, CONFIG.bindHost, () => {
  log('info', `Proxy v4.3 running on http://${CONFIG.bindHost}:${CONFIG.port}`);
  log('info', `SDK: ${CONFIG.sdkUrl} | Timeout: ${CONFIG.requestTimeoutMs}ms`);
  log('info', `Auto-approve: ${CONFIG.autoApprovePermissions} | Reasoning: ${CONFIG.reasoningFormat}`);
});

function shutdown(sig) {
  log('info', `${sig} received, shutting down...`);
  server.close(() => { log('info', 'Closed'); process.exit(0); });
  setTimeout(() => process.exit(1), 5000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
