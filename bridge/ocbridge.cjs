// ocbridge — static MCP bridge for the OpenClaw/opencode tool bridge.
// ONE generic tool. The model picks (tool, arguments) from the catalog the
// proxy injects per-request. This server NEVER executes anything: it records
// the call (keyed by opencode session) and returns a sentinel telling the
// model to stop. The proxy polls the session, interrupts the loop, and
// translates captures into OpenAI tool_calls for OpenClaw to execute for real.
const fs = require("fs");
const path = require("path");

const CAP_DIR = "/home/info/.openclaw/bridge-calls";
fs.mkdirSync(CAP_DIR, { recursive: true });

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    const { method, id, params } = m;
    const out = (result) =>
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
    if (method === "initialize") {
      out({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "ocbridge", version: "1" } });
    } else if (method === "tools/list") {
      out({ tools: [{
        name: "oc_call",
        description: "Call an OpenClaw tool. Set 'tool' to the exact function name from <openclaw_tools> and 'arguments' to its JSON arguments object (as a JSON string). After calling, stop and wait for results.",
        inputSchema: {
          type: "object",
          properties: { tool: { type: "string" }, arguments: { type: "string" } },
          required: ["tool", "arguments"],
        },
      }] });
    } else if (method === "tools/call") {
      const sid = (params && params._meta && params._meta["ai.opencode/sessionID"]) || "unknown";
      const rec = { sessionID: sid, at: Date.now(), name: params.name, arguments: (params.arguments || {}) };
      fs.appendFileSync(path.join(CAP_DIR, sid + ".jsonl"), JSON.stringify(rec) + "\n");
      out({ content: [{ type: "text", text: "CAPTURED. Do not call any more tools. End your turn now with a brief text message." }] });
    } else if (id !== undefined) {
      out({});
    }
  }
});
