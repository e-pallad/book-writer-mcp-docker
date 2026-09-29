const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const JSZip = require("jszip");

const { collectTools, callJson } = require("./helpers/tools");
const { useTempProject, cleanup } = require("./helpers/project");
const { NORMSEITE, wrappedLines } = require("../dist-tsc/export/normseite");

function tools() {
  const m = (n) => require(`../dist-tsc/tools/${n}`);
  return collectTools(
    m("manuscript").registerManuscriptTools,
    m("export").registerExportTools,
    m("matter").registerMatterTools
  );
}

async function newProject(t, language = "de") {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const api = tools();
  await callJson(api, "book_init", { title: "Der Hafen", author: "Anna Autorin", genre: "Roman", language });
  return { dir, api };
}

async function docx(file) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const read = (name) => zip.file(name)?.async("string");
  return {
    document: await read("word/document.xml"),
    styles: await read("word/styles.xml"),
    headers: await Promise.all(
      Object.keys(zip.files)
        .filter((n) => /^word\/header\d+\.xml$/.test(n))
        .map((n) => read(n))
    ),
  };
}

const text = (xml) => [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]);

// ---------------------------------------------------------------------------
// Geometry and counting

test("the page holds exactly 60 characters and 30 lines", () => {
  const textWidth = 11906 - NORMSEITE.marginLeft - NORMSEITE.marginRight;
  assert.equal(textWidth, 60 * 144, "60 Courier New characters at 12 pt");
  const textHeight = 16838 - NORMSEITE.marginTop - NORMSEITE.marginBottom;
  assert.ok(30 * NORMSEITE.lineTwips <= textHeight, "30 lines fit");
  assert.ok(31 * NORMSEITE.lineTwips > textHeight, "a 31st does not");
});

test("words wrap at the line width, as a typewriter would", () => {
  assert.equal(wrappedLines("a ".repeat(30).trim(), 60), 1, "59 characters: one line");
  assert.equal(wrappedLines("a ".repeat(31).trim(), 60), 2, "61 characters: two");
  assert.equal(wrappedLines("x".repeat(130), 60), 3, "a word longer than a line breaks across lines");
  assert.equal(wrappedLines("eins\nzwei\ndrei", 60), 3, "hard line breaks count");
  assert.equal(wrappedLines("", 60), 1, "an empty paragraph still takes a line");
  // The indent takes three characters from the first line.
  const fiftyNine = "b".repeat(29) + " " + "c".repeat(29);
  assert.equal(wrappedLines(fiftyNine, 60), 1);
  assert.equal(wrappedLines(fiftyNine, 60, 57), 2);
});

test("book_stats reports the extent in Normseiten", async (t) => {
  const { api } = await newProject(t);
  // A chapter of 30 paragraphs of two lines each: 6 lines of opening plus 60
  // of text is 66 lines, three pages.
  const paragraph = "Wort ".repeat(19).trim(); // 94 characters
  await callJson(api, "book_chapter_create", {
    title: "Eins",
    synopsis: "s",
    content: `# Eins\n\n${Array(30).fill(paragraph).join("\n\n")}\n`,
  });
  await callJson(api, "book_chapter_create", { title: "Zwei", synopsis: "s", content: "# Zwei\n\nKurz.\n" });

  const stats = await callJson(api, "book_stats", {});
  assert.equal(stats.normPages, 3 + 1, "each chapter starts a new page");
  assert.ok(stats.charactersWithSpaces > 30 * 94);
});

// ---------------------------------------------------------------------------
// The Normseite export

async function manuscriptProject(t, language) {
  const ctx = await newProject(t, language);
  await callJson(ctx.api, "book_chapter_create", {
    title: "Eins",
    synopsis: "s",
    content: "# Eins\n\nSie kam *spät*.\n\n* * *\n\nDer zweite Absatz.\n",
  });
  await callJson(ctx.api, "book_matter_set", { type: "dedication", content: "Für M." });
  return ctx;
}

test("the Normseite: A4, Courier New, 60 × 30, a running head and a cover sheet", async (t) => {
  const { dir, api } = await manuscriptProject(t);
  const out = path.join(dir, "ns.docx");
  const result = await callJson(api, "book_export_docx", {
    outputPath: out,
    preset: "normseite",
    fontSize: 14,
    contact: ["Anna Autorin", "Hafenstraße 1", "anna@example.org"],
  });
  assert.equal(result.preset, "normseite");
  assert.match(result.notes.join(" "), /fixes these.*fontSize/);
  assert.match(result.notes.join(" "), /Front and back matter are left out/);

  const { document, styles, headers } = await docx(out);
  assert.match(document, /<w:pgSz w:w="11906" w:h="16838"/);
  assert.match(document, new RegExp(`w:right="${NORMSEITE.marginRight}"`));
  assert.match(document, new RegExp(`w:left="${NORMSEITE.marginLeft}"`));
  assert.match(document, new RegExp(`<w:spacing w:line="${NORMSEITE.lineTwips}" w:lineRule="exact" w:after="0"/>`));
  assert.match(document, /<w:widowControl w:val="false"\/>/);
  assert.match(document, /<w:titlePg\/>/, "no running head on the cover sheet");
  assert.match(styles, /Courier New/);
  assert.match(styles, /<w:sz w:val="24"\/>/, "12 pt, whatever was asked");

  const words = text(document);
  assert.equal(words[0], "Anna Autorin");
  assert.equal(result.extent.normPages, 1);
  assert.equal(words[1], "\tca. 1 Normseite", "singular for one page");
  assert.ok(words.includes("DER HAFEN"));
  assert.ok(!words.includes("Für M."), "the dedication is not part of a submission");
  assert.ok(words.includes("*"), "a scene break is a single asterisk");

  const head = headers.find((h) => h.includes("Anna Autorin · Der Hafen"));
  assert.ok(head, "the running head names author and title");
  assert.match(head, /PAGE/);
});

test("the Standard Manuscript Format: Letter, double-spaced, Surname / TITLE / page, #, END", async (t) => {
  const { dir, api } = await manuscriptProject(t, "en");
  const out = path.join(dir, "smf.docx");
  const result = await callJson(api, "book_export_docx", {
    outputPath: out,
    preset: "standard_manuscript",
    fontFamily: "Courier New",
  });
  assert.equal(result.settings.page, "US Letter");
  assert.equal(result.settings.fontFamily, "Courier New");

  const { document, headers } = await docx(out);
  assert.match(document, /<w:pgSz w:w="12240" w:h="15840"/);
  assert.match(document, /w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/);
  assert.match(document, /w:line="480"/);

  const words = text(document);
  assert.equal(words[1], "\tabout 100 words");
  assert.ok(words.includes("#"));
  assert.equal(words.at(-1), "END");
  assert.ok(headers.some((h) => h.includes("Autorin / HAFEN / ")), headers.join("\n"));

  await assert.rejects(
    callJson(api, "book_export_docx", { outputPath: out, preset: "standard_manuscript", fontFamily: "Comic Sans MS" }),
    /Courier New" or "Times New Roman/
  );
});

test("the book preset is unchanged: contents, dedication, footer page numbers", async (t) => {
  const { dir, api } = await manuscriptProject(t);
  const out = path.join(dir, "book.docx");
  const result = await callJson(api, "book_export_docx", { outputPath: out });
  assert.equal(result.preset, "book");
  const { document } = await docx(out);
  const words = text(document);
  assert.ok(words.includes("Inhalt"));
  assert.ok(words.includes("Für M."));
  assert.doesNotMatch(document, /<w:titlePg\/>/);
});
