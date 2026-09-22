// About what these prove.
//
// Before the locking went in, most read-modify-write handlers never awaited
// between their read and their write, so within one process they were atomic
// by accident: the whole handler body ran in a single tick. Run against that
// older code, only the cases marked REGRESSION below fail — the race was real
// only where a handler genuinely yielded, which is book_author_from_linkedin
// awaiting an HTTP fetch with the document already in hand.
//
// The transaction helpers are async, so every handler now has an await point
// between its read and its write. That makes the lock load-bearing rather than
// belt-and-braces: with withFileLock stubbed out to run tasks immediately,
// nine of the twelve cases below fail. The guarantee and the mechanism that
// provides it are both under test here.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { collectTools, callJson } = require("./helpers/tools");
const { useTempProject, cleanup } = require("./helpers/project");
const { withFileLock, pendingLockCount } = require("../dist-tsc/storage/lock");

function allTools() {
  const mods = [
    "manuscript",
    "history",
    "storybible",
    "outline",
    "styleguide",
    "author",
  ].map((name) => require(`../dist-tsc/tools/${name}`));
  return collectTools(
    mods[0].registerManuscriptTools,
    mods[1].registerHistoryTools,
    mods[2].registerStoryBibleTools,
    mods[3].registerOutlineTools,
    mods[4].registerStyleGuideTools,
    mods[5].registerAuthorTools
  );
}

async function newProject(t) {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const api = allTools();
  await callJson(api, "book_init", {
    title: "Race Book",
    author: "A. Writer",
    genre: "fiction",
  });
  return { dir, api };
}

const readJson = (dir, name) =>
  JSON.parse(fs.readFileSync(path.join(dir, ".book-mcp", name), "utf-8"));

test("two concurrent book_character_add calls both land in story-bible.json", async (t) => {
  const { dir, api } = await newProject(t);

  const [alice, bob] = await Promise.all([
    callJson(api, "book_character_add", {
      name: "Alice",
      role: "protagonist",
      description: "Sharp, impatient.",
    }),
    callJson(api, "book_character_add", {
      name: "Bob",
      role: "antagonist",
      description: "Slow, deliberate.",
    }),
  ]);

  assert.equal(alice.character.name, "Alice");
  assert.equal(bob.character.name, "Bob");

  // Read the file off disk, not through the tools: a torn write has to show up
  // as invalid JSON or a lost character right here.
  const bible = readJson(dir, "story-bible.json");
  const names = bible.characters.map((c) => c.name).sort();
  assert.deepEqual(names, ["Alice", "Bob"], "neither add should overwrite the other");
  assert.equal(new Set(bible.characters.map((c) => c.id)).size, 2);
});

test("many concurrent writers to one file all survive", async (t) => {
  const { dir, api } = await newProject(t);

  const names = Array.from({ length: 25 }, (_, i) => `Character ${i}`);
  await Promise.all(
    names.map((name) =>
      callJson(api, "book_character_add", {
        name,
        role: "supporting",
        description: `Description for ${name}`,
      })
    )
  );

  const bible = readJson(dir, "story-bible.json");
  assert.equal(bible.characters.length, 25);
  assert.deepEqual([...bible.characters.map((c) => c.name)].sort(), [...names].sort());
});

test("concurrent writers to different files do not block each other's results", async (t) => {
  const { dir, api } = await newProject(t);

  await Promise.all([
    callJson(api, "book_character_add", {
      name: "Clara",
      role: "protagonist",
      description: "d",
    }),
    callJson(api, "book_setting_add", {
      name: "The Harbour",
      description: "d",
      type: "location",
    }),
    callJson(api, "book_style_set", {
      voice: "wry",
      pov: "third person limited",
      tense: "past",
      tone: "cool",
      targetAudience: "adult",
      sentenceStyle: "short",
      thingsToAvoid: ["suddenly"],
      recurringMotifs: ["tide"],
      samplePassage: "The tide went out.",
    }),
    callJson(api, "book_outline_set", {
      outline: [{ act: "One", chapters: [{ title: "Opening", synopsis: "s" }] }],
    }),
  ]);

  assert.equal(readJson(dir, "story-bible.json").characters.length, 1);
  assert.equal(readJson(dir, "story-bible.json").settings.length, 1);
  assert.equal(readJson(dir, "style-guide.json").voice, "wry");
  assert.equal(readJson(dir, "outline.json").acts.length, 1);
});

