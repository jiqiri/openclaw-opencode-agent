// v4.3 bridge regression: OpenClaw-style multi-tool chain through the proxy.
// Asserts: tool_calls per tool turn, results incorporated, session reuse
// (one bridge session), catalog injected once, recovery flow on simulated
// unavailability, graceful fallback on bridge-down, HTTP 200 always.
// Usage: node test-bridge-v43.mjs [--base http://127.0.0.1:5200]
// Requires: proxy + serve + ocbridge-mcp running; journalctl access.
import { execSync } from 'child_process';

const BASE = (process.argv.find((a) => a.startsWith('--base=')) || '').split('=')[1] || 'http://127.0.0.1:5200';
const T0 = Date.now();
const seenLines = new Set(journalTail(2000).split('\n'));
let pass = 0, fail = 0;
const results = [];
function ok(name, cond, extra = '') {
  (cond ? pass++ : fail++);
  results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
}
function journalTail(n) {
  try {
    return execSync(`journalctl --user -u opencode-proxy --no-pager -q 2>/dev/null | tail -n ${n}`, { encoding: 'utf8' });
  } catch { return ''; }
}
function jnew() {
  return journalTail(600).split('\n').filter((l) => l && !seenLines.has(l)).join('\n');
}
async function chat(body, timeoutMs = 200000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: c.signal,
    });
    const j = await r.json();
    return { status: r.status, json: j };
  } finally { clearTimeout(t); }
}
const fn = (name, desc = 'test fn') => ({ type: 'function', function: { name, description: desc, parameters: { type: 'object', properties: {} } } });
const callsOf = (r) => r.json?.choices?.[0]?.message?.tool_calls || [];
const finishOf = (r) => r.json?.choices?.[0]?.finish_reason;
const textOf = (r) => r.json?.choices?.[0]?.message?.content || '';

// ── Test 1: A -> result A -> B(result A) -> final text ──
const u1 = { role: 'user', content: 'Call fn_chain_a with {"x": 1} now, then stop.' };
let r = await chat({ model: 'opencode/big-pickle', messages: [u1], stream: false, tools: [fn('fn_chain_a')] });
const tcA = callsOf(r)[0];
ok('T1 status 200', r.status === 200, `got ${r.status}`);
ok('T1 tool_calls fn_chain_a', finishOf(r) === 'tool_calls' && tcA?.function?.name === 'fn_chain_a', finishOf(r));

const m2 = [u1,
  { role: 'assistant', content: null, tool_calls: [{ id: tcA?.id || 'call_x', type: 'function', function: { name: 'fn_chain_a', arguments: '{"x": 1}' } }] },
  { role: 'tool', tool_call_id: tcA?.id || 'call_x', name: 'fn_chain_a', content: 'A-RESULT-7' },
  { role: 'user', content: 'Now call fn_chain_b passing the previous result value.' }];
r = await chat({ model: 'opencode/big-pickle', messages: m2, stream: false, tools: [fn('fn_chain_a'), fn('fn_chain_b')] });
const tcB = callsOf(r)[0];
ok('T2 status 200', r.status === 200);
ok('T2 tool_calls fn_chain_b (no repeat of A)', finishOf(r) === 'tool_calls' && tcB?.function?.name === 'fn_chain_b', `${finishOf(r)} ${tcB?.function?.name}`);

const m3 = [...m2,
  { role: 'assistant', content: null, tool_calls: [{ id: tcB?.id || 'call_y', type: 'function', function: { name: 'fn_chain_b', arguments: tcB?.function?.arguments || '{}' } }] },
  { role: 'tool', tool_call_id: tcB?.id || 'call_y', name: 'fn_chain_b', content: 'B-RESULT-9' },
  { role: 'user', content: 'Summarize: reply with exactly FINAL-MARKER-3 plus the B result value.' }];
r = await chat({ model: 'opencode/big-pickle', messages: m3, stream: false, tools: [fn('fn_chain_a'), fn('fn_chain_b')] });
ok('T3 status 200', r.status === 200);
ok('T3 final text keeps B result', finishOf(r) === 'stop' && textOf(r).includes('B-RESULT-9'), `${finishOf(r)} ${textOf(r).slice(-60)}`);

const jl = jnew();
const newSessions = (jl.match(/New bridge session/g) || []).length;
const catalogs = (jl.match(/catalog=injected/g) || []).length;
ok('session reused across turns (1 bridge session)', newSessions === 1, `New bridge session x${newSessions}`);
ok('catalog injected once', catalogs === 1, `catalog=injected x${catalogs}`);

