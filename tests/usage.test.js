const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { createServer } = require("../dist-tsc/server");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
const { useTempProject, cleanup } = require("./helpers/project");

async function connect(options) {
  const server = createServer(options);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return (name, args) => client.callTool({ name, arguments: args });
}

const readLog = (dir) =>
  fs
    .readFileSync(path.join(dir, ".book-mcp", "tool-usage.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

test("each call is logged with tool, route and outcome — and nothing else", async (t) => {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const call = await connect({ mode: "gateway", pinned: ["book_stats"] });

  await call("book_call", { tool: "book_init", args: { title: "Secret Title", author: "A", genre: "Fiction" } });
  await call("book_stats", {});
  await call("book_call", { tool: "book_character_add", args: {} }); // fails validation

  const log = readLog(dir);
  assert.deepEqual(
    log.map((e) => [e.tool, e.via]),
    [["book_init", "gateway"], ["book_stats", "listed"]]
  );
  assert.ok(log.every((e) => e.ok === true && typeof e.ms === "number" && e.ts));
  assert.ok(!JSON.stringify(log).includes("Secret Title"));
});

test("BOOK_MCP_USAGE_LOG=0 turns it off", async (t) => {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  process.env.BOOK_MCP_USAGE_LOG = "0";
  t.after(() => delete process.env.BOOK_MCP_USAGE_LOG);
  const call = await connect({ mode: "full" });
  await call("book_stats", {});
  assert.equal(fs.existsSync(path.join(dir, ".book-mcp", "tool-usage.jsonl")), false);
});

test("scripts/tool-usage.js ranks tools and suggests a pin set", (t) => {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const file = path.join(dir, "u.jsonl");
  const line = (tool, via = "listed") => JSON.stringify({ ts: "2026-10-04T00:00:00Z", tool, via, ok: true, ms: 5 });
  fs.writeFileSync(file, [line("a"), line("b", "gateway"), line("b", "gateway"), line("book_tools")].join("\n") + "\n");
  const out = execFileSync("node", [path.join(__dirname, "..", "scripts", "tool-usage.js"), file]).toString();
  assert.match(out, /4 calls, 3 distinct tools/);
  assert.match(out, /BOOK_MCP_PINNED=b,a\n/);
});
