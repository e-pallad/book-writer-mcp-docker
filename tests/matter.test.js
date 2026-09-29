const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const JSZip = require("jszip");

const { collectTools, callJson } = require("./helpers/tools");
const { useTempProject, cleanup } = require("./helpers/project");
const { runEpubcheck } = require("./helpers/epubcheck");
const labels = require("../dist-tsc/lang/labels");

function tools() {
  const m = (n) => require(`../dist-tsc/tools/${n}`);
  return collectTools(
    m("manuscript").registerManuscriptTools,
    m("project").registerProjectTools,
    m("matter").registerMatterTools,
    m("metadata").registerMetadataTools,
    m("storybible").registerStoryBibleTools,
    m("export").registerExportTools,
    m("epub").registerEpubTools,
    m("preview").registerPreviewTools
  );
}

async function newProject(t, language = "de") {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const api = tools();
  await callJson(api, "book_init", { title: "Der Hafen", author: "A. Autorin", genre: "Krimi", language });
  return { dir, api };
}

// A book with the works: a prologue outside the numbering, two parts, front
// and back matter.
async function fullBook(api) {
  await callJson(api, "book_project_update", { chapterNumbering: "words" });
  await callJson(api, "book_metadata_set", {
    isbnEbook: "9783161484100",
    publisher: "Kleinverlag",
    publicationDate: "2027-03-01",
    contributors: [{ name: "B. Lektorin", role: "editor" }],
  });
  await callJson(api, "book_character_add", {
    name: "Mara",
    role: "protagonist",
    description: "Inspektorin am Hafen. Hat ein Geheimnis.",
  });
  await callJson(api, "book_character_add", { name: "Kell", role: "supporting", description: "Hafenarbeiter." });
  await callJson(api, "book_character_add", { name: "Der Wirt", role: "minor", description: "Schenkt aus." });

  const chapters = [
    ["Prolog", "Es war Nacht.", { numbered: false }],
    ["Der Kai", "Mara kam an.", { part: "Die Stadt" }],
    ["Die Kneipe", "Kell trank.", { part: "Die Stadt" }],
    ["Das Meer", "Wellen.", { part: "Das Wasser" }],
  ];
  for (const [title, text, extra] of chapters) {
    await callJson(api, "book_chapter_create", { title, synopsis: "s", content: `# ${title}\n\n${text}\n`, ...extra });
  }

  await callJson(api, "book_matter_set", { type: "copyright" });
  await callJson(api, "book_matter_set", { type: "dedication", content: "Für M." });
  await callJson(api, "book_matter_set", { type: "epigraph", content: "> *Alles fließt.*\n> — Heraklit" });
  await callJson(api, "book_matter_set", { type: "dramatis_personae" });
  await callJson(api, "book_matter_set", { type: "acknowledgements", content: "Danke an alle." });
}

test("labels number chapters and parts in words and figures, in both languages", () => {
  assert.equal(labels.de.chapter(3, "words"), "Drittes Kapitel");
  assert.equal(labels.de.chapter(3, "numeric"), "Kapitel 3");
  assert.equal(labels.de.chapter(21, "words"), "Kapitel 21", "past the words the language has");
  assert.equal(labels.de.part(2), "Zweiter Teil");
  assert.equal(labels.en.chapter(3, "words"), "Chapter Three");
  assert.equal(labels.en.part(1), "Part One");
});

test("a section that cannot write itself needs content; the others can", async (t) => {
  const { api } = await newProject(t);
  await assert.rejects(callJson(api, "book_matter_set", { type: "dedication" }), /needs content/);

  const copyright = await callJson(api, "book_matter_set", { type: "copyright" });
  assert.equal(copyright.section.source, "generated");
  assert.match(copyright.section.willPrint, /© \d{4} A\. Autorin/);
  assert.match(copyright.section.willPrint, /Alle Rechte vorbehalten\./);

  const about = await callJson(api, "book_matter_set", { type: "about_author" });
  assert.equal(about.section.willPrint, null);
  assert.match(about.section.note, /no author bio/);
});