test("concurrent chapter creation hands out distinct ids", async (t) => {
  const { dir, api } = await newProject(t);

  const created = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      callJson(api, "book_chapter_create", {
        title: `Chapter ${i}`,
        synopsis: `s${i}`,
        content: `# Chapter ${i}\n\nbody\n`,
      })
    )
  );

  const ids = created.map((c) => c.chapterId);
  assert.equal(new Set(ids).size, 10, `ids collided: ${ids.join(", ")}`);

  const registry = readJson(dir, "registry.json");
  assert.equal(registry.chapters.length, 10);
  assert.equal(new Set(registry.chapters.map((c) => c.id)).size, 10);
});

test("a rename takes registry then outline without deadlocking", async (t) => {
  const { dir, api } = await newProject(t);

  await callJson(api, "book_outline_set", {
    outline: [{ act: "One", chapters: [{ title: "Old Title", synopsis: "s" }] }],
  });
  const { chapterId } = await callJson(api, "book_chapter_create", {
    title: "Old Title",
    synopsis: "s",
    content: "# Old Title\n\nbody\n",
  });

  // Nested locks: the outline update runs inside the registry transaction.
  const result = await callJson(api, "book_chapter_rename", {
    chapterId,
    title: "New Title",
  });
  assert.equal(result.outlineUpdated, true);
  assert.equal(readJson(dir, "outline.json").acts[0].chapters[0].title, "New Title");
  assert.equal(readJson(dir, "registry.json").chapters[0].title, "New Title");
});

test("concurrent renames against one chapter both apply in order", async (t) => {
  const { dir, api } = await newProject(t);
  const { chapterId } = await callJson(api, "book_chapter_create", {
    title: "Start",
    synopsis: "s",
    content: "# Start\n\nbody\n",
  });

  await Promise.all([
    callJson(api, "book_chapter_rename", { chapterId, title: "Middle" }),
    callJson(api, "book_chapter_update", { chapterId, synopsis: "updated synopsis" }),
  ]);

  const registry = readJson(dir, "registry.json");
  assert.equal(registry.chapters.length, 1);
  assert.equal(registry.chapters[0].title, "Middle", "the rename should not be lost");
  assert.equal(
    registry.chapters[0].synopsis,
    "updated synopsis",
    "the synopsis update should not be lost either"
  );
});

test("withFileLock runs tasks for one key in order, and different keys freely", async () => {
  const order = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  await Promise.all([
    withFileLock("a", async () => {
      order.push("a1-start");
      await sleep(20);
      order.push("a1-end");
    }),
    withFileLock("a", async () => {
      order.push("a2-start");
      await sleep(1);
      order.push("a2-end");
    }),
    withFileLock("b", async () => {
      order.push("b1");
    }),
  ]);

  // "a" is strictly serialized; "b" is free to finish whenever.
  assert.deepEqual(
    order.filter((o) => o.startsWith("a")),
    ["a1-start", "a1-end", "a2-start", "a2-end"]
  );
  assert.ok(order.includes("b1"));
});

test("a task that throws does not break the queue behind it", async () => {
  const seen = [];

  const failing = withFileLock("c", async () => {
    throw new Error("boom");
  });
  const following = withFileLock("c", async () => {
    seen.push("ran anyway");
    return "ok";
  });

  await assert.rejects(() => failing, /boom/);
  assert.equal(await following, "ok");
  assert.deepEqual(seen, ["ran anyway"]);
});

test("the lock table does not leak entries", async () => {
  const before = pendingLockCount();
  await Promise.all([
    withFileLock("leak-1", () => undefined),
    withFileLock("leak-2", () => undefined),
    withFileLock("leak-1", () => undefined),
  ]);
  // Let the cleanup microtasks settle.
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(pendingLockCount(), before, "finished keys should be dropped");
});

