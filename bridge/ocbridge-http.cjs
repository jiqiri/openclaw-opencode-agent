// ocbridge-http — remote (Streamable HTTP) variant of the ocbridge MCP server.
// Same contract as ocbridge.cjs (ONE tool: oc_call, capture-only), but served
// over HTTP so there is no persistent child process for opencode to lose.
// Supervised via systemd (ocbridge-mcp.service). Captures go to BRIDGE_DIR.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.BRIDGE_PORT || '8899', 10);
const CAP_DIR = process.env.BRIDGE_DIR || (process.env.HOME + '/.openclaw/bridge-calls');
fs.mkdirSync(CAP_DIR, { recursive: true });

const server = http.createServer((req, res) => {
  console.log(`HIT ${req.method} ${req.url} sid=${req.headers['mcp-session-id'] || '-'}`);
  if (req.method === 'GET') {
    // Minimal SSE stream (opencode may open it; keep alive, no events).
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write(': open\n\n');
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
    req.on('close', () => clearInterval(ping));
    return;
  }
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let msg;
    try { msg = JSON.parse(body || 'null'); } catch { res.writeHead(400); res.end(); return; }
    const msgs = Array.isArray(msg) ? msg : [msg];
    const outs = [];
    for (const m of msgs) {
      if (!m || m.jsonrpc !== '2.0') continue;
      const { method, id, params } = m;
      const out = (result) => outs.push({ jsonrpc: '2.0', id, result });
      if (method === 'initialize') {
        out({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'ocbridge', version: '2' } });
      } else if (method === 'tools/list') {
        out({ tools: [{
          name: 'oc_call',
          description: "Call an OpenClaw tool. Set 'tool' to the exact function name from <openclaw_tools> and 'arguments' to its JSON arguments object (as a JSON string). After calling, stop and wait for results.",
          inputSchema: { type: 'object', properties: { tool: { type: 'string' }, arguments: { type: 'string' } }, required: ['tool', 'arguments'] },
        }] });
      } else if (method === 'tools/call') {
        const sid = (params && params._meta && params._meta['ai.opencode/sessionID']) || 'unknown';
        fs.appendFileSync(path.join(CAP_DIR, sid + '.jsonl'),
          JSON.stringify({ sessionID: sid, at: Date.now(), name: params.name, arguments: params.arguments || {} }) + '\n');
        out({ content: [{ type: 'text', text: 'CAPTURED. Do not call any more tools. End your turn now with a brief text message.' }] });
      } else if (id !== undefined) {
        out({});
      }
    }
    const payload = (Array.isArray(msg) ? outs : outs[0]) || {};
    const text = JSON.stringify(payload);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(text),
      'Mcp-Session-Id': req.headers['mcp-session-id'] || 'ocbridge-sid-1',
    });
    res.end(text);
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`ocbridge-http on 127.0.0.1:${PORT}`));
