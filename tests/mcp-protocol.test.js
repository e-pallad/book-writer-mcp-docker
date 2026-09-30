const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { collectTools } = require("./helpers/tools");

// Every other test calls the handlers directly. This one goes through the
// real server and the SDK's own client, over stdio, so the registration with
// the SDK — the one place the tool modules touch it — is covered too.

const TOOLS_DIR = path.join(__dirname, "..", "dist-tsc", "tools");

function registeredNames() {
  const registers = fs
    .readdirSync(TOOLS_DIR)
    .filter((f) => f.endsWith(".js"))
    .flatMap((f) =>
      Object.entries(require(path.join(TOOLS_DIR, f)))
        .filter(([name, fn]) => /^register\w+Tools$/.test(name) && typeof fn === "function")
        .map(([, fn]) => fn)
    );
  return Object.keys(collectTools(...registers)).sort();
}

async function connect(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "book-mcp-protocol-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, "..", "dist", "index.js")],
    env: { ...process.env, BOOK_PROJECT_DIR: dir },
    stderr: "pipe",
  });
  const client = new Client({ name: "protocol-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return client;
}

const json = (result) => JSON.parse(result.content[0].text);

test("the server lists every registered tool, with its input schema", async (t) => {
  const client = await connect(t);
  const { tools } = await client.listTools();

  assert.deepEqual(tools.map((tool) => tool.name).sort(), registeredNames());

  const list = tools.find((tool) => tool.name === "book_chapter_list");
  assert.match(list.description, /page through it/);
  assert.equal(list.inputSchema.type, "object");
  assert.deepEqual(Object.keys(list.inputSchema.properties).sort(), ["act", "fromChapter", "limit"]);

  const stats = tools.find((tool) => tool.name === "book_stats");
  assert.equal(stats.inputSchema.type, "object");
  assert.deepEqual(stats.inputSchema.properties ?? {}, {});
});

test("tools are called through the protocol with their defaults applied", async (t) => {
  const client = await connect(t);

  await client.callTool({
    name: "book_init",
    arguments: { title: "Testbuch", author: "A", genre: "Krimi", language: "de" },
  });
  const created = await client.callTool({
    name: "book_chapter_create",
    arguments: { title: "Die Kaimauer", synopsis: "s", content: "# Die Kaimauer\n\nMara ging.", brief: true },
  });
  assert.deepEqual(json(created), { id: "ch-001", status: "draft", wordCount: 4 });

  // dryRun defaults to false, so this writes.
  const appended = await client.callTool({
    name: "book_chapter_append",
    arguments: { chapterId: "#1", content: "Kell blieb.", brief: true },
  });
  assert.deepEqual(json(appended), { id: "ch-001", status: "draft", wordCount: 6, firstNewParagraph: 3 });

  const page = json(await client.callTool({ name: "book_chapter_list", arguments: { limit: 1 } }));
  assert.deepEqual(page.page, { total: 1, returned: 1 });
});

test("invalid arguments and refused calls come back as errors", async (t) => {
  const client = await connect(t);
  await client.callTool({
    name: "book_init",
    arguments: { title: "Testbuch", author: "A", genre: "Krimi", language: "de" },
  });

  const invalid = await client.callTool({ name: "book_chapter_reorder", arguments: { chapterId: "#1", newOrder: "x" } });
  assert.equal(invalid.isError, true);

  const refused = await client.callTool({ name: "book_chapter_read", arguments: { chapterId: "#3" } });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /no chapter #3/);
});
