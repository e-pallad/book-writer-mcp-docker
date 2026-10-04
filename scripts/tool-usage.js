#!/usr/bin/env node
// Ranks the tools in a tool-usage.jsonl (see src/usage.ts) so the most used can
// be pinned: BOOK_MCP_PINNED=<the top of this list>.
//
//   node scripts/tool-usage.js [path/to/tool-usage.jsonl] [--top N]
//
// Default path: $BOOK_PROJECT_DIR (or ./data)/.book-mcp/tool-usage.jsonl

const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const topAt = args.indexOf("--top");
const top = topAt >= 0 ? Number(args.splice(topAt, 2)[1]) || 10 : 10;
const file =
  args[0] ||
  path.join(process.env.BOOK_PROJECT_DIR || "data", ".book-mcp", "tool-usage.jsonl");

if (!fs.existsSync(file)) {
  console.error(`No usage log at ${file}. Run the server for a while first.`);
  process.exit(1);
}

const stats = new Map();
let first, last, total = 0;
for (const line of fs.readFileSync(file, "utf8").split("\n")) {
  if (!line.trim()) continue;
  let e;
  try { e = JSON.parse(line); } catch { continue; }
  total++;
  first ??= e.ts;
  last = e.ts;
  const s = stats.get(e.tool) ?? { n: 0, gateway: 0, failed: 0, ms: 0 };
  s.n++;
  if (e.via === "gateway") s.gateway++;
  if (!e.ok) s.failed++;
  s.ms += e.ms || 0;
  stats.set(e.tool, s);
}

const rows = [...stats].sort((a, b) => b[1].n - a[1].n);
console.log(`${total} calls, ${rows.length} distinct tools, ${first?.slice(0, 10)} to ${last?.slice(0, 10)}\n`);
console.log("calls  share  via-gateway  failed  avg-ms  tool");
for (const [tool, s] of rows) {
  console.log(
    `${String(s.n).padStart(5)}  ${((100 * s.n) / total).toFixed(0).padStart(4)}%  ${String(s.gateway).padStart(11)}  ${String(s.failed).padStart(6)}  ${String(Math.round(s.ms / s.n)).padStart(6)}  ${tool}`
  );
}
console.log(`\nSuggested pin set:\nBOOK_MCP_PINNED=${rows.filter(([t]) => t !== "book_tools").slice(0, top).map(([t]) => t).join(",")}`);
