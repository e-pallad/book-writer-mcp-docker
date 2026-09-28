const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const JSZip = require("jszip");

const { collectTools, callJson } = require("./helpers/tools");
const { useTempProject, cleanup } = require("./helpers/project");
const { runEpubcheck, locateEpubcheck } = require("./helpers/epubcheck");

function tools() {
  const m = (n) => require(`../dist-tsc/tools/${n}`);
  return collectTools(
    m("manuscript").registerManuscriptTools,
    m("author").registerAuthorTools,
    m("epub").registerEpubTools
  );
}

async function newProject(t, overrides = {}) {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const api = tools();
  await callJson(api, "book_init", {
    title: overrides.title ?? "The Harbour Light",
    author: overrides.author ?? "Registry Author",
    genre: overrides.genre ?? "Literary Fiction",
  });
  return { dir, api };
}

async function addChapters(api, chapters) {
  const ids = [];
  for (const chapter of chapters) {
    const created = await callJson(api, "book_chapter_create", {
      title: chapter.title,
      synopsis: "s",
      content: chapter.content,
    });
    await callJson(api, "book_chapter_update", {
      chapterId: created.chapterId,
      status: chapter.status ?? "final",
    });
    ids.push(created.chapterId);
  }
  return ids;
}

const readZip = async (epubPath) => JSZip.loadAsync(fs.readFileSync(epubPath));

test("the exported EPUB passes epubcheck", async (t) => {
  const { dir, api } = await newProject(t, {
    // Characters that break naive XML generation: a quote, an ampersand and
    // non-ASCII letters in the metadata.
    title: 'The "Good" Son & Other Stories',
  });
  await addChapters(api, [
    {
      title: "Ankunft & Abschied",
      content:
        "# Ankunft & Abschied\n\nSie stieg aus dem Zug in den Regen.\nDer Bahnsteig war leer.\n\n---\n\n**Später** trank sie *Kaffee* mit ***Zucker***.\n",
    },
    {
      title: "A Chapter With <Angle> Brackets",
      content: "## Just a subheading\n\nThis chapter has no h1 of its own.\n",
    },
  ]);

  const out = path.join(dir, "manuscript.epub");
  await callJson(api, "book_export_epub", {
    outputPath: out,
    language: "de",
    description: 'A blurb with "quotes" & an ampersand.',
  });

  const result = runEpubcheck(out);
  if (!result.available) {
    t.diagnostic(
      "epubcheck not found — set EPUBCHECK_JAR to run the authoritative validator. " +
        "The structural checks in this file still ran."
    );
    t.skip("epubcheck unavailable");
    return;
  }

  assert.ok(
    result.ok && /No errors or warnings detected/.test(result.output),
    `epubcheck reported problems:\n${result.output}`
  );
});

test("the archive is laid out the way the specification requires", async (t) => {
  const { dir, api } = await newProject(t);
  await addChapters(api, [
    { title: "One", content: "# One\n\nbody\n" },
    { title: "Two", content: "# Two\n\nbody\n" },
  ]);

  const out = path.join(dir, "manuscript.epub");
  await callJson(api, "book_export_epub", { outputPath: out });

  const raw = fs.readFileSync(out);

  // "mimetype" must be the first entry, stored uncompressed, so a reader can
  // identify the file by reading a fixed offset. Bytes 30..37 are the name and
  // bytes 8..9 are the compression method of the first local file header.
  assert.equal(raw.subarray(30, 38).toString("ascii"), "mimetype");
  assert.equal(raw.readUInt16LE(8), 0, "mimetype must be STORED, not deflated");
  assert.equal(
    raw.subarray(38, 38 + "application/epub+zip".length).toString("ascii"),
    "application/epub+zip"
  );

  const zip = await readZip(out);
  for (const required of [
    "mimetype",
    "META-INF/container.xml",
    "OEBPS/content.opf",
    "OEBPS/nav.xhtml",
    "OEBPS/toc.ncx",
    "OEBPS/titlepage.xhtml",
  ]) {
    assert.ok(zip.file(required), `missing required entry: ${required}`);
  }
});

