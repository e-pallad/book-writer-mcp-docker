const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { collectTools, callJson } = require("./helpers/tools");
const { useTempProject, cleanup } = require("./helpers/project");

function tools() {
  const m = (n) => require(`../dist-tsc/tools/${n}`);
  return collectTools(
    m("manuscript").registerManuscriptTools,
    m("history").registerHistoryTools,
    m("book-edit").registerBookEditTools,
    m("storybible").registerStoryBibleTools,
    m("timeline").registerTimelineTools,
    m("outline").registerOutlineTools
  );
}

const CHAPTERS = [
  ["Der Kai", "Mara Vance ging über den Kai. Plötzlich sah sie Kell.\n\nMaras Mantel war nass. Vance fror."],
  ["Die Kneipe", "Kell trank. Plötzlich stand Mara in der Tür.\n\nDer Wirt brachte Maraschino-Kirschen."],
  ["Das Boot", "Niemand sprach. Das Boot lag still."],
];

async function seed(t) {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const api = tools();
  await callJson(api, "book_init", { title: "T", author: "A", genre: "G", language: "de" });
  for (const [title, body] of CHAPTERS) {
    await callJson(api, "book_chapter_create", { title, synopsis: `${title}: Mara.`, content: `# ${title}\n\n${body}\n` });
  }
  return { dir, api };
}

const read = (api, chapterId) =>
  callJson(api, "book_chapter_read", { chapterId }).then((r) => r.content);

// ---------------------------------------------------------------------------
// book_find

test("book_find finds text across chapters with paragraph and context", async (t) => {
  const { api } = await seed(t);
  const found = await callJson(api, "book_find", { query: "Plötzlich" });
  assert.equal(found.totalMatches, 2);
  assert.deepEqual(found.results.map((r) => r.chapterId), ["ch-001", "ch-002"]);
  assert.equal(found.results[0].occurrences[0].paragraph, 2);
  assert.match(found.results[0].occurrences[0].after, /sah sie Kell/);
});

test("book_find: whole words, case, and a capped reply with complete counts", async (t) => {
  const { api } = await seed(t);
  const partial = await callJson(api, "book_find", { query: "Mara" });
  assert.equal(partial.totalMatches, 4, "Mara Vance, Maras, Mara, Maraschino");

  const whole = await callJson(api, "book_find", { query: "Mara", wholeWord: true });
  assert.equal(whole.totalMatches, 2);

  const folded = await callJson(api, "book_find", { query: "plötzlich", caseSensitive: false });
  assert.equal(folded.totalMatches, 2);

  const capped = await callJson(api, "book_find", { query: "Mara", maxResults: 1 });
  assert.equal(capped.totalMatches, 4);
  assert.equal(capped.results.flatMap((r) => r.occurrences).length, 1);
  assert.match(capped.truncated, /Showing 1 of 4/);
});

// ---------------------------------------------------------------------------
// book_replace_text

test("book_replace_text is a dry run unless told otherwise", async (t) => {
  const { api } = await seed(t);
  const before = await read(api, "ch-001");
  const dry = await callJson(api, "book_replace_text", { oldText: "Plötzlich", newText: "Da" });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.wouldReplace, 2);
  assert.match(dry.next, /expectedCount=2/);
  assert.equal(await read(api, "ch-001"), before, "a dry run writes nothing");
});

test("book_replace_text applies across chapters, and each chapter can be reverted", async (t) => {
  const { api } = await seed(t);
  const result = await callJson(api, "book_replace_text", {
    oldText: "Plötzlich",
    newText: "Da",
    dryRun: false,
    expectedCount: 2,
  });
  assert.equal(result.replaced, 2);
  assert.match(await read(api, "ch-001"), /Da sah sie Kell/);
  assert.match(await read(api, "ch-002"), /Da stand Mara/);
  assert.ok(result.chapters.every((c) => c.previousVersionSaved));

  await callJson(api, "book_chapter_revert", {
    chapterId: "ch-002",
    timestamp: result.chapters[1].previousVersionSaved,
  });
  assert.match(await read(api, "ch-002"), /Plötzlich stand Mara/);
  assert.match(await read(api, "ch-001"), /Da sah sie Kell/, "the other chapter is untouched");
});

test("book_replace_text refuses when the count no longer matches the dry run", async (t) => {
  const { api } = await seed(t);
  await assert.rejects(
    callJson(api, "book_replace_text", {
      oldText: "Plötzlich",
      newText: "Da",
      dryRun: false,
      expectedCount: 3,
    }),
    /Expected 3 replacement\(s\) but the book now has 2. Nothing was written/
  );
  assert.match(await read(api, "ch-001"), /Plötzlich/);
});

test("book_replace_text with wholeWord leaves longer words alone, and keeps $ literal", async (t) => {
  const { api } = await seed(t);
  await callJson(api, "book_replace_text", {
    oldText: "Mara",
    newText: "$& Maria",
    wholeWord: true,
    dryRun: false,
  });
  const two = await read(api, "ch-002");
  assert.match(two, /\$& Maria in der Tür/, "the replacement is spliced in literally");
  assert.match(two, /Maraschino/);
});

