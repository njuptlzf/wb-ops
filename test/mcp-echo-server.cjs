// Minimal stdio MCP server for wb-ops fallback-matcher validation.
// Exposes one tool `big_output` returning >8KB of text.
const readline = require("readline");

const LINES = 600;
let bigText = "";
for (let i = 0; i < LINES; i++) bigText += "mcp-line " + i + " " + "x".repeat(20) + (i % 97 === 0 ? " ERROR spike" : "") + "\n";

const tools = [
  {
    name: "big_output",
    description: "Returns a large text payload for compression testing",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    send(msg.id, {
      protocolVersion: (msg.params && msg.params.protocolVersion) || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "wbops-bigout-test", version: "1.0.0" },
    });
  } else if (msg.method === "tools/list") {
    send(msg.id, { tools });
  } else if (msg.method === "tools/call") {
    send(msg.id, {
      content: [{ type: "text", text: bigText }],
      isError: false,
    });
  } else if (msg.id !== undefined) {
    send(msg.id, {});
  }
});

function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