test("the copyright page is written from the metadata, in the book's language", async (t) => {
  const { api } = await newProject(t);
  await fullBook(api);
  const { section } = await callJson(api, "book_matter_get", { type: "copyright" });
  assert.match(section.willPrint, /\*\*Der Hafen\*\*/);
  assert.match(section.willPrint, /© 2027 A\. Autorin\nAlle Rechte vorbehalten\./);
  assert.match(section.willPrint, /Erstausgabe 2027-03-01\nKleinverlag/);
  assert.match(section.willPrint, /Lektorat: B\. Lektorin/);
  assert.match(section.willPrint, /ISBN 9783161484100 \(E-Book\)/);
});

test("the cast list leaves out minor roles and prints one sentence each, with a spoiler caution", async (t) => {
  const { api } = await newProject(t);
  await fullBook(api);
  const set = await callJson(api, "book_matter_set", { type: "dramatis_personae", position: "back" });
  assert.match(set.caution, /spoilers/);
  assert.equal(set.section.position, "back");
  assert.equal(set.section.willPrint, "**Mara** — Inspektorin am Hafen.\n\n**Kell** — Hafenarbeiter.");
});

test("the list is in reading order, and headings can be overridden or removed", async (t) => {
  const { api } = await newProject(t);
  await fullBook(api);
  await callJson(api, "book_matter_set", { type: "acknowledgements", title: "Dank" });

  const list = await callJson(api, "book_matter_list", {});
  assert.deepEqual(list.front.map((s) => s.type), ["copyright", "dedication", "epigraph", "dramatis_personae"]);
  assert.deepEqual(list.back.map((s) => [s.type, s.heading]), [["acknowledgements", "Dank"]]);
  assert.ok(list.available.includes("afterword"));

  await callJson(api, "book_matter_remove", { type: "epigraph" });
  await assert.rejects(callJson(api, "book_matter_remove", { type: "epigraph" }), /has no epigraph/);
});

test("the markdown export lays the book out in the classic order", async (t) => {
  const { dir, api } = await newProject(t);
  await fullBook(api);
  const out = path.join(dir, "m.md");
  const result = await callJson(api, "book_export_markdown", {
    outputPath: out,
    includeChapters: ["Prolog", "Der Kai", "Die Kneipe", "Das Meer"],
  });
  const md = fs.readFileSync(out, "utf-8");

  const order = [
    "# Der Hafen",
    "**Von A. Autorin**",
    "Alle Rechte vorbehalten.",
    "Für M.",
    "Heraklit",
    "# Personen",
    "# Prolog",
    "# Erster Teil\n\n## Die Stadt",
    "# Erstes Kapitel: Der Kai",
    "# Zweites Kapitel: Die Kneipe",
    "# Zweiter Teil\n\n## Das Wasser",
    "# Drittes Kapitel: Das Meer",
    "# Danksagung",
  ];
  let cursor = -1;
  for (const piece of order) {
    const at = md.indexOf(piece);
    assert.ok(at > cursor, `"${piece}" should come after the previous piece:\n${md}`);
    cursor = at;
  }
  assert.ok(!md.includes("# Der Kai\n"), "the chapter's own heading is replaced, not doubled");
  assert.deepEqual(result.matter, ["Impressum", "Widmung", "Motto", "Personen", "Danksagung"]);
});

test("the DOCX sets part pages, chapter numbers and the matter, and lists them in the contents", async (t) => {
  const { dir, api } = await newProject(t);
  await fullBook(api);
  const out = path.join(dir, "m.docx");
  await callJson(api, "book_export_docx", { outputPath: out, includeChapters: ["Prolog", "Der Kai", "Die Kneipe", "Das Meer"] });
  const xml = await (await JSZip.loadAsync(fs.readFileSync(out))).file("word/document.xml").async("string");
  const text = [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]);

  const contents = text.indexOf("Inhalt");
  assert.ok(contents > text.indexOf("Für M."), "the dedication comes before the contents");
  assert.ok(text.indexOf("Erster Teil: Die Stadt") > contents, "parts are listed in the contents");
  assert.ok(text.indexOf("Erstes Kapitel: Der Kai") > contents, "so are numbered chapters");
  assert.ok(text.lastIndexOf("Erstes Kapitel") > text.indexOf("Erstes Kapitel: Der Kai"), "the label is printed above the chapter");
  assert.ok(text.lastIndexOf("Danksagung") > text.lastIndexOf("Wellen."), "back matter follows the last chapter");
});

