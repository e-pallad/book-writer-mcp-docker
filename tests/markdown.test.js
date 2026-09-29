const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const JSZip = require("jszip");

const {
  markdownToHtml,
  isSceneBreakLine,
  parseBlocks,
  inlineRuns,
} = require("../dist-tsc/utils/markdown");
const { collectTools, callJson } = require("./helpers/tools");
const { useTempProject, cleanup } = require("./helpers/project");

// Every way a scene break is commonly typed. Each one used to reach the
// italic rule, which turned "***" into <em>*</em> and "* * *" into an empty
// <em> followed by a stray asterisk.
const SCENE_BREAKS = ["***", "* * *", "---", "- - -", "___", "#", "⁂", "~ ~ ~", "• • •"];

for (const marker of SCENE_BREAKS) {
  test(`"${marker}" on its own line is a scene break, not emphasis`, () => {
    const html = markdownToHtml(`Before.\n\n${marker}\n\nAfter.`, { xhtml: true });
    assert.equal(html, "<p>Before.</p>\n<hr />\n<p>After.</p>");
  });
}

test("a scene break needs no blank lines around it", () => {
  const html = markdownToHtml("Before.\n***\nAfter.");
  assert.equal(html, "<p>Before.</p>\n<hr>\n<p>After.</p>");
});

test("things that look like scene breaks but are not stay prose", () => {
  for (const line of ["~~~", "**", "#hashtag", "* one item", "5 * 3 * 2"]) {
    assert.equal(isSceneBreakLine(line), false, line);
  }
  assert.equal(markdownToHtml("5 * 3 * 2 = 30"), "<p>5 * 3 * 2 = 30</p>");
});

test("a block quote renders as <blockquote>, across lines and paragraphs", () => {
  const html = markdownToHtml(
    "Sie las den Brief.\n\n> Liebe Mara,\n> ich komme nicht zurück.\n>\n> Dein K.\n\nSie faltete ihn.",
    { xhtml: true }
  );
  assert.equal(
    html,
    [
      "<p>Sie las den Brief.</p>",
      "<blockquote>",
      "<p>Liebe Mara,<br />ich komme nicht zurück.</p>",
      "<p>Dein K.</p>",
      "</blockquote>",
      "<p>Sie faltete ihn.</p>",
    ].join("\n")
  );
});

test("an epigraph with emphasis keeps its markup inside the quote", () => {
  const html = markdownToHtml("> *Alles fließt.*\n> — Heraklit");
  assert.equal(
    html,
    "<blockquote>\n<p><em>Alles fließt.</em><br>— Heraklit</p>\n</blockquote>"
  );
});

test("emphasis: italic, bold, both, underscores and escapes", () => {
  assert.equal(
    markdownToHtml("*kursiv* **fett** ***beides*** _unter_ __dick__"),
    "<p><em>kursiv</em> <strong>fett</strong> <strong><em>beides</em></strong> <em>unter</em> <strong>dick</strong></p>"
  );
  assert.equal(
    markdownToHtml("\\*kein Stern\\* und snake_case_name"),
    "<p>*kein Stern* und snake_case_name</p>"
  );
  assert.equal(
    markdownToHtml("**fett *mit kursiv* drin**"),
    "<p><strong>fett <em>mit kursiv</em> drin</strong></p>"
  );
});

test("emphasis never reaches across a paragraph break", () => {
  const html = markdownToHtml("Ein *Satz.\n\nNoch einer* hier.");
  assert.equal(html, "<p>Ein *Satz.</p>\n<p>Noch einer* hier.</p>");
});

test("a heading directly followed by prose is split from it", () => {
  const blocks = parseBlocks("# Titel\nErster Absatz.");
  assert.deepEqual(blocks, [
    { type: "heading", level: 1, text: "Titel" },
    { type: "paragraph", text: "Erster Absatz." },
  ]);
});

test("markup characters in prose are escaped", () => {
  assert.equal(
    markdownToHtml("a < b & c > d"),
    "<p>a &lt; b &amp; c &gt; d</p>"
  );
});

test("inline runs carry bold, italic and line breaks for word processors", () => {
  assert.deepEqual(inlineRuns("a *b*\n**c**"), [
    { text: "a ", bold: false, italic: false, breakBefore: false },
    { text: "b", bold: false, italic: true, breakBefore: false },
    { text: "c", bold: true, italic: false, breakBefore: true },
  ]);
});

// ---------------------------------------------------------------------------
// Through the tools

function tools() {
  const m = (n) => require(`../dist-tsc/tools/${n}`);
  return collectTools(
    m("manuscript").registerManuscriptTools,
    m("epub").registerEpubTools,
    m("preview").registerPreviewTools
  );
}

const SCENES = `# Der Hafen

Erste Szene.

* * *

Zweite Szene.

***

> Ein Brief, zitiert.

Dritte Szene.
`;

async function seed(t) {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const api = tools();
  await callJson(api, "book_init", { title: "T", author: "A", genre: "G" });
  await callJson(api, "book_chapter_create", {
    title: "Der Hafen",
    synopsis: "s",
    content: SCENES,
  });
  return { dir, api };
}

test("the preview shows scene breaks and quotes, not stray asterisks", async (t) => {
  const { dir, api } = await seed(t);
  await callJson(api, "book_preview", {});
  const html = fs.readFileSync(path.join(dir, "preview.html"), "utf-8");
  const body = html.slice(html.indexOf('<div class="book">'));

  assert.ok(!body.includes("<em>*</em>"));
  assert.ok(!body.includes("* * *"));
  assert.equal((body.match(/<hr>/g) || []).length >= 2, true);
  assert.match(body, /<blockquote>\n<p>Ein Brief, zitiert\.<\/p>\n<\/blockquote>/);
});

test("the EPUB carries scene breaks and quotes as valid XHTML", async (t) => {
  const { dir, api } = await seed(t);
  const out = path.join(dir, "book.epub");
  await callJson(api, "book_export_epub", { outputPath: out });

  const zip = await JSZip.loadAsync(fs.readFileSync(out));
  const chapter = await zip.file("OEBPS/chapter-001.xhtml").async("string");
  assert.equal((chapter.match(/<hr \/>/g) || []).length, 2);
  assert.ok(!chapter.includes("<em>"));
  assert.match(chapter, /<blockquote>/);

  const css = await zip.file("OEBPS/style.css").async("string");
  assert.match(css, /hr \+ p/, "the paragraph after a scene break is not indented");
  assert.match(css, /blockquote/);
});
