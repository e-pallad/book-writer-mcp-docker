const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const JSZip = require("jszip");

const { collectTools, callJson } = require("./helpers/tools");
const { useTempProject, cleanup } = require("./helpers/project");
const { runEpubcheck } = require("./helpers/epubcheck");
const { checkIsbn } = require("../dist-tsc/publishing/metadata");

function tools() {
  const m = (n) => require(`../dist-tsc/tools/${n}`);
  return collectTools(
    m("manuscript").registerManuscriptTools,
    m("metadata").registerMetadataTools,
    m("epub").registerEpubTools,
    m("export").registerExportTools,
    m("cover").registerCoverTools,
    m("dashboard").registerDashboardTools
  );
}

async function newProject(t) {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const api = tools();
  await callJson(api, "book_init", { title: "Der Hafen", author: "A. Autorin", genre: "Krimi", language: "de" });
  await callJson(api, "book_chapter_create", { title: "Eins", synopsis: "s", content: "# Eins\n\nText." });
  return { dir, api };
}

const stored = (dir) =>
  JSON.parse(fs.readFileSync(path.join(dir, ".book-mcp", "metadata.json"), "utf-8"));

test("ISBN check digits, with the usual ways of writing one", () => {
  assert.deepEqual(checkIsbn("978-3-16-148410-0"), { valid: true, normalized: "9783161484100", kind: "isbn-13" });
  assert.equal(checkIsbn("urn:isbn:9783161484100").valid, true);
  assert.equal(checkIsbn("ISBN 0-306-40615-2").valid, true);
  assert.equal(checkIsbn("080442957X").valid, true);
  assert.equal(checkIsbn("9783161484101").valid, false, "wrong check digit");
  assert.equal(checkIsbn("12345").kind, null);
});

test("metadata is saved, normalised, and cleared by an empty value", async (t) => {
  const { dir, api } = await newProject(t);
  const saved = await callJson(api, "book_metadata_set", {
    subtitle: "Ein Kriminalroman",
    seriesName: "Hafen-Krimis",
    seriesNumber: 2,
    description: "Mara ermittelt.",
    keywords: ["Hafen", " Krimi ", ""],
    isbnEbook: "978-3-16-148410-0",
    publisher: "Kleinverlag",
    publicationDate: "2027-03-01",
    contributors: [{ name: "B. Lektorin", role: "editor" }],
  });
  assert.equal(saved.message, "Metadata saved.");
  const data = stored(dir);
  assert.deepEqual(data.keywords, ["Hafen", "Krimi"]);
  assert.equal(data.isbn.ebook, "9783161484100");
  assert.deepEqual(data.series, { name: "Hafen-Krimis", number: 2 });
  assert.equal(saved.rights, "© 2027 A. Autorin", "the publication year and the author by default");

  await callJson(api, "book_metadata_set", { subtitle: "", keywords: [], copyrightHolder: "Verlag X", copyrightYear: 2026 });
  const after = await callJson(api, "book_metadata_get", {});
  assert.equal(after.metadata.subtitle, undefined);
  assert.equal(after.metadata.keywords, undefined);
  assert.equal(after.rights, "© 2026 Verlag X");
  assert.deepEqual(after.missing.map((m) => m.field), ["keywords", "categories"]);
});

test("what KDP would reject is refused, and nothing is half-saved", async (t) => {
  const { dir, api } = await newProject(t);
  await callJson(api, "book_metadata_set", { description: "Vorher." });

  await assert.rejects(
    callJson(api, "book_metadata_set", {
      description: "Nachher.",
      keywords: ["a", "b", "c", "d", "e", "f", "g", "h"],
    }),
    /8 keywords; KDP takes 7/
  );
  assert.equal(stored(dir).description, "Vorher.", "the valid half of a refused call is not written");

  await assert.rejects(callJson(api, "book_metadata_set", { keywords: ["x".repeat(51)] }), /51 characters/);
  await assert.rejects(callJson(api, "book_metadata_set", { isbnPaperback: "9783161484101" }), /check digit/);
  await assert.rejects(
    callJson(api, "book_metadata_set", { isbnEbook: "9783161484100", isbnPaperback: "978-3-16-148410-0" }),
    /share one ISBN/
  );
  await assert.rejects(callJson(api, "book_metadata_set", { categories: ["a", "b", "c", "d"] }), /KDP takes 3/);
  await assert.rejects(callJson(api, "book_metadata_set", { publicationDate: "2027-02-30" }), /not a YYYY-MM-DD/);
  await assert.rejects(callJson(api, "book_metadata_set", { seriesNumber: 3 }), /Name the series/);
});