test("metadata is correct, and the author comes from the profile when there is one", async (t) => {
  const { dir, api } = await newProject(t, { author: "Registry Author" });
  await addChapters(api, [{ title: "One", content: "# One\n\nbody\n" }]);

  const out = path.join(dir, "manuscript.epub");

  // With no profile, the registry's author is used.
  const withoutProfile = await callJson(api, "book_export_epub", { outputPath: out });
  assert.equal(withoutProfile.metadata.author, "Registry Author");
  assert.equal(withoutProfile.metadata.authorSource, "registry.json");

  // A profile takes precedence.
  const { getAuthorProfile, saveAuthorProfile } = require("../dist-tsc/storage/filestore");
  await callJson(api, "book_author_update_profile", { headline: "Novelist" });
  const profile = getAuthorProfile();
  profile.name = "Émile Ø'Brien-Müller";
  saveAuthorProfile(profile);

  const withProfile = await callJson(api, "book_export_epub", {
    outputPath: out,
    identifier: "urn:isbn:9780000000000",
  });
  assert.equal(withProfile.metadata.author, "Émile Ø'Brien-Müller");
  assert.equal(withProfile.metadata.authorSource, "author-profile.json");
  assert.equal(withProfile.metadata.identifier, "urn:isbn:9780000000000");

  const zip = await readZip(out);
  const opf = await zip.file("OEBPS/content.opf").async("string");
  assert.match(opf, /<dc:creator id="author">Émile Ø'Brien-Müller<\/dc:creator>/);
  assert.match(opf, /<dc:identifier id="book-id">urn:isbn:9780000000000<\/dc:identifier>/);
  // dcterms:modified must be to the second, with no fractional part.
  assert.match(opf, /<meta property="dcterms:modified">\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z<\/meta>/);
});

test("the table of contents is generated from the chapter titles, in order", async (t) => {
  const { dir, api } = await newProject(t);
  await addChapters(api, [
    { title: "The Arrival", content: "# The Arrival\n\nbody\n" },
    { title: "The Inquest", content: "# The Inquest\n\nbody\n" },
    { title: "The Harbour", content: "# The Harbour\n\nbody\n" },
  ]);

  const out = path.join(dir, "manuscript.epub");
  const result = await callJson(api, "book_export_epub", { outputPath: out });

  assert.deepEqual(
    result.tableOfContents.map((e) => e.title),
    ["The Arrival", "The Inquest", "The Harbour"]
  );

  const zip = await readZip(out);
  const nav = await zip.file("OEBPS/nav.xhtml").async("string");
  assert.match(nav, /epub:type="toc"/);
  for (const title of ["The Arrival", "The Inquest", "The Harbour"]) {
    assert.ok(nav.includes(title), `nav.xhtml should list "${title}"`);
  }
  // Order is preserved in the navigation document.
  assert.ok(
    nav.indexOf("The Arrival") < nav.indexOf("The Inquest") &&
      nav.indexOf("The Inquest") < nav.indexOf("The Harbour")
  );

  // And the spine reads in the same order.
  const opf = await zip.file("OEBPS/content.opf").async("string");
  const spine = opf.slice(opf.indexOf("<spine"));
  assert.ok(
    spine.indexOf("chapter-1") < spine.indexOf("chapter-2") &&
      spine.indexOf("chapter-2") < spine.indexOf("chapter-3")
  );
});

test("chapter markdown is rendered as XHTML, not HTML", async (t) => {
  const { dir, api } = await newProject(t);
  await addChapters(api, [
    {
      title: "Breaks",
      content: "# Breaks\n\nLine one\nLine two\n\n---\n\nAfter the rule.\n",
    },
  ]);

  const out = path.join(dir, "manuscript.epub");
  await callJson(api, "book_export_epub", { outputPath: out });

  const zip = await readZip(out);
  const chapter = await zip.file("OEBPS/chapter-001.xhtml").async("string");

  // Unclosed void elements are a parse error in XHTML, which is what makes
  // the difference between a valid EPUB and one readers reject.
  assert.match(chapter, /<br \/>/);
  assert.match(chapter, /<hr \/>/);
  assert.ok(!/<br>/.test(chapter), "bare <br> is not valid XHTML");
  assert.ok(!/<hr>/.test(chapter), "bare <hr> is not valid XHTML");
  assert.match(chapter, /^<\?xml version="1\.0" encoding="utf-8"\?>/);
  assert.match(chapter, /xmlns="http:\/\/www\.w3\.org\/1999\/xhtml"/);
});

test("a chapter with no heading of its own still gets one", async (t) => {
  const { dir, api } = await newProject(t);
  await addChapters(api, [
    { title: "Untitled Inside", content: "Just prose, no heading line.\n" },
  ]);

  const out = path.join(dir, "manuscript.epub");
  await callJson(api, "book_export_epub", { outputPath: out });

  const zip = await readZip(out);
  const chapter = await zip.file("OEBPS/chapter-001.xhtml").async("string");
  assert.match(chapter, /<h1>Untitled Inside<\/h1>/);
});

test("chapter selection matches book_export_markdown's", async (t) => {
  const { dir, api } = await newProject(t);
  await addChapters(api, [
    { title: "Done", content: "# Done\n\nbody\n", status: "final" },
    { title: "Reviewing", content: "# Reviewing\n\nbody\n", status: "review" },
    { title: "Rough", content: "# Rough\n\nbody\n", status: "draft" },
  ]);

  const out = path.join(dir, "manuscript.epub");

  // Default: final and review only.
  const auto = await callJson(api, "book_export_epub", { outputPath: out });
  assert.deepEqual(auto.tableOfContents.map((e) => e.title), ["Done", "Reviewing"]);

  // Explicit list wins.
  const explicit = await callJson(api, "book_export_epub", {
    outputPath: out,
    includeChapters: ["ch-003"],
  });
  assert.deepEqual(explicit.tableOfContents.map((e) => e.title), ["Rough"]);

  await assert.rejects(
    () => callJson(api, "book_export_epub", { outputPath: out, includeChapters: ["ch-999"] }),
    /Unknown chapter IDs/
  );
});

test("a project with nothing to export fails clearly", async (t) => {
  const { dir, api } = await newProject(t);
  await assert.rejects(
    () => callJson(api, "book_export_epub", { outputPath: path.join(dir, "x.epub") }),
    /No chapters to export/
  );
});

test("an empty chapter file is reported rather than silently shipped", async (t) => {
  const { dir, api } = await newProject(t);
  const ids = await addChapters(api, [
    { title: "Real", content: "# Real\n\nbody\n" },
    { title: "Hollow", content: "# Hollow\n\nplaceholder\n" },
  ]);

  // Empty the second chapter's file behind the tool's back.
  const registry = JSON.parse(
    fs.readFileSync(path.join(dir, ".book-mcp", "registry.json"), "utf-8")
  );
  const hollow = registry.chapters.find((c) => c.id === ids[1]);
  fs.writeFileSync(path.join(dir, "chapters", hollow.filename), "   \n");

  const out = path.join(dir, "manuscript.epub");
  const result = await callJson(api, "book_export_epub", { outputPath: out });

  assert.equal(result.chaptersIncluded, 1);
  assert.ok(result.warnings?.some((w) => /Hollow/.test(w)), JSON.stringify(result.warnings));
});
