const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { collectTools, callJson } = require("./helpers/tools");
const { useTempProject, cleanup } = require("./helpers/project");

const TOOLS_DIR = path.join(__dirname, "..", "dist-tsc", "tools");

// Every register*Tools function there is, so a new tool cannot slip past the
// list below.
function allTools() {
  const registers = fs
    .readdirSync(TOOLS_DIR)
    .filter((f) => f.endsWith(".js"))
    .flatMap((f) => {
      const mod = require(path.join(TOOLS_DIR, f));
      return Object.entries(mod)
        .filter(([name, fn]) => /^register\w+Tools$/.test(name) && typeof fn === "function")
        .map(([, fn]) => fn);
    });
  return collectTools(...registers);
}

// The tools that change the book. Exports, the exposé and the previews write
// output files, not the project, and are left out on purpose.
const WRITE_TOOLS = [
  "book_init",
  "book_project_update",
  "book_chapter_create",
  "book_chapter_update",
  "book_chapter_rename",
  "book_chapter_delete",
  "book_chapter_reorder",
  "book_chapter_replace_text",
  "book_chapter_append",
  "book_chapter_insert",
  "book_chapter_revert",
  "book_replace_text",
  "book_character_rename",
  "book_character_add",
  "book_character_update",
  "book_setting_add",
  "book_setting_update",
  "book_plot_thread_add",
  "book_plot_thread_resolve",
  "book_plot_thread_update",
  "book_plot_thread_touch",
  "book_theme_add",
  "book_theme_remove",
  "book_timeline_add",
  "book_timeline_update",
  "book_timeline_delete",
  "book_note_add",
  "book_note_resolve",
  "book_note_delete",
  "book_research_add",
  "book_research_update",
  "book_research_delete",
  "book_outline_set",
  "book_outline_update_chapter",
  "book_outline_link",
  "book_structure_set",
  "book_beat_set",
  "book_scene_set",
  "book_style_set",
  "book_style_add_influence",
  "book_style_remove_influence",
  "book_concept_set",
  "book_metadata_set",
  "book_matter_set",
  "book_matter_remove",
  "book_revision_mark",
  "book_stylesheet_add",
  "book_stylesheet_remove",
  "book_cover_create_spec",
  "book_ai_disclosure_generate",
  "book_author_from_linkedin",
  "book_author_update_profile",
  "book_author_regenerate_intro",
  "book_author_update_intro",
];

const BRIEF_KEYS = new Set(["id", "status", "wordCount", "firstNewParagraph", "chapters", "warnings"]);

function assertBrief(reply) {
  for (const key of Object.keys(reply)) {
    assert.ok(BRIEF_KEYS.has(key), `unexpected key "${key}" in a brief reply: ${JSON.stringify(reply)}`);
  }
  if (reply.chapters) {
    for (const c of reply.chapters) {
      assert.deepEqual(Object.keys(c).sort(), ["id", "status", "wordCount"]);
    }
  } else {
    assert.equal(typeof reply.id, "string");
    assert.equal(typeof reply.status, "string");
  }
}

// What book_chapter_list says about a chapter, in the shape of a brief reply.
async function listed(api, id) {
  const c = (await callJson(api, "book_chapter_list", {})).chapters.find((c) => c.id === id);
  return { id: c.id, status: c.status, wordCount: c.wordCount };
}

// Ten words: the heading counts.
async function seed(t) {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const api = allTools();
  await callJson(api, "book_init", { title: "Testbuch", author: "A", genre: "Krimi", language: "de" });
  const created = await callJson(api, "book_chapter_create", {
    title: "Die Kaimauer",
    synopsis: "s",
    content: "# Die Kaimauer\n\nMara ging über die Kaimauer.\n\nKell flickte Netze.\n",
  });
  return { dir, api, chapterId: created.chapterId };
}

test("every tool that writes the book takes brief, and no other tool does", () => {
  const tools = allTools();
  const withBrief = Object.values(tools)
    .filter((tool) => tool.schema.brief)
    .map((tool) => tool.name)
    .sort();
  assert.deepEqual(withBrief, [...WRITE_TOOLS].sort());
  for (const name of WRITE_TOOLS) {
    assert.match(tools[name].schema.brief.description, /id, status and word count/);
  }
});