test("the EPUB carries subtitle, series, ISBN, publisher, rights and contributors, and stays valid", async (t) => {
  const { dir, api } = await newProject(t);
  await callJson(api, "book_metadata_set", {
    subtitle: "Ein Kriminalroman",
    seriesName: "Hafen-Krimis",
    seriesNumber: 2,
    description: "Mara ermittelt & schweigt.",
    categories: ["FIC022000"],
    isbnEbook: "9783161484100",
    publisher: "Kleinverlag",
    publicationDate: "2027-03-01",
    contributors: [{ name: "B. Lektorin", role: "editor" }],
  });

  const out = path.join(dir, "b.epub");
  const result = await callJson(api, "book_export_epub", { outputPath: out });
  assert.equal(result.metadata.identifier, "urn:isbn:9783161484100");
  assert.match(result.metadata.identifierSource, /ISBN/);

  const zip = await JSZip.loadAsync(fs.readFileSync(out));
  const opf = await zip.file("OEBPS/content.opf").async("string");
  assert.match(opf, /<dc:title id="subtitle">Ein Kriminalroman<\/dc:title>/);
  assert.match(opf, /<meta refines="#subtitle" property="title-type">subtitle<\/meta>/);
  assert.match(opf, /<meta property="belongs-to-collection" id="series">Hafen-Krimis<\/meta>/);
  assert.match(opf, /<meta refines="#series" property="group-position">2<\/meta>/);
  assert.match(opf, /<dc:publisher>Kleinverlag<\/dc:publisher>/);
  assert.match(opf, /<dc:date>2027-03-01<\/dc:date>/);
  assert.match(opf, /<dc:rights>© 2027 A\. Autorin<\/dc:rights>/);
  assert.match(opf, /<dc:subject>FIC022000<\/dc:subject>/);
  assert.match(opf, /<dc:description>Mara ermittelt &amp; schweigt\.<\/dc:description>/);
  assert.match(opf, /property="role" scheme="marc:relators">edt<\/meta>/);
  const titlePage = await zip.file("OEBPS/titlepage.xhtml").async("string");
  assert.match(titlePage, /<p class="subtitle">Ein Kriminalroman<\/p>/);

  const check = runEpubcheck(out);
  if (!check.available) {
    t.diagnostic("epubcheck not available; structural checks only");
  } else {
    assert.ok(check.ok, check.output);
    assert.doesNotMatch(check.output, /WARNING/);
  }
});

test("without an ISBN the EPUB keeps one stable identifier across exports", async (t) => {
  const { dir, api } = await newProject(t);
  const out = path.join(dir, "b.epub");
  const first = await callJson(api, "book_export_epub", { outputPath: out });
  const second = await callJson(api, "book_export_epub", { outputPath: out });
  assert.match(first.metadata.identifier, /^urn:uuid:/);
  assert.equal(first.metadata.identifier, second.metadata.identifier);
  assert.equal(`urn:uuid:${stored(dir).uuid}`, first.metadata.identifier);
});

test("the DOCX title page shows the subtitle", async (t) => {
  const { dir, api } = await newProject(t);
  await callJson(api, "book_metadata_set", { subtitle: "Ein Kriminalroman" });
  const out = path.join(dir, "m.docx");
  await callJson(api, "book_export_docx", { outputPath: out });
  const zip = await JSZip.loadAsync(fs.readFileSync(out));
  assert.match(await zip.file("word/document.xml").async("string"), />Ein Kriminalroman</);
});

test("the blurb has one home: the cover spec reads it, and a new one is kept", async (t) => {
  const { dir, api } = await newProject(t);
  const spec = {
    targetPlatform: "paperback",
    mood: "dunkel",
    colorPalette: ["grau"],
    typography: { titleFont: "Serif", authorFont: "Serif" },
    imagery: "Hafen",
    style: "Foto",
  };

  // A blurb given to the cover spec becomes the description when there is none.
  const first = await callJson(api, "book_cover_create_spec", { ...spec, blurb: "Vom Cover." });
  assert.match(first.note, /also saved as the book's description/);
  assert.equal(stored(dir).description, "Vom Cover.");

  // Without one, the cover spec takes the description.
  await callJson(api, "book_metadata_set", { description: "Aus den Metadaten." });
  const second = await callJson(api, "book_cover_create_spec", spec);
  assert.equal(second.spec.backCover.blurb, "Aus den Metadaten.");
});

test("the dashboard's readiness lists the store metadata", async (t) => {
  const { api } = await newProject(t);
  const before = await callJson(api, "book_dashboard", {});
  const item = (data, name) => data.readiness.find((r) => r.item === name);
  assert.equal(item(before, "Keywords and categories").state, "needed");
  assert.equal(item(before, "Description / blurb").state, "needed");

  await callJson(api, "book_metadata_set", {
    description: "d",
    keywords: ["Hafen"],
    categories: ["Krimi"],
  });
  const after = await callJson(api, "book_dashboard", {});
  assert.equal(item(after, "Keywords and categories").state, "ready");
  assert.equal(item(after, "Description / blurb").state, "ready");
});
