const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { collectTools, callJson } = require("./helpers/tools");
const { useTempProject, cleanup } = require("./helpers/project");

function tools() {
  const { registerManuscriptTools } = require("../dist-tsc/tools/manuscript");
  const { registerHistoryTools } = require("../dist-tsc/tools/history");
  return collectTools(registerManuscriptTools, registerHistoryTools);
}

async function newProject(t) {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const api = tools();
  await callJson(api, "book_init", {
    title: "Test Book",
    author: "A. Writer",
    genre: "fiction",
  });
  return { dir, api };
}

// The snapshot id is a timestamp, so two updates inside the same millisecond
// would land on the same second-resolution name. Real edits are seconds apart.
const tick = () => new Promise((r) => setTimeout(r, 5));

test("three updates leave three snapshots, and a revert makes a fourth", async (t) => {
  const { dir, api } = await newProject(t);

  const created = await callJson(api, "book_chapter_create", {
    title: "The Arrival",
    synopsis: "She arrives.",
    content: "# The Arrival\n\nVersion one of the prose.\n",
  });
  const chapterId = created.chapterId;

  const versions = [
    "# The Arrival\n\nVersion two of the prose.\n",
    "# The Arrival\n\nVersion three, now with a second line.\nAnd another.\n",
    "# The Arrival\n\nVersion four is quite different entirely.\n",
  ];
  for (const content of versions) {
    await callJson(api, "book_chapter_update", { chapterId, content });
    await tick();
  }

  const history = await callJson(api, "book_chapter_history_list", { chapterId });
  assert.equal(history.snapshotCount, 3, "one snapshot per content-changing update");

  // Newest first, and each carries a diff summary against the current text.
  const timestamps = history.snapshots.map((s) => s.timestamp);
  assert.deepEqual(
    [...timestamps].sort().reverse(),
    timestamps,
    "snapshots should be listed newest first"
  );
  for (const snapshot of history.snapshots) {
    assert.equal(typeof snapshot.versusCurrent.linesAdded, "number");
    assert.equal(typeof snapshot.versusCurrent.linesRemoved, "number");
  }

  // The oldest snapshot holds the text the chapter was created with.
  const oldest = timestamps[timestamps.length - 1];
  const snapshotFile = path.join(dir, ".book-mcp", "history", chapterId, `${oldest}.md`);
  assert.equal(
    fs.readFileSync(snapshotFile, "utf-8"),
    "# The Arrival\n\nVersion one of the prose.\n"
  );

  // Revert to it.
  const reverted = await callJson(api, "book_chapter_revert", {
    chapterId,
    timestamp: oldest,
  });
  assert.equal(reverted.restoredFrom, oldest);

  const read = await callJson(api, "book_chapter_read", { chapterId });
  assert.equal(
    read.content,
    "# The Arrival\n\nVersion one of the prose.\n",
    "the chapter should now hold the reverted text"
  );
  const { countWords } = require("../dist-tsc/utils/wordcount");
  assert.equal(
    read.meta.wordCount,
    countWords("# The Arrival\n\nVersion one of the prose.\n"),
    "the registry word count should follow the revert"
  );
  assert.equal(read.meta.wordCount, reverted.wordCount);
  assert.notEqual(
    read.meta.wordCount,
    countWords(versions[2]),
    "and should no longer match the text that was replaced"
  );

  // And the revert itself is undoable.
  const after = await callJson(api, "book_chapter_history_list", { chapterId });
  assert.equal(after.snapshotCount, 4, "the revert should file the text it replaced");
  assert.ok(
    after.snapshots.some((s) => s.timestamp === reverted.undoSnapshot),
    "the undo snapshot should appear in the history"
  );

  const undoFile = path.join(
    dir,
    ".book-mcp",
    "history",
    chapterId,
    `${reverted.undoSnapshot}.md`
  );
  assert.equal(
    fs.readFileSync(undoFile, "utf-8"),
    versions[2],
    "the undo snapshot should hold what the revert replaced"
  );

  // Reverting the revert restores the pre-revert text.
  await callJson(api, "book_chapter_revert", {
    chapterId,
    timestamp: reverted.undoSnapshot,
  });
  const undone = await callJson(api, "book_chapter_read", { chapterId });
  assert.equal(undone.content, versions[2]);
});

test("an update that does not change the prose files no snapshot", async (t) => {
  const { api } = await newProject(t);
  const { chapterId } = await callJson(api, "book_chapter_create", {
    title: "Static",
    synopsis: "s",
    content: "# Static\n\nUnchanged.\n",
  });

  await callJson(api, "book_chapter_update", {
    chapterId,
    content: "# Static\n\nUnchanged.\n",
  });
  await callJson(api, "book_chapter_update", { chapterId, status: "review" });
  await callJson(api, "book_chapter_update", { chapterId, synopsis: "new synopsis" });

  const history = await callJson(api, "book_chapter_history_list", { chapterId });
  assert.equal(history.snapshotCount, 0);
});

