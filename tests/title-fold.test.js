const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { collectTools, callJson } = require("./helpers/tools");
const { useTempProject, cleanup } = require("./helpers/project");

// Titles are compared with umlauts and their two-letter spellings treated
// alike wherever a tool looks one up — not only a chapter's.

function tools() {
  const m = (n) => require(`../dist-tsc/tools/${n}`);
  return collectTools(
    m("manuscript").registerManuscriptTools,
    m("outline").registerOutlineTools,
    m("storybible").registerStoryBibleTools,
    m("timeline").registerTimelineTools
  );
}

async function seed(t) {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const api = tools();
  await callJson(api, "book_init", { title: "T", author: "A", genre: "G", language: "de" });
  await callJson(api, "book_outline_set", {
    outline: [
      {
        act: "Erster Akt",
        chapters: [
          { title: "Ankunft", synopsis: "a" },
          { title: "Über die Brücke", synopsis: "b" },
          { title: "Die Straße", synopsis: "c" },
        ],
      },
    ],
  });
  await callJson(api, "book_chapter_create", { title: "Ankunft", synopsis: "s" });
  await callJson(api, "book_chapter_create", { title: "Am Fluss", synopsis: "s" });
  const outline = () => JSON.parse(fs.readFileSync(path.join(dir, ".book-mcp", "outline.json"), "utf-8"));
  return { dir, api, outline };
}

test("an outline entry is found by its title with umlauts spelled out", async (t) => {
  const { api, outline } = await seed(t);
  await callJson(api, "book_outline_update_chapter", { chapterTitle: "Ueber die Bruecke", synopsis: "neu" });
  await callJson(api, "book_outline_update_chapter", { chapterTitle: "die strasse", synopsis: "auch neu" });
  const entries = outline().acts[0].chapters;
  assert.equal(entries[1].synopsis, "neu");
  assert.equal(entries[1].title, "Über die Brücke", "the stored title keeps its umlauts");
  assert.equal(entries[2].synopsis, "auch neu");
});

test("book_chapter_create links the outline entry named with umlauts spelled out", async (t) => {
  const { api, outline } = await seed(t);
  const created = await callJson(api, "book_chapter_create", {
    title: "Die Brücke bei Nacht",
    synopsis: "s",
    outlineTitle: "Ueber die Bruecke",
  });
  assert.match(created.outline, /"Über die Brücke"/);
  assert.equal(outline().acts[0].chapters[1].chapterId, created.chapterId);
});

test("the exact title wins, and a spelled-out title that fits two entries is refused", async (t) => {
  const { api, outline } = await seed(t);
  await callJson(api, "book_outline_set", {
    outline: [
      {
        chapters: [
          { title: "Müller", synopsis: "a" },
          { title: "Mueller", synopsis: "b" },
          { title: "Größe", synopsis: "c" },
          { title: "Groeße", synopsis: "d" },
        ],
      },
    ],
  });

  await callJson(api, "book_outline_update_chapter", { chapterTitle: "mueller", synopsis: "exakt" });
  const entries = outline().acts[0].chapters;
  assert.equal(entries[0].synopsis, "a", "Müller is only a folded match");
  assert.equal(entries[1].synopsis, "exakt");

  // "Grösse" is neither title as written, and both once folded.
  await assert.rejects(
    callJson(api, "book_outline_update_chapter", { chapterTitle: "Grösse", synopsis: "x" }),
    /could be any of several outline entries .*"Größe", "Groeße"/
  );
});

test("a plot thread is found by its title with umlauts spelled out", async (t) => {
  const { api } = await seed(t);
  const added = await callJson(api, "book_plot_thread_add", { title: "Der Schlüssel", openedIn: "ch-001", summary: "s" });
  const resolved = await callJson(api, "book_plot_thread_resolve", { threadId: "der schluessel", resolvedIn: "#2" });
  assert.equal(resolved.thread.id, added.thread.id);
  assert.equal(resolved.thread.resolvedIn, "ch-002");
});

test("the timeline takes chapters as every other tool does: #N and spelled-out titles", async (t) => {
  const { api } = await seed(t);
  const byPosition = await callJson(api, "book_timeline_add", { event: "Ankunft", inStoryTime: "Morgens", chapterId: "#2" });
  assert.equal(byPosition.event.chapterId, "ch-002");

  await callJson(api, "book_chapter_create", { title: "Über die Brücke", synopsis: "s" });
  const folded = await callJson(api, "book_timeline_add", {
    event: "Flucht",
    inStoryTime: "Nachts",
    chapterId: "Ueber die Bruecke",
  });
  assert.equal(folded.event.chapterId, "ch-003");

  await assert.rejects(
    callJson(api, "book_timeline_add", { event: "x", inStoryTime: "y", chapterId: "#9" }),
    /There is no chapter #9/
  );
});
