const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { collectTools, callJson } = require("./helpers/tools");
const { useTempProject, cleanup } = require("./helpers/project");

function allTools() {
  const m = (n) => require(`../dist-tsc/tools/${n}`);
  return collectTools(
    m("manuscript").registerManuscriptTools,
    m("storybible").registerStoryBibleTools,
    m("timeline").registerTimelineTools,
    m("continuity").registerContinuityTools,
    m("links").registerLinkTools
  );
}

async function newProject(t, chapters = 2) {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const api = allTools();
  await callJson(api, "book_init", { title: "Links", author: "A. Writer", genre: "crime" });
  for (let i = 1; i <= chapters; i++) {
    await callJson(api, "book_chapter_create", {
      title: `Kapitel ${i}`,
      synopsis: "s",
      content: `# Kapitel ${i}\n\nMara geht durch die Stadt.`,
    });
  }
  return { dir, api };
}

const registryPath = (dir) => path.join(dir, ".book-mcp", "registry.json");
const readRegistry = (dir) => JSON.parse(fs.readFileSync(registryPath(dir), "utf-8"));

// ---------------------------------------------------------------------------
// Chapter ids are never handed out twice

test("the id of a deleted last chapter is not given to the next chapter", async (t) => {
  const { api } = await newProject(t, 2);
  await callJson(api, "book_plot_thread_add", { title: "Der Brief", openedIn: "ch-002", summary: "s" });
  await callJson(api, "book_chapter_delete", { chapterId: "ch-002", confirm: true });

  const created = await callJson(api, "book_chapter_create", { title: "Neu", synopsis: "s" });
  assert.equal(created.chapterId, "ch-003");

  // The thread is left pointing at a chapter that is gone, and says so.
  const checked = await callJson(api, "book_links_check", {});
  const issue = checked.issues.find((i) => i.kind === "missing_chapter");
  assert.ok(issue, JSON.stringify(checked));
  assert.equal(issue.severity, "error");
  assert.equal(issue.to.id, "ch-002");
  assert.equal(issue.repair.tool, "book_plot_thread_update");
  assert.equal(issue.repair.choose, "openedIn");
});

test("a project without the counter learns the spent ids from the trash", async (t) => {
  const { dir, api } = await newProject(t, 3);
  await callJson(api, "book_chapter_delete", { chapterId: "ch-003", confirm: true });

  // A registry written before the counter existed.
  const registry = readRegistry(dir);
  delete registry.nextChapterNumber;
  fs.writeFileSync(registryPath(dir), JSON.stringify(registry));

  const created = await callJson(api, "book_chapter_create", { title: "Neu", synopsis: "s" });
  assert.equal(created.chapterId, "ch-004");
  assert.equal(readRegistry(dir).nextChapterNumber, 5);
});

test("deleting a chapter pins the counter on a project that had none", async (t) => {
  const { dir, api } = await newProject(t, 2);
  const registry = readRegistry(dir);
  delete registry.nextChapterNumber;
  fs.writeFileSync(registryPath(dir), JSON.stringify(registry));

  await callJson(api, "book_chapter_delete", { chapterId: "ch-002", confirm: true });
  assert.equal(readRegistry(dir).nextChapterNumber, 3);
});

// ---------------------------------------------------------------------------
// book_links_check

test("a book whose references all resolve is reported clean", async (t) => {
  const { api } = await newProject(t, 2);
  await callJson(api, "book_character_add", {
    name: "Mara Vance", role: "protagonist", description: "d", firstAppearance: "ch-001",
  });
  await callJson(api, "book_plot_thread_add", { title: "Brief", openedIn: "ch-001", summary: "s" });
  await callJson(api, "book_timeline_add", {
    event: "Mara geht", inStoryTime: "Samstag", chapterId: "ch-002", characterIds: ["Mara Vance"],
  });
  const checked = await callJson(api, "book_links_check", {});
  assert.deepEqual(checked.issues, []);
  assert.match(checked.summary, /All \d+ references resolve/);
});

