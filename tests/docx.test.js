const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const JSZip = require("jszip");

const { collectTools, callJson } = require("./helpers/tools");
const { useTempProject, cleanup } = require("./helpers/project");

function tools() {
  const m = (n) => require(`../dist-tsc/tools/${n}`);
  return collectTools(
    m("manuscript").registerManuscriptTools,
    m("export").registerExportTools,
    m("epub").registerEpubTools
  );
}

async function newProject(t) {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const api = tools();
  await callJson(api, "book_init", { title: "Der Hafen", author: "A. Autorin", genre: "Roman" });
  return { dir, api };
}

async function addChapter(api, title, content, status = "final") {
  const { chapterId } = await callJson(api, "book_chapter_create", {
    title,
    synopsis: "s",
    content,
  });
  await callJson(api, "book_chapter_update", { chapterId, status });
  return chapterId;
}

async function documentXml(file) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  return zip.file("word/document.xml").async("string");
}

// The visible text of the document, run by run, with paragraph boundaries.
function paragraphs(xml) {
  return [...xml.matchAll(/<w:p>([\s\S]*?)<\/w:p>|<w:p [^>]*>([\s\S]*?)<\/w:p>/g)].map((m) => {
    const inner = m[1] ?? m[2];
    return {
      xml: inner,
      text: [...inner.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((t) => t[1]).join(""),
    };
  });
}

const CHAPTER = `# Ankunft

Sie kam *spät* an, und **niemand** wartete.

Der zweite Absatz.

## Am Kai

Nach der Zwischenüberschrift.

* * *

> Liebe Mara,
> komm nicht.

Nach dem Brief.
`;

test("markdown becomes Word formatting, not literal asterisks and hashes", async (t) => {
  const { dir, api } = await newProject(t);
  await addChapter(api, "Ankunft", CHAPTER);

  const out = path.join(dir, "m.docx");
  await callJson(api, "book_export_docx", { outputPath: out });
  const xml = await documentXml(out);
  const paras = paragraphs(xml);
  const allText = paras.map((p) => p.text).join("\n");

  assert.ok(!allText.includes("*spät*"), "emphasis markers must not survive");
  assert.ok(!allText.includes("**"), "bold markers must not survive");
  assert.ok(!allText.includes("## "), "heading markers must not survive");
  assert.ok(!allText.includes("> "), "quote markers must not survive");
  assert.ok(!allText.includes("# Ankunft"), "the chapter's own heading line is replaced");

  // "spät" is its own italic run, "niemand" its own bold run.
  assert.match(xml, /<w:r><w:rPr><w:i\/><w:iCs\/><\/w:rPr><w:t xml:space="preserve">spät<\/w:t><\/w:r>/);
  assert.match(xml, /<w:r><w:rPr><w:b\/><w:bCs\/><\/w:rPr><w:t xml:space="preserve">niemand<\/w:t><\/w:r>/);

  const sub = paras.find((p) => p.text === "Am Kai");
  assert.ok(sub, "the subheading is a paragraph of its own");
  assert.match(sub.xml, /<w:pStyle w:val="Heading2"\/>/);

  const sceneBreak = paras.find((p) => /^\*\s+\*\s+\*$/.test(p.text));
  assert.ok(sceneBreak, "the scene break is a centred ornament");
  assert.match(sceneBreak.xml, /<w:jc w:val="center"\/>/);

  const quote = paras.find((p) => p.text.startsWith("Liebe Mara,"));
  assert.ok(quote, "the quote is a paragraph");
  assert.match(quote.xml, /<w:ind w:left="720" w:right="720"\/>/);
  assert.match(quote.xml, /<w:br\/>/, "the line break inside the quote is kept");
});

test("the first paragraph after a heading or break starts flush, the rest are indented", async (t) => {
  const { dir, api } = await newProject(t);
  await addChapter(api, "Ankunft", CHAPTER);

  const out = path.join(dir, "m.docx");
  await callJson(api, "book_export_docx", { outputPath: out });
  const paras = paragraphs(await documentXml(out));
  const indent = (text) =>
    /w:firstLine="360"/.test(paras.find((p) => p.text.startsWith(text)).xml);

  assert.equal(indent("Sie kam"), false);
  assert.equal(indent("Der zweite Absatz"), true);
  assert.equal(indent("Nach der Zwischenüberschrift"), false);
  assert.equal(indent("Nach dem Brief"), false);
});

test("every chapter starts on a new page", async (t) => {
  const { dir, api } = await newProject(t);
  await addChapter(api, "Eins", "# Eins\n\nA.");
  await addChapter(api, "Zwei", "# Zwei\n\nB.");
  await addChapter(api, "Drei", "# Drei\n\nC.");

  const out = path.join(dir, "m.docx");
  await callJson(api, "book_export_docx", { outputPath: out });
  const paras = paragraphs(await documentXml(out));

  for (const title of ["Eins", "Zwei", "Drei"]) {
    const heading = paras.filter((p) => p.text === title).pop();
    assert.match(heading.xml, /<w:pageBreakBefore\/>/, `${title} starts a page`);
    assert.match(heading.xml, /<w:pStyle w:val="Heading1"\/>/);
  }
});

test("DOCX, Markdown and EPUB choose the same chapters", async (t) => {
  const { dir, api } = await newProject(t);
  await addChapter(api, "Fertig", "# Fertig\n\nReady prose.", "final");
  await addChapter(api, "Entwurf", "# Entwurf\n\nDraft prose.", "draft");
  await addChapter(api, "Lektorat", "# Lektorat\n\nReview prose.", "review");

  const md = await callJson(api, "book_export_markdown", {
    outputPath: path.join(dir, "m.md"),
  });
  const docx = await callJson(api, "book_export_docx", {
    outputPath: path.join(dir, "m.docx"),
  });
  const epub = await callJson(api, "book_export_epub", {
    outputPath: path.join(dir, "m.epub"),
  });

  assert.equal(md.chaptersIncluded, 2);
  assert.equal(docx.chaptersIncluded, 2);
  assert.equal(epub.chaptersIncluded, 2);
  assert.match(docx.selection, /1 outline\/draft chapter\(s\) left out/);

  const text = paragraphs(await documentXml(path.join(dir, "m.docx")))
    .map((p) => p.text)
    .join("\n");
  assert.ok(!text.includes("Draft prose."), "a draft is not exported when others are ready");
});

test("includeChapters picks chapters by id or title, and rejects unknown ones", async (t) => {
  const { dir, api } = await newProject(t);
  await addChapter(api, "Eins", "# Eins\n\nA.");
  const zwei = await addChapter(api, "Zwei", "# Zwei\n\nB.");

  const out = path.join(dir, "m.docx");
  const byTitle = await callJson(api, "book_export_docx", {
    outputPath: out,
    includeChapters: ["Eins"],
  });
  assert.equal(byTitle.chaptersIncluded, 1);

  const byId = await callJson(api, "book_export_markdown", {
    outputPath: path.join(dir, "m.md"),
    includeChapters: [zwei],
  });
  assert.equal(byId.chaptersIncluded, 1);

  await assert.rejects(
    callJson(api, "book_export_docx", { outputPath: out, includeChapters: ["Gibt es nicht"] }),
    /Unknown chapter IDs or titles: Gibt es nicht/
  );
});

test("an empty chapter is skipped and reported, not exported as a blank page", async (t) => {
  const { dir, api } = await newProject(t);
  await addChapter(api, "Eins", "# Eins\n\nA.");
  const leer = await addChapter(api, "Leer", "# Leer\n\nB.");
  fs.writeFileSync(
    path.join(dir, "chapters", fs.readdirSync(path.join(dir, "chapters")).find((f) => f.startsWith(leer))),
    ""
  );

  const result = await callJson(api, "book_export_docx", { outputPath: path.join(dir, "m.docx") });
  assert.equal(result.chaptersIncluded, 1);
  assert.match(result.warnings[0], /Leer/);
});

test("heading styles are overridden in place, not defined twice", async (t) => {
  const { dir, api } = await newProject(t);
  await addChapter(api, "Eins", "# Eins\n\n## Teil\n\nA.");
  const out = path.join(dir, "m.docx");
  await callJson(api, "book_export_docx", { outputPath: out, fontFamily: "Garamond" });

  const zip = await JSZip.loadAsync(fs.readFileSync(out));
  const styles = await zip.file("word/styles.xml").async("string");
  const ids = [...styles.matchAll(/w:styleId="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, [...new Set(ids)], "every style id is unique");

  const heading1 = styles.slice(styles.indexOf('w:styleId="Heading1"'));
  assert.match(heading1.slice(0, heading1.indexOf("</w:style>")), /Garamond/);
  assert.match(heading1.slice(0, heading1.indexOf("</w:style>")), /<w:color w:val="000000"\/>/);
});