test("REGRESSION: a write that yields mid-transaction still sees its own state", async (t) => {
  const { dir } = await newProject(t);
  const { updateStoryBible } = require("../dist-tsc/storage/filestore");

  // Mimics book_author_from_linkedin: a real await between read and write.
  const slow = updateStoryBible(async (bible) => {
    bible.themes.push("slow");
    await new Promise((r) => setTimeout(r, 30));
    bible.themes.push("slow-after-await");
  });
  const fast = updateStoryBible((bible) => {
    bible.themes.push("fast");
  });

  await Promise.all([slow, fast]);

  const themes = readJson(dir, "story-bible.json").themes;
  assert.deepEqual(
    [...themes].sort(),
    ["fast", "slow", "slow-after-await"],
    `the awaited write lost a change: ${JSON.stringify(themes)}`
  );
});

test("REGRESSION: an awaiting registry transaction does not lose a concurrent change", async (t) => {
  const { dir } = await newProject(t);
  const { updateRegistry } = require("../dist-tsc/storage/filestore");

  // The shape book_chapter_update now has: an await inside the transaction,
  // because applyTitle updates outline.json before the registry is written.
  const slow = updateRegistry(async (registry) => {
    registry.genre = "slow-start";
    await new Promise((r) => setTimeout(r, 30));
    registry.genre = "slow-finish";
  });
  const fast = updateRegistry((registry) => {
    registry.targetWordCount = 12345;
  });

  await Promise.all([slow, fast]);

  const registry = readJson(dir, "registry.json");
  assert.equal(registry.genre, "slow-finish");
  assert.equal(
    registry.targetWordCount,
    12345,
    "the awaited transaction overwrote a change made while it was suspended"
  );
});

test("REGRESSION: concurrent renames of two chapters both reach disk", async (t) => {
  const { dir, api } = await newProject(t);

  await callJson(api, "book_outline_set", {
    outline: [
      {
        act: "One",
        chapters: [
          { title: "First", synopsis: "s" },
          { title: "Second", synopsis: "s" },
        ],
      },
    ],
  });
  const first = await callJson(api, "book_chapter_create", {
    title: "First",
    synopsis: "s",
    content: "# First\n\nbody\n",
  });
  const second = await callJson(api, "book_chapter_create", {
    title: "Second",
    synopsis: "s",
    content: "# Second\n\nbody\n",
  });

  // Each rename awaits an outline write partway through its registry
  // transaction, so without the lock one of the two titles is lost.
  await Promise.all([
    callJson(api, "book_chapter_rename", { chapterId: first.chapterId, title: "First Renamed" }),
    callJson(api, "book_chapter_rename", { chapterId: second.chapterId, title: "Second Renamed" }),
  ]);

  const titles = readJson(dir, "registry.json")
    .chapters.map((c) => c.title)
    .sort();
  assert.deepEqual(titles, ["First Renamed", "Second Renamed"]);

  const outlineTitles = readJson(dir, "outline.json")
    .acts[0].chapters.map((c) => c.title)
    .sort();
  assert.deepEqual(outlineTitles, ["First Renamed", "Second Renamed"]);
});

test("REGRESSION: entries added in the same millisecond get distinct ids", async (t) => {
  const { dir, api } = await newProject(t);

  // Ids used to be Date.now() alone, so a burst of adds inside one millisecond
  // handed out duplicates — and book_character_update looks characters up by
  // id, so it would have amended the wrong one.
  await Promise.all(
    Array.from({ length: 30 }, (_, i) =>
      callJson(api, "book_character_add", {
        name: `Burst ${i}`,
        role: "minor",
        description: "d",
      })
    )
  );
  await Promise.all(
    Array.from({ length: 15 }, (_, i) =>
      callJson(api, "book_plot_thread_add", {
        title: `Thread ${i}`,
        openedIn: "ch-001",
        summary: "s",
      })
    )
  );

  const bible = readJson(dir, "story-bible.json");
  assert.equal(new Set(bible.characters.map((c) => c.id)).size, 30, "character ids collided");
  assert.equal(new Set(bible.plotThreads.map((p) => p.id)).size, 15, "plot thread ids collided");

  // And an update reaches the character it names, not a namesake of its id.
  const target = bible.characters[7];
  await callJson(api, "book_character_update", {
    characterId: target.id,
    updates: { notes: "marked" },
  });
  const after = readJson(dir, "story-bible.json");
  const marked = after.characters.filter((c) => c.notes === "marked");
  assert.equal(marked.length, 1);
  assert.equal(marked[0].name, target.name);
});