test("references to a missing character, setting and chapter are each found", async (t) => {
  const { dir, api } = await newProject(t, 2);
  await callJson(api, "book_character_add", { name: "Mara Vance", role: "protagonist", description: "d" });
  await callJson(api, "book_timeline_add", {
    event: "Mara geht", inStoryTime: "Samstag", chapterId: "ch-001", characterIds: ["Mara Vance"],
  });

  const bibleFile = path.join(dir, ".book-mcp", "story-bible.json");
  const bible = JSON.parse(fs.readFileSync(bibleFile, "utf-8"));
  bible.characters[0].relationships = [{ characterId: "gone-1", nature: "sister" }];
  bible.characters[0].firstAppearance = "Kapitel Zehn";
  fs.writeFileSync(bibleFile, JSON.stringify(bible));
  fs.writeFileSync(
    path.join(dir, ".book-mcp", "scenes.json"),
    JSON.stringify({ scenes: [{ chapterId: "ch-001", anchor: "Mara geht", indexHint: 1, pov: bible.characters[0].id, settingId: "set-x", updatedAt: "x" }] })
  );

  const checked = await callJson(api, "book_links_check", {});
  const kinds = checked.issues.map((i) => i.kind).sort();
  assert.deepEqual(kinds, ["missing_character", "missing_setting", "unresolved_chapter"]);
  // Free text where an id belongs is a warning, a vanished character an error.
  assert.equal(checked.issues.find((i) => i.kind === "unresolved_chapter").severity, "warning");
  assert.equal(checked.issues.find((i) => i.kind === "missing_character").severity, "error");
  assert.equal(checked.issues[0].severity, "error");

  const onlyErrors = await callJson(api, "book_links_check", { severity: "error" });
  assert.ok(onlyErrors.issues.every((i) => i.severity === "error"));
});

test("a live chapter that reuses a deleted chapter's id is reported with what points at it", async (t) => {
  const { dir, api } = await newProject(t, 2);
  await callJson(api, "book_plot_thread_add", { title: "Der Brief", openedIn: "ch-002", summary: "s" });

  // What an older version left behind: a trashed ch-002 and a new ch-002.
  const trash = path.join(dir, ".book-mcp", "trash");
  fs.mkdirSync(trash, { recursive: true });
  fs.writeFileSync(path.join(trash, "2026-01-01T10-00-00-000Z-ch-002-alt.md"), "# Alt\n");

  const checked = await callJson(api, "book_links_check", {});
  const issue = checked.issues.find((i) => i.kind === "id_reused");
  assert.ok(issue, JSON.stringify(checked));
  assert.equal(issue.to.id, "ch-002");
  assert.match(issue.problem, /Der Brief/);
  assert.match(issue.problem, /2026-01-01T10-00-00-000Z-ch-002-alt\.md/);
});

test("duplicate positions, a missing chapter file and a shared alias are found", async (t) => {
  const { dir, api } = await newProject(t, 2);
  const registry = readRegistry(dir);
  registry.chapters[1].order = registry.chapters[0].order;
  fs.writeFileSync(registryPath(dir), JSON.stringify(registry));
  fs.rmSync(path.join(dir, "chapters", registry.chapters[1].filename));
  await callJson(api, "book_character_add", { name: "Mara", role: "protagonist", description: "d", aliases: ["M"] });
  await callJson(api, "book_character_add", { name: "Mia", role: "supporting", description: "d", aliases: ["M"] });

  const checked = await callJson(api, "book_links_check", {});
  const kinds = checked.issues.map((i) => i.kind).sort();
  assert.deepEqual(kinds, ["ambiguous_name", "duplicate_order", "missing_file"]);
});

test("chapterId narrows the report to one chapter", async (t) => {
  const { api } = await newProject(t, 3);
  await callJson(api, "book_plot_thread_add", { title: "A", openedIn: "ch-002", summary: "s" });
  await callJson(api, "book_plot_thread_add", { title: "B", openedIn: "ch-003", summary: "s" });
  await callJson(api, "book_chapter_delete", { chapterId: "ch-003", confirm: true });
  await callJson(api, "book_chapter_delete", { chapterId: "ch-002", confirm: true });

  const all = await callJson(api, "book_links_check", {});
  assert.equal(all.issues.length, 2);
  const one = await callJson(api, "book_links_check", { chapterId: "ch-001" });
  assert.equal(one.issues.length, 0);
});

// ---------------------------------------------------------------------------
// The timeline's "is the character in the chapter" check

test("the timeline check finds a character by first name, but not inside another word", async (t) => {
  const { api } = await newProject(t, 1);
  await callJson(api, "book_chapter_update", {
    chapterId: "ch-001",
    content: "# Eins\n\nMara öffnete den Brief. Almost nobody saw it.",
    confirmShrink: true,
  });
  await callJson(api, "book_character_add", {
    name: "Mara Vance", role: "protagonist", description: "d",
  });
  await callJson(api, "book_character_add", {
    name: "Albert Kell", role: "supporting", description: "d", aliases: ["Al"],
  });
  await callJson(api, "book_timeline_add", {
    event: "Der Brief", inStoryTime: "Samstag", chapterId: "ch-001", characterIds: ["Mara Vance", "Albert Kell"],
  });

  const checked = await callJson(api, "book_continuity_check", { chapterId: "ch-001" });
  const missing = checked.flags.filter((f) => f.type === "timeline").map((f) => f.description);
  assert.equal(missing.length, 1, JSON.stringify(missing));
  assert.match(missing[0], /Albert Kell/);
});