// ── Test 2: forced-B recovery (model emits unavailability text) ──
r = await chat({ model: 'opencode/big-pickle', messages: [{ role: 'user', content: 'Reply with exactly: the tool is not available right now' }], stream: false, tools: [fn('fn_forced_b')] });
const jl2 = jnew().split('\n').filter((l) => l.includes('case=B') || l.includes('recovery') || l.includes('recycle') || l.includes('reattach') || l.includes('bounce'));
ok('T4 status 200 (no hard fail)', r.status === 200, `got ${r.status}`);
ok('T4 recovery path exercised (case=B + recycle + retry)', jl2.some((l) => l.includes('case=B')) && jl2.some((l) => l.includes('reattach OK')), jl2.slice(-4).join(' | ') || 'no recovery lines');

// ── Test 3: bridge-down => case A graceful fallback ──
try { execSync('systemctl --user stop ocbridge-mcp', { stdio: 'ignore' }); } catch {}
await new Promise((x) => setTimeout(x, 2000));
r = await chat({ model: 'opencode/big-pickle', messages: [{ role: 'user', content: 'Reply with exactly: the tool is not available right now' }], stream: false, tools: [fn('fn_down')] });
const jl3 = journalTail(400);
ok('T5 status 200 while bridge down', r.status === 200);
ok('T5 case=A logged, no crash', jl3.includes('case=A'), 'check journal');
try { execSync('systemctl --user start ocbridge-mcp', { stdio: 'ignore' }); } catch {}
await new Promise((x) => setTimeout(x, 3000));

// ── Test 4: long chain img -> article -> publish -> text ──
const img = { role: 'user', content: 'Call fn_img with {"topic": "seo"} now, then stop.' };
r = await chat({ model: 'opencode/big-pickle', messages: [img], stream: false, tools: [fn('fn_img'), fn('fn_article'), fn('fn_publish')] });
const tImg = callsOf(r)[0];
ok('T6 img tool_calls', finishOf(r) === 'tool_calls' && tImg?.function?.name === 'fn_img', finishOf(r));
const art = [...[img,
  { role: 'assistant', content: null, tool_calls: [{ id: tImg?.id || 'c1', type: 'function', function: { name: 'fn_img', arguments: '{"topic":"seo"}' } }] },
  { role: 'tool', tool_call_id: tImg?.id || 'c1', name: 'fn_img', content: 'IMG-URL-1' },
  { role: 'user', content: 'Now call fn_article with the image url.' }]];
r = await chat({ model: 'opencode/big-pickle', messages: art, stream: false, tools: [fn('fn_img'), fn('fn_article'), fn('fn_publish')] });
const tArt = callsOf(r)[0];
ok('T7 article tool_calls (uses IMG result, no repeat)', finishOf(r) === 'tool_calls' && tArt?.function?.name === 'fn_article', `${finishOf(r)} ${tArt?.function?.name}`);
const pub = [...art,
  { role: 'assistant', content: null, tool_calls: [{ id: tArt?.id || 'c2', type: 'function', function: { name: 'fn_article', arguments: tArt?.function?.arguments || '{}' } }] },
  { role: 'tool', tool_call_id: tArt?.id || 'c2', name: 'fn_article', content: 'ARTICLE-300' },
  { role: 'user', content: 'Now call fn_publish with the article.' }];
r = await chat({ model: 'opencode/big-pickle', messages: pub, stream: false, tools: [fn('fn_img'), fn('fn_article'), fn('fn_publish')] });
const tPub = callsOf(r)[0];
ok('T8 publish tool_calls', finishOf(r) === 'tool_calls' && tPub?.function?.name === 'fn_publish', `${finishOf(r)} ${tPub?.function?.name}`);
const fin = [...pub,
  { role: 'assistant', content: null, tool_calls: [{ id: tPub?.id || 'c3', type: 'function', function: { name: 'fn_publish', arguments: tPub?.function?.arguments || '{}' } }] },
  { role: 'tool', tool_call_id: tPub?.id || 'c3', name: 'fn_publish', content: 'PUBLISHED-OK-5' },
  { role: 'user', content: 'Reply with exactly CHAIN-DONE plus the publish result.' }];
r = await chat({ model: 'opencode/big-pickle', messages: fin, stream: false, tools: [fn('fn_img'), fn('fn_article'), fn('fn_publish')] });
ok('T9 final text keeps publish result', finishOf(r) === 'stop' && textOf(r).includes('PUBLISHED-OK-5'), `${finishOf(r)} ${textOf(r).slice(-60)}`);

console.log(`\nv4.3 bridge regression: ${pass} passed, ${fail} failed`);
for (const l of results) console.log(' ' + l);
process.exit(fail ? 1 : 0);
