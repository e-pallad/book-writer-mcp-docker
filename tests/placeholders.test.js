const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { collectTools, callJson } = require("./helpers/tools");
const { useTempProject, cleanup } = require("./helpers/project");
const { findPlaceholders } = require("../dist-tsc/utils/placeholders");

function tools() {
  const m = (n) => require(`../dist-tsc/tools/${n}`);
  return collectTools(
    m("manuscript").registerManuscriptTools,
    m("book-edit").registerBookEditTools,
    m("export").registerExportTools,
    m("epub").registerEpubTools,
    m("dashboard").registerDashboardTools
  );
}

test("the usual markers are found, with their note and paragraph", () => {
  const found = findPlaceholders(
    "Sie fuhr nach [TK].\n\nDer Hafen hieß [TODO: Name nachschlagen]. [RECHERCHE: Gezeiten 1997]\n\nTK kam an. [prüfen: Datum] [FIXME] [check] [XXX]"
  );
  assert.deepEqual(
    found.map((p) => [p.kind, p.note, p.paragraph]),
    [
      ["TK", "", 1],
      ["TODO", "Name nachschlagen", 2],
      ["RECHERCHE", "Gezeiten 1997", 2],
      ["TK", "", 3],
      ["PRÜFEN", "Datum", 3],
      ["FIXME", "", 3],
      ["CHECK", "", 3],
      ["XXX", "", 3],
    ]
  );
  assert.match(found[1].context, /Der Hafen hieß \[TODO: Name nachschlagen\]/);
});

test("ordinary brackets and words are not placeholders", () => {
  for (const text of [
    "Er sagte [sic] nichts.",
    "[Pause] Dann ging sie.",
    "Die TKO-Klausel.",
    "Ein tk kleingeschrieben.",
    "Die STKW-Leitung.",
    "[TKO]",
  ]) {
    assert.deepEqual(findPlaceholders(text), [], text);
  }
});

async function seed(t) {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const api = tools();
  await callJson(api, "book_init", { title: "T", author: "A", genre: "G", language: "de" });
  await callJson(api, "book_chapter_create", {
    title: "Eins",
    synopsis: "s",
    content: "# Eins\n\nSie fuhr nach [TK]. [RECHERCHE: Fähre]\n",
  });
  await callJson(api, "book_chapter_create", { title: "Zwei", synopsis: "s", content: "# Zwei\n\nFertig.\n" });
  return { dir, api };
}

test("book_todo_list shows every placeholder in the book, filterable by kind", async (t) => {
  const { api } = await seed(t);
  const all = await callJson(api, "book_todo_list", {});
  assert.equal(all.total, 2);
  assert.deepEqual(all.byKind, { TK: 1, RECHERCHE: 1 });
  assert.deepEqual(all.chapters.map((c) => c.chapterId), ["ch-001"]);

  const research = await callJson(api, "book_todo_list", { kind: "recherche" });
  assert.equal(research.total, 1);
  assert.equal(research.chapters[0].placeholders[0].note, "Fähre");
});

test("exports warn while placeholders remain", async (t) => {
  const { dir, api } = await seed(t);
  for (const [tool, file] of [
    ["book_export_markdown", "m.md"],
    ["book_export_docx", "m.docx"],
    ["book_export_epub", "m.epub"],
  ]) {
    const result = await callJson(api, tool, { outputPath: path.join(dir, file) });
    assert.match(result.warnings.join(" "), /2 placeholder\(s\) like \[TK\] or \[TODO\] are still in the text: ch-001 \(2\)/, tool);
  }
});

test("marking a chapter final with placeholders warns, and the dashboard flags it", async (t) => {
  const { api } = await seed(t);
  const updated = await callJson(api, "book_chapter_update", { chapterId: "ch-001", status: "final" });
  assert.match(updated.warnings.join(" "), /2 placeholder\(s\) still in the text \(\[TK\], \[RECHERCHE: Fähre\]\)/);

  const { health } = await callJson(api, "book_dashboard", {});
  const draft = health.find((f) => f.area === "draft");
  assert.equal(draft.severity, "serious");
  assert.match(draft.summary, /2 placeholder\(s\) to fill/);
});