test("brief chapter writes answer with id, status and word count only", async (t) => {
  const { api, chapterId } = await seed(t);

  const created = await callJson(api, "book_chapter_create", { title: "Zwei", synopsis: "s", content: "Eins zwei drei.", brief: true });
  assert.deepEqual(created, { id: "ch-002", status: "draft", wordCount: 3 });

  const updated = await callJson(api, "book_chapter_update", { chapterId, status: "review", brief: true });
  assert.deepEqual(updated, { id: chapterId, status: "review", wordCount: 10 });
  assert.deepEqual(updated, await listed(api, chapterId));

  const renamed = await callJson(api, "book_chapter_rename", { chapterId, title: "Am Kai", brief: true });
  assert.deepEqual(renamed, { id: chapterId, status: "review", wordCount: 10 });

  const replaced = await callJson(api, "book_chapter_replace_text", {
    chapterId,
    oldText: "Netze",
    newText: "die alten Netze",
    brief: true,
  });
  assert.deepEqual(replaced, { id: chapterId, status: "review", wordCount: 12 });
  assert.deepEqual(replaced, await listed(api, chapterId));

  const moved = await callJson(api, "book_chapter_reorder", { chapterId: "ch-002", newOrder: 1, brief: true });
  assert.deepEqual(moved, { id: "ch-002", status: "draft", wordCount: 3 });

  const history = await callJson(api, "book_chapter_history_list", { chapterId });
  const reverted = await callJson(api, "book_chapter_revert", {
    chapterId,
    timestamp: history.snapshots[0].timestamp,
    brief: true,
  });
  assert.deepEqual(reverted, { id: chapterId, status: "review", wordCount: 10 });
});

test("brief append and insert add the first new paragraph, never the text", async (t) => {
  const { api, chapterId } = await seed(t);

  const appended = await callJson(api, "book_chapter_append", {
    chapterId,
    content: "Am Morgen war der Hafen leer.",
    brief: true,
  });
  assert.deepEqual(appended, { id: chapterId, status: "draft", wordCount: 16, firstNewParagraph: 4 });

  const inserted = await callJson(api, "book_chapter_insert", {
    chapterId,
    content: "Es regnete.",
    afterParagraph: 1,
    brief: true,
  });
  assert.deepEqual(inserted, { id: chapterId, status: "draft", wordCount: 18, firstNewParagraph: 2 });
  const { firstNewParagraph, ...rest } = inserted;
  assert.deepEqual(rest, await listed(api, chapterId));

  // Both still file a version first.
  const history = await callJson(api, "book_chapter_history_list", { chapterId });
  assert.equal(history.snapshotCount, 2);
});

test("a brief reply keeps the warnings", async (t) => {
  const { api, chapterId } = await seed(t);

  // A scene break asked for where there is no prose yet is left out, and said so.
  const empty = await callJson(api, "book_chapter_create", { title: "Leer", synopsis: "s", brief: true });
  const appended = await callJson(api, "book_chapter_append", {
    chapterId: empty.id,
    content: "Erster Satz.",
    sceneBreak: true,
    brief: true,
  });
  assert.equal(appended.warnings.length, 1);
  assertBrief(appended);

  // A delete names what still points at the chapter.
  await callJson(api, "book_plot_thread_add", { title: "Die Schuld", openedIn: chapterId, summary: "s" });
  const deleted = await callJson(api, "book_chapter_delete", { chapterId, confirm: true, brief: true });
  assert.equal(deleted.id, chapterId);
  assert.equal(deleted.status, "deleted");
  assert.ok(deleted.warnings.some((w) => /Die Schuld/.test(w)), JSON.stringify(deleted));
  assertBrief(deleted);

  // Renaming a character only in the story bible warns about the prose.
  const added = await callJson(api, "book_character_add", {
    name: "Mara",
    role: "protagonist",
    description: "d",
    brief: true,
  });
  const renamed = await callJson(api, "book_character_update", {
    characterId: added.id,
    updates: { name: "Marah" },
    brief: true,
  });
  assert.equal(renamed.status, "updated");
  assert.match(renamed.warnings[0], /book_character_rename/);
});

test("without brief the full reply is unchanged", async (t) => {
  const { api, chapterId } = await seed(t);
  const full = await callJson(api, "book_chapter_update", { chapterId, status: "review" });
  assert.equal(full.meta.id, chapterId);
  assert.match(full.message, /updated/);

  const appended = await callJson(api, "book_chapter_append", { chapterId, content: "Noch ein Satz." });
  assert.equal(appended.firstNewParagraph, 4);
  assert.ok(appended.previousVersionSaved);
});

test("a dry run reports in full even with brief", async (t) => {
  const { api, chapterId } = await seed(t);
  const dry = await callJson(api, "book_chapter_append", {
    chapterId,
    content: "Noch ein Satz.",
    dryRun: true,
    brief: true,
  });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.paragraphsAdded, 1);

  const book = await callJson(api, "book_replace_text", { oldText: "Mara", newText: "Marah", brief: true });
  assert.equal(book.dryRun, true);
  assert.equal(book.wouldReplace, 1);
});