// ---------------------------------------------------------------------------
// book_character_rename

async function withCast(api) {
  await callJson(api, "book_character_add", {
    name: "Mara Vance",
    aliases: ["die Inspektorin"],
    role: "protagonist",
    description: "Sieht Kell seit Jahren.",
  });
  await callJson(api, "book_character_add", {
    name: "Kell",
    role: "supporting",
    description: "Schuldet Mara Geld.",
    relationships: [{ characterId: "x", nature: "Freund von Mara Vance" }],
  });
  await callJson(api, "book_timeline_add", {
    event: "Mara Vance betritt die Kneipe",
    inStoryTime: "Abend",
    chapterId: "ch-002",
    characterIds: ["Mara Vance"],
  });
}

test("a character is renamed in the bible, the prose and everything that mentions them", async (t) => {
  const { dir, api } = await seed(t);
  await withCast(api);

  const result = await callJson(api, "book_character_rename", {
    characterId: "Mara Vance",
    newName: "Maria Reed",
  });
  assert.match(result.message, /"Mara Vance" is now "Maria Reed"/);

  const one = await read(api, "ch-001");
  assert.match(one, /Maria Reed ging/);
  assert.match(one, /Reed fror/, "a changed surname on its own is renamed too");
  const two = await read(api, "ch-002");
  assert.match(two, /stand Maria in der Tür/);
  assert.match(two, /Maraschino/, "whole words only");

  // The genitive is reported, not guessed at.
  assert.match(one, /Maras Mantel/);
  assert.deepEqual(result.notReplaced.map((f) => f.form), ["Maras", "Maraschino"]);

  const bible = JSON.parse(fs.readFileSync(path.join(dir, ".book-mcp", "story-bible.json"), "utf-8"));
  const kell = bible.characters.find((c) => c.name === "Kell");
  assert.equal(bible.characters[0].name, "Maria Reed");
  assert.equal(kell.description, "Schuldet Maria Geld.");
  assert.equal(kell.relationships[0].nature, "Freund von Maria Reed");

  const timeline = JSON.parse(fs.readFileSync(path.join(dir, ".book-mcp", "timeline.json"), "utf-8"));
  assert.equal(timeline.events[0].event, "Maria Reed betritt die Kneipe");

  const registry = JSON.parse(fs.readFileSync(path.join(dir, ".book-mcp", "registry.json"), "utf-8"));
  assert.equal(registry.chapters[0].synopsis, "Der Kai: Maria.");
});

test("includeGenitive renames -s genitives; the old name can stay as an alias", async (t) => {
  const { dir, api } = await seed(t);
  await withCast(api);
  await callJson(api, "book_character_rename", {
    characterId: "Mara Vance",
    newName: "Maria Reed",
    includeGenitive: true,
    keepOldNameAsAlias: true,
  });
  assert.match(await read(api, "ch-001"), /Marias Mantel/);
  const bible = JSON.parse(fs.readFileSync(path.join(dir, ".book-mcp", "story-bible.json"), "utf-8"));
  assert.ok(bible.characters[0].aliases.includes("Mara Vance"));
});

test("a word another character's name shares is not renamed on its own", async (t) => {
  const { api } = await seed(t);
  await withCast(api);
  await callJson(api, "book_character_add", { name: "Tom Vance", role: "minor", description: "Bruder." });

  const result = await callJson(api, "book_character_rename", {
    characterId: "Mara Vance",
    newName: "Mara Reed",
  });
  assert.match(result.skippedParts[0], /"Vance" on its own was left alone/);
  const one = await read(api, "ch-001");
  assert.match(one, /Mara Reed ging/);
  assert.match(one, /Vance fror/);
});

test("a dry run renames nothing, and a clash with another character is refused", async (t) => {
  const { dir, api } = await seed(t);
  await withCast(api);
  const dry = await callJson(api, "book_character_rename", {
    characterId: "Mara Vance",
    newName: "Maria Reed",
    dryRun: true,
  });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.replacedInProse, 3);
  assert.match(await read(api, "ch-001"), /Mara Vance ging/);

  await assert.rejects(
    callJson(api, "book_character_rename", { characterId: "Mara Vance", newName: "Kell" }),
    /already the name of Kell/
  );
});

test("each renamed chapter can be reverted to its old text", async (t) => {
  const { api } = await seed(t);
  await withCast(api);
  await callJson(api, "book_character_rename", { characterId: "Mara Vance", newName: "Maria Reed" });
  const { snapshots } = await callJson(api, "book_chapter_history_list", { chapterId: "ch-001" });
  await callJson(api, "book_chapter_revert", { chapterId: "ch-001", timestamp: snapshots[0].timestamp });
  assert.match(await read(api, "ch-001"), /Mara Vance ging/);
});
