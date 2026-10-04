const test = require("node:test");
const assert = require("node:assert/strict");

const { createServer } = require("../dist-tsc/server");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
const { useTempProject, cleanup } = require("./helpers/project");

async function connect(options) {
  const server = createServer(options);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const text = async (name, args) => (await client.callTool({ name, arguments: args })).content[0].text;
  return { client, text };
}

test("gateway mode advertises a small fraction of the tools", async () => {
  const full = await connect({ mode: "full" });
  const gw = await connect({ mode: "gateway" });
  const fullTools = (await full.client.listTools()).tools;
  const gwTools = (await gw.client.listTools()).tools;

  assert.ok(fullTools.length > 100);
  assert.ok(gwTools.some((t) => t.name === "book_tools"));
  assert.ok(gwTools.some((t) => t.name === "book_call"));
  assert.ok(gwTools.length < 15);
  assert.ok(JSON.stringify(gwTools).length < JSON.stringify(fullTools).length / 8);
});

test("every tool is still reachable through the gateway", async (t) => {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const full = await connect({ mode: "full" });
  const gw = await connect({ mode: "gateway" });
  const names = (await full.client.listTools()).tools.map((x) => x.name);

  const listing = await gw.text("book_tools", {});
  for (const name of names) assert.ok(listing.includes(name), `${name} missing from book_tools`);

  const sig = await gw.text("book_tools", { describe: ["book_character_add"] });
  assert.match(sig, /role: "protagonist"\|/);

  await gw.text("book_call", { tool: "book_init", args: { title: "T", author: "A", genre: "Fiction" } });
  const added = await gw.text("book_call", {
    tool: "book_character_add",
    args: { name: "Mara", role: "protagonist", description: "A lighthouse keeper", brief: true },
  });
  assert.match(added, /Mara|char/i);
});

test("book_call reports bad arguments with the signature, and unknown tools", async () => {
  const gw = await connect({ mode: "gateway" });
  const bad = await gw.client.callTool({ name: "book_call", arguments: { tool: "book_character_add", args: {} } });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /name: Required/);
  assert.match(bad.content[0].text, /role: "protagonist"/);

  const unknown = await gw.client.callTool({ name: "book_call", arguments: { tool: "nope" } });
  assert.equal(unknown.isError, true);
});

test("pinned tools can be overridden", async () => {
  const gw = await connect({ mode: "gateway", pinned: ["book_stats"] });
  const names = (await gw.client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["book_call", "book_stats", "book_tools"]);
});
