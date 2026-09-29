const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const JSZip = require("jszip");

const { collectTools, callJson } = require("./helpers/tools");
const { useTempProject, cleanup } = require("./helpers/project");
const { runEpubcheck } = require("./helpers/epubcheck");

function tools() {
  const m = (n) => require(`../dist-tsc/tools/${n}`);
  return collectTools(
    m("manuscript").registerManuscriptTools,
    m("research").registerResearchTools,
    m("matter").registerMatterTools,
    m("book-edit").registerBookEditTools,
    m("export").registerExportTools,
    m("epub").registerEpubTools
  );
}

async function seed(t) {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const api = tools();
  await callJson(api, "book_init", { title: "Der Hafen", author: "A", genre: "Sachbuch", language: "de" });
  await callJson(api, "book_chapter_create", {
    title: "Die Gezeiten",
    synopsis: "s",
    content: "# Die Gezeiten\n\nDie Flut kam um [RECHERCHE: Gezeiten] Uhr.\n",
  });
  await callJson(api, "book_chapter_create", { title: "Der Kai", synopsis: "s", content: "# Der Kai\n\nText.\n" });
  return { dir, api };
}

test("research is kept with its chapters and tags, and found again", async (t) => {
  const { api } = await seed(t);
  const added = await callJson(api, "book_research_add", {
    title: "Gezeiten im Hamburger Hafen",
    content: "Tidenhub etwa 3,6 m. ".repeat(40),
    source: "Bundesamt für Seeschifffahrt: Gezeitentafeln 1997. Hamburg 1996.",
    tags: ["Hafen", "Wasser"],
    chapters: ["Die Gezeiten"],
    bibliography: true,
  });
  assert.deepEqual(added.entry.chapterIds, ["ch-001"]);

  await callJson(api, "book_research_add", { title: "Kaimauer, Bauweise", tags: ["Hafen"], chapters: ["ch-002"] });
  const planned = await callJson(api, "book_research_add", { title: "Später", chapters: ["ch-009"] });
  assert.match(planned.warnings[0], /No chapter "ch-009" exists yet/);

  const byTag = await callJson(api, "book_research_list", { tag: "hafen" });
  assert.equal(byTag.count, 2);
  assert.deepEqual(byTag.byTag, { Hafen: 2, Wasser: 1 });
  assert.ok(byTag.entries[0].content.endsWith("…"), "long content is shortened in a list");

  const byChapter = await callJson(api, "book_research_list", { chapterId: "Der Kai" });
  assert.deepEqual(byChapter.entries.map((e) => e.title), ["Kaimauer, Bauweise"]);

  const byText = await callJson(api, "book_research_list", { query: "tidenhub" });
  assert.equal(byText.count, 1);

  const full = await callJson(api, "book_research_list", { id: added.entry.id });
  assert.ok(!full.entry.content.endsWith("…"));
});

test("a bibliography entry needs a citation; entries can be updated and deleted", async (t) => {
  const { api } = await seed(t);
  await assert.rejects(
    callJson(api, "book_research_add", { title: "X", bibliography: true }),
    /needs its citation in source/
  );
  const { entry } = await callJson(api, "book_research_add", { title: "Hafenchronik" });
  await assert.rejects(
    callJson(api, "book_research_update", { id: entry.id, bibliography: true }),
    /needs its citation/
  );
  const updated = await callJson(api, "book_research_update", {
    id: entry.id,
    source: "Meier, Karl: Hafenchronik. Kiel 1980.",
    bibliography: true,
    tags: ["Geschichte"],
  });
  assert.equal(updated.entry.bibliography, true);

  await callJson(api, "book_research_delete", { id: entry.id });
  await assert.rejects(callJson(api, "book_research_delete", { id: entry.id }), /not found/);
});

test("the bibliography is written from the marked sources, sorted the German way", async (t) => {
  const { dir, api } = await seed(t);
  for (const source of [
    "Zeller, Jan: Schiffe. Bremen 2001.",
    "Ärztekammer Hamburg: Hafenmedizin. Hamburg 1999.",
    "Bauer, Eva: Kräne. Kiel 1990.",
  ]) {
    await callJson(api, "book_research_add", { title: source, source, bibliography: true });
  }
  await callJson(api, "book_research_add", { title: "Nur eine Notiz" });

  const set = await callJson(api, "book_matter_set", { type: "bibliography" });
  assert.equal(set.section.source, "generated");
  assert.equal(
    set.section.willPrint,
    "- Ärztekammer Hamburg: Hafenmedizin. Hamburg 1999.\n- Bauer, Eva: Kräne. Kiel 1990.\n- Zeller, Jan: Schiffe. Bremen 2001."
  );

  const md = path.join(dir, "m.md");
  await callJson(api, "book_export_markdown", { outputPath: md });
  assert.match(fs.readFileSync(md, "utf-8"), /# Quellen\n\n- Ärztekammer/);

  const epub = path.join(dir, "b.epub");
  await callJson(api, "book_export_epub", { outputPath: epub });
  const zip = await JSZip.loadAsync(fs.readFileSync(epub));
  const doc = await zip.file("OEBPS/matter-bibliography.xhtml").async("string");
  assert.match(doc, /<section epub:type="bibliography"/);
  const check = runEpubcheck(epub);
  if (check.available) {
    assert.ok(check.ok, check.output);
    assert.doesNotMatch(check.output, /WARNING/);
  }
});

test("an empty bibliography is left out of the export, and says why", async (t) => {
  const { dir, api } = await seed(t);
  const set = await callJson(api, "book_matter_set", { type: "bibliography" });
  assert.equal(set.section.willPrint, null);
  const result = await callJson(api, "book_export_markdown", { outputPath: path.join(dir, "m.md") });
  assert.ok(result.warnings.some((w) => /No research entry is marked for the bibliography/.test(w)));
});

test("a research placeholder is matched to the research on file", async (t) => {
  const { api } = await seed(t);
  const { entry } = await callJson(api, "book_research_add", { title: "Gezeiten im Hamburger Hafen" });
  const todo = await callJson(api, "book_todo_list", {});
  const placeholder = todo.chapters[0].placeholders[0];
  assert.equal(placeholder.kind, "RECHERCHE");
  assert.deepEqual(placeholder.research, [{ id: entry.id, title: "Gezeiten im Hamburger Hafen" }]);
});

test("deleting a chapter reports the research filed under it", async (t) => {
  const { api } = await seed(t);
  await callJson(api, "book_research_add", { title: "Kaimauer", chapters: ["Der Kai"] });
  const deleted = await callJson(api, "book_chapter_delete", { chapterId: "Der Kai", confirm: true });
  assert.ok(deleted.danglingReferences.some((r) => /1 research entry is filed under this chapter: "Kaimauer"/.test(r)));
  const list = await callJson(api, "book_research_list", { query: "Kaimauer" });
  assert.deepEqual(list.entries[0].missingChapters, ["ch-002"]);
});