test("history is capped at 20 snapshots, oldest pruned first", async (t) => {
  const { api } = await newProject(t);
  const { chapterId } = await callJson(api, "book_chapter_create", {
    title: "Busy",
    synopsis: "s",
    content: "# Busy\n\nrevision 0\n",
  });

  for (let i = 1; i <= 25; i++) {
    await callJson(api, "book_chapter_update", {
      chapterId,
      content: `# Busy\n\nrevision ${i}\n`,
    });
    await tick();
  }

  const history = await callJson(api, "book_chapter_history_list", { chapterId });
  assert.equal(history.snapshotCount, 20, "the cap should hold");
  assert.equal(history.maxSnapshotsKept, 20);

  // 25 updates snapshot revisions 0..24; the newest 20 are 5..24.
  const { readSnapshot } = require("../dist-tsc/storage/history");
  const contents = history.snapshots.map((s) => readSnapshot(chapterId, s.timestamp));
  assert.match(contents[0], /revision 24/, "newest kept snapshot");
  assert.match(contents[19], /revision 5/, "oldest kept snapshot");
  assert.ok(
    !contents.some((c) => /revision [0-4]\n/.test(c)),
    "the five oldest revisions should have been pruned"
  );
});

test("a rename keeps the chapter's history with it", async (t) => {
  const { api } = await newProject(t);
  const { chapterId } = await callJson(api, "book_chapter_create", {
    title: "Old Title",
    synopsis: "s",
    content: "# Old Title\n\nProse.\n",
  });
  await callJson(api, "book_chapter_update", {
    chapterId,
    content: "# Old Title\n\nProse, revised.\n",
  });
  await tick();

  await callJson(api, "book_chapter_rename", { chapterId, title: "New Title" });

  const history = await callJson(api, "book_chapter_history_list", { chapterId: "New Title" });
  assert.equal(history.snapshotCount, 1, "history follows the chapter id, not the file name");
});

test("retitling and rewriting in one call snapshots the pre-call prose", async (t) => {
  const { api } = await newProject(t);
  const { chapterId } = await callJson(api, "book_chapter_create", {
    title: "First Name",
    synopsis: "s",
    content: "# First Name\n\nOriginal prose.\n",
  });

  await callJson(api, "book_chapter_update", {
    chapterId,
    title: "Second Name",
    content: "# Second Name\n\nRewritten prose.\n",
  });

  const { readSnapshot } = require("../dist-tsc/storage/history");
  const history = await callJson(api, "book_chapter_history_list", { chapterId });
  assert.equal(history.snapshotCount, 1);
  assert.equal(
    readSnapshot(chapterId, history.snapshots[0].timestamp),
    "# First Name\n\nOriginal prose.\n",
    "the snapshot should predate both the rename and the rewrite"
  );
});

test("deleting a chapter moves its history aside so a reused id cannot inherit it", async (t) => {
  const { dir, api } = await newProject(t);
  const first = await callJson(api, "book_chapter_create", {
    title: "Doomed",
    synopsis: "s",
    content: "# Doomed\n\nSecret draft.\n",
  });
  await callJson(api, "book_chapter_update", {
    chapterId: first.chapterId,
    content: "# Doomed\n\nSecret draft, revised.\n",
  });

  await callJson(api, "book_chapter_delete", {
    chapterId: first.chapterId,
    confirm: true,
  });

  // Deleting the highest chapter frees its id for the next one created.
  const second = await callJson(api, "book_chapter_create", {
    title: "Fresh Start",
    synopsis: "s",
    content: "# Fresh Start\n\nNothing to do with the last one.\n",
  });
  assert.equal(second.chapterId, first.chapterId, "precondition: the id is reused");

  const history = await callJson(api, "book_chapter_history_list", {
    chapterId: second.chapterId,
  });
  assert.equal(history.snapshotCount, 0, "the new chapter must start with no history");

  // The old revisions are recoverable, not destroyed.
  const trash = fs.readdirSync(path.join(dir, ".book-mcp", "trash"));
  assert.ok(
    trash.some((name) => name.includes(`history-${first.chapterId}`)),
    `expected the history in trash, found: ${trash.join(", ")}`
  );
});

test("reverting to an unknown timestamp fails with the available ones listed", async (t) => {
  const { api } = await newProject(t);
  const { chapterId } = await callJson(api, "book_chapter_create", {
    title: "Solo",
    synopsis: "s",
    content: "# Solo\n\nOne.\n",
  });
  await callJson(api, "book_chapter_update", { chapterId, content: "# Solo\n\nTwo.\n" });

  await assert.rejects(
    () => callJson(api, "book_chapter_revert", { chapterId, timestamp: "not-a-snapshot" }),
    /No snapshot "not-a-snapshot"/
  );
});

test("a chapter id cannot escape the history directory", async (t) => {
  const { api } = await newProject(t);
  const { chapterId } = await callJson(api, "book_chapter_create", {
    title: "Guard",
    synopsis: "s",
    content: "# Guard\n\nx\n",
  });
  await callJson(api, "book_chapter_update", { chapterId, content: "# Guard\n\ny\n" });

  await assert.rejects(
    () =>
      callJson(api, "book_chapter_revert", {
        chapterId,
        timestamp: "../../../etc/passwd",
      }),
    /Invalid snapshot timestamp/
  );
});