test("the EPUB has part pages, a nested contents and semantic matter, and passes epubcheck", async (t) => {
  const { dir, api } = await newProject(t);
  await fullBook(api);
  const out = path.join(dir, "b.epub");
  const result = await callJson(api, "book_export_epub", {
    outputPath: out,
    includeChapters: ["Prolog", "Der Kai", "Die Kneipe", "Das Meer"],
  });
  assert.equal(result.chaptersIncluded, 4);

  const zip = await JSZip.loadAsync(fs.readFileSync(out));
  const opf = await zip.file("OEBPS/content.opf").async("string");
  const spine = [...opf.slice(opf.indexOf("<spine")).matchAll(/idref="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(spine, [
    "titlepage",
    "matter-copyright",
    "matter-dedication",
    "matter-epigraph",
    "nav",
    "matter-dramatis_personae",
    "chapter-1",
    "part-1",
    "chapter-2",
    "chapter-3",
    "part-2",
    "chapter-4",
    "matter-acknowledgements",
  ]);

  const nav = await zip.file("OEBPS/nav.xhtml").async("string");
  assert.match(nav, /<a href="part-01\.xhtml">Erster Teil: Die Stadt<\/a>\s*<ol>\s*<li><a href="chapter-002\.xhtml">Erstes Kapitel: Der Kai<\/a><\/li>/);
  assert.match(nav, /epub:type="copyright-page" href="matter-copyright\.xhtml"/);
  assert.doesNotMatch(nav, /Widmung/, "an unheaded dedication is not a contents entry");

  const dedication = await zip.file("OEBPS/matter-dedication.xhtml").async("string");
  assert.match(dedication, /<section epub:type="dedication"/);
  const chapter = await zip.file("OEBPS/chapter-002.xhtml").async("string");
  assert.match(chapter, /<p class="chapter-label">Erstes Kapitel<\/p>\n<h1>Der Kai<\/h1>/);
  const prologue = await zip.file("OEBPS/chapter-001.xhtml").async("string");
  assert.doesNotMatch(prologue, /chapter-label/, "the prologue carries no number");

  const check = runEpubcheck(out);
  if (!check.available) {
    t.diagnostic("epubcheck not available; structural checks only");
  } else {
    assert.ok(check.ok, check.output);
    assert.doesNotMatch(check.output, /WARNING/);
  }
});

test("the preview shows the same layout", async (t) => {
  const { dir, api } = await newProject(t);
  await fullBook(api);
  await callJson(api, "book_preview", { chapters: ["Der Kai"] });
  const html = fs.readFileSync(path.join(dir, "preview.html"), "utf-8");
  assert.match(html, /<h1>Erster Teil<\/h1>\n<h2>Die Stadt<\/h2>/);
  assert.match(html, /<h1>Erstes Kapitel: Der Kai<\/h1>/);
  assert.match(html, /Alle Rechte vorbehalten\./);
});

test("chapters can be moved into and out of parts and numbering", async (t) => {
  const { dir, api } = await newProject(t, "en");
  await callJson(api, "book_project_update", { chapterNumbering: "numeric" });
  await callJson(api, "book_chapter_create", { title: "One", synopsis: "s", content: "# One\n\nA." });
  await callJson(api, "book_chapter_update", { chapterId: "One", part: "Book the First" });
  const list = await callJson(api, "book_chapter_list", {});
  assert.equal(list.chapters[0].part, "Book the First");

  const out = path.join(dir, "m.md");
  await callJson(api, "book_export_markdown", { outputPath: out });
  const md = fs.readFileSync(out, "utf-8");
  assert.match(md, /# Book the First\n/, "a part that names itself gets no second label");
  assert.match(md, /# Chapter 1: One/);

  await callJson(api, "book_chapter_update", { chapterId: "One", part: "", numbered: false });
  await callJson(api, "book_export_markdown", { outputPath: out });
  const plain = fs.readFileSync(out, "utf-8");
  assert.doesNotMatch(plain, /Book the First|Chapter 1/);
});