test("brief story bible, timeline, note and research writes answer with the id", async (t) => {
  const { api, chapterId } = await seed(t);

  const character = await callJson(api, "book_character_add", {
    name: "Kell",
    role: "supporting",
    description: "d",
    brief: true,
  });
  assert.match(character.id, /^char-/);
  assert.deepEqual(character, { id: character.id, status: "created" });

  const setting = await callJson(api, "book_setting_add", { name: "Der Kai", description: "d", type: "location", brief: true });
  assert.deepEqual(setting, { id: setting.id, status: "created" });

  const thread = await callJson(api, "book_plot_thread_add", {
    title: "Die Schuld",
    openedIn: chapterId,
    summary: "s",
    brief: true,
  });
  assert.equal(thread.status, "open");
  const resolved = await callJson(api, "book_plot_thread_resolve", { threadId: thread.id, resolvedIn: chapterId, brief: true });
  assert.deepEqual(resolved, { id: thread.id, status: "resolved" });

  const event = await callJson(api, "book_timeline_add", { event: "Ankunft", inStoryTime: "Morgens", brief: true });
  assert.deepEqual(event, { id: event.id, status: "created" });
  const gone = await callJson(api, "book_timeline_delete", { eventId: event.id, brief: true });
  assert.deepEqual(gone, { id: event.id, status: "deleted" });

  const note = await callJson(api, "book_note_add", { chapterId, text: "Zu kurz.", brief: true });
  assert.deepEqual(note, { id: note.id, status: "open" });
  const done = await callJson(api, "book_note_resolve", { noteId: note.id, brief: true });
  assert.deepEqual(done, { id: note.id, status: "resolved" });

  const research = await callJson(api, "book_research_add", { title: "Gezeiten", brief: true });
  assert.deepEqual(research, { id: research.id, status: "created" });

  const theme = await callJson(api, "book_theme_add", { name: "Schuld", brief: true });
  assert.deepEqual(theme, { id: "Schuld", status: "created" });
});

test("brief is never stored with what a tool writes", async (t) => {
  const { dir, api } = await seed(t);
  const mcp = path.join(dir, ".book-mcp");

  await callJson(api, "book_style_set", {
    voice: "v",
    pov: "p",
    tense: "past",
    tone: "t",
    targetAudience: "a",
    sentenceStyle: "s",
    thingsToAvoid: [],
    recurringMotifs: [],
    samplePassage: "x",
    brief: true,
  });
  const guide = JSON.parse(fs.readFileSync(path.join(mcp, "style-guide.json"), "utf-8"));
  assert.equal("brief" in guide, false);

  const project = await callJson(api, "book_project_update", { genre: "Roman", brief: true });
  assert.deepEqual(project, { id: "project", status: "updated", wordCount: 10 });
  const registry = JSON.parse(fs.readFileSync(path.join(mcp, "registry.json"), "utf-8"));
  assert.equal("brief" in registry, false);

  // brief alone is not something to set.
  await assert.rejects(callJson(api, "book_concept_set", { brief: true }), /Nothing to set/);
  await assert.rejects(callJson(api, "book_metadata_set", { brief: true }), /Nothing to set/);
  await assert.rejects(callJson(api, "book_project_update", { brief: true }), /Nothing to update/);

  const concept = await callJson(api, "book_concept_set", { logline: "Eine Frau am Kai.", brief: true });
  assert.deepEqual(concept, { id: "concept", status: "updated" });
});

test("brief writes across chapters report each chapter", async (t) => {
  const { api, chapterId } = await seed(t);
  await callJson(api, "book_chapter_create", { title: "Zwei", synopsis: "s", content: "Mara schlief." });
  await callJson(api, "book_character_add", { name: "Mara", role: "protagonist", description: "d" });

  const replaced = await callJson(api, "book_replace_text", {
    oldText: "Kell",
    newText: "Keller",
    dryRun: false,
    brief: true,
  });
  assert.deepEqual(replaced, { chapters: [{ id: chapterId, status: "draft", wordCount: 10 }] });

  const renamed = await callJson(api, "book_character_rename", { characterId: "Mara", newName: "Marah", brief: true });
  assert.equal(renamed.status, "updated");
  assert.deepEqual(
    renamed.chapters.map((c) => c.id),
    [chapterId, "ch-002"]
  );
  assertBrief(renamed);

  const marked = await callJson(api, "book_revision_mark", { pass: "structural", chapters: ["all"], brief: true });
  assert.equal(marked.chapters.length, 2);
  assertBrief(marked);
});
