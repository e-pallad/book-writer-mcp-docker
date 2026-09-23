const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { collectTools, callJson } = require("./helpers/tools");
const { useTempProject, cleanup } = require("./helpers/project");

function tools() {
  const m = (n) => require(`../dist-tsc/tools/${n}`);
  return collectTools(
    m("manuscript").registerManuscriptTools,
    m("history").registerHistoryTools
  );
}

async function newProject(t) {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const api = tools();
  await callJson(api, "book_init", {
    title: "Diff Book",
    author: "A. Writer",
    genre: "fiction",
  });
  return { dir, api };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

const V1 = `# The Arrival

She stepped off the train into rain.
The platform was empty.
A porter waved her through.
`;

const V2 = `# The Arrival

She stepped off the train into rain.
The platform was deserted.
A porter waved her through.
Somewhere a bell rang.
`;

test("diffs the current content against the most recent snapshot by default", async (t) => {
  const { api } = await newProject(t);
  const { chapterId } = await callJson(api, "book_chapter_create", {
    title: "The Arrival",
    synopsis: "s",
    content: V1,
  });
  await callJson(api, "book_chapter_update", { chapterId, content: V2 });

  const result = await callJson(api, "book_chapter_diff", { chapterId });

  assert.equal(result.unchanged, false);
  assert.equal(result.linesAdded, 2);
  assert.equal(result.linesRemoved, 1);
  assert.match(result.diff, /^--- .*ch-001.*@ /m);
  assert.match(result.diff, /^\+\+\+ .*\(current\)$/m);
  assert.match(result.diff, /^-The platform was empty\.$/m);
  assert.match(result.diff, /^\+The platform was deserted\.$/m);
  assert.match(result.diff, /^\+Somewhere a bell rang\.$/m);
  assert.match(result.diff, /^@@ /m);
});

test("diffs against a named snapshot", async (t) => {
  const { api } = await newProject(t);
  const { chapterId } = await callJson(api, "book_chapter_create", {
    title: "Three Drafts",
    synopsis: "s",
    content: "# Three Drafts\n\nfirst\n",
  });
  await callJson(api, "book_chapter_update", {
    chapterId,
    content: "# Three Drafts\n\nsecond\n",
  });
  await tick();
  await callJson(api, "book_chapter_update", {
    chapterId,
    content: "# Three Drafts\n\nthird\n",
  });
  await tick();

  const history = await callJson(api, "book_chapter_history_list", { chapterId });
  const oldest = history.snapshots[history.snapshots.length - 1].timestamp;

  const againstOldest = await callJson(api, "book_chapter_diff", {
    chapterId,
    timestamp: oldest,
  });
  assert.match(againstOldest.diff, /^-first$/m);
  assert.match(againstOldest.diff, /^\+third$/m);
  assert.equal(againstOldest.from.timestamp, oldest);

  // The default picks the newest, which is a different comparison.
  const againstNewest = await callJson(api, "book_chapter_diff", { chapterId });
  assert.match(againstNewest.diff, /^-second$/m);
  assert.notEqual(againstNewest.from.timestamp, oldest);
});

test("the context option widens and narrows the hunks", async (t) => {
  const { api } = await newProject(t);
  const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
  const changed = long.replace("line 10", "line 10 rewritten");

  const { chapterId } = await callJson(api, "book_chapter_create", {
    title: "Long",
    synopsis: "s",
    content: long,
  });
  await callJson(api, "book_chapter_update", { chapterId, content: changed });

  const narrow = await callJson(api, "book_chapter_diff", { chapterId, context: 1 });
  const wide = await callJson(api, "book_chapter_diff", { chapterId, context: 5 });

  const count = (d) => d.split("\n").filter((l) => l.startsWith(" ")).length;
  assert.equal(count(narrow.diff), 2, "context 1 keeps one line either side");
  assert.equal(count(wide.diff), 10, "context 5 keeps five either side");
});

test("an unchanged chapter reports no differences", async (t) => {
  const { api } = await newProject(t);
  const { chapterId } = await callJson(api, "book_chapter_create", {
    title: "Static",
    synopsis: "s",
    content: "# Static\n\nbody\n",
  });
  await callJson(api, "book_chapter_update", { chapterId, content: "# Static\n\nchanged\n" });

  const history = await callJson(api, "book_chapter_history_list", { chapterId });
  const restored = history.snapshots[0].timestamp;
  await callJson(api, "book_chapter_revert", { chapterId, timestamp: restored });

  // Compare against the snapshot that was restored, which the chapter now
  // matches exactly. (The *newest* snapshot is the one the revert created,
  // holding the text it replaced, so that one legitimately differs.)
  const result = await callJson(api, "book_chapter_diff", {
    chapterId,
    timestamp: restored,
  });
  assert.equal(result.unchanged, true);
  assert.equal(result.linesAdded, 0);
  assert.equal(result.linesRemoved, 0);
  assert.match(result.diff, /No differences/);
});

test("a chapter with no history says so rather than failing", async (t) => {
  const { api } = await newProject(t);
  const { chapterId } = await callJson(api, "book_chapter_create", {
    title: "Fresh",
    synopsis: "s",
    content: "# Fresh\n\nbody\n",
  });

  const result = await callJson(api, "book_chapter_diff", { chapterId });
  assert.equal(result.diff, "");
  assert.match(result.message, /no saved versions yet/i);
});

test("an unknown snapshot is rejected with the available ones listed", async (t) => {
  const { api } = await newProject(t);
  const { chapterId } = await callJson(api, "book_chapter_create", {
    title: "Solo",
    synopsis: "s",
    content: "# Solo\n\none\n",
  });
  await callJson(api, "book_chapter_update", { chapterId, content: "# Solo\n\ntwo\n" });

  await assert.rejects(
    () => callJson(api, "book_chapter_diff", { chapterId, timestamp: "nope" }),
    /No snapshot "nope"/
  );
});

test("the chapter can be named by title, like every other chapter tool", async (t) => {
  const { api } = await newProject(t);
  const { chapterId } = await callJson(api, "book_chapter_create", {
    title: "By Title",
    synopsis: "s",
    content: "# By Title\n\none\n",
  });
  await callJson(api, "book_chapter_update", { chapterId, content: "# By Title\n\ntwo\n" });

  const result = await callJson(api, "book_chapter_diff", { chapterId: "By Title" });
  assert.equal(result.chapterId, chapterId);
  assert.match(result.diff, /^\+two$/m);
});

test("the emitted diff is a real patch that reproduces the current chapter", async (t) => {
  const { api } = await newProject(t);
  const { chapterId } = await callJson(api, "book_chapter_create", {
    title: "Patchable",
    synopsis: "s",
    content: V1,
  });
  await callJson(api, "book_chapter_update", { chapterId, content: V2 });

  const result = await callJson(api, "book_chapter_diff", { chapterId });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "book-mcp-patch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Rebuild V2 from V1 by applying what the tool produced.
  const target = path.join(dir, "chapter.md");
  fs.writeFileSync(target, V1);
  // Re-label the headers so patch(1) targets our file.
  const patch =
    result.diff
      .split("\n")
      .map((line, i) =>
        i === 0 ? "--- chapter.md" : i === 1 ? "+++ chapter.md" : line
      )
      .join("\n") + "\n";
  fs.writeFileSync(path.join(dir, "d.patch"), patch);

  execFileSync("patch", ["-s", target], {
    input: fs.readFileSync(path.join(dir, "d.patch")),
    cwd: dir,
  });
  assert.equal(fs.readFileSync(target, "utf-8"), V2);
});

test("book_chapter_diff and book_chapter_history_list agree on the line counts", async (t) => {
  const { api } = await newProject(t);
  const { chapterId } = await callJson(api, "book_chapter_create", {
    title: "Agreement",
    synopsis: "s",
    content: V1,
  });
  await callJson(api, "book_chapter_update", { chapterId, content: V2 });

  const history = await callJson(api, "book_chapter_history_list", { chapterId });
  const newest = history.snapshots[0];
  const diff = await callJson(api, "book_chapter_diff", {
    chapterId,
    timestamp: newest.timestamp,
  });

  // Both go through the same diff module, so these cannot drift apart.
  assert.equal(diff.linesAdded, newest.versusCurrent.linesAdded);
  assert.equal(diff.linesRemoved, newest.versusCurrent.linesRemoved);
});
