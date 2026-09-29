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
    m("project").registerProjectTools,
    m("storybible").registerStoryBibleTools,
    m("styleguide").registerStyleGuideTools,
    m("continuity").registerContinuityTools,
    m("timeline").registerTimelineTools,
    m("cover").registerCoverTools,
    m("export").registerExportTools,
    m("epub").registerEpubTools,
    m("preview").registerPreviewTools
  );
}

async function newProject(t, init = {}) {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const api = tools();
  const created = await callJson(api, "book_init", {
    title: "Der Hafen",
    author: "A. Autorin",
    genre: "Roman",
    ...init,
  });
  return { dir, api, created };
}

const GUIDE = {
  voice: "close",
  pov: "third person limited",
  tense: "past",
  tone: "cool",
  targetAudience: "adult",
  sentenceStyle: "lean",
  thingsToAvoid: ["suddenly"],
  recurringMotifs: [],
  samplePassage: "s",
};

const registry = (dir) =>
  JSON.parse(fs.readFileSync(path.join(dir, ".book-mcp", "registry.json"), "utf-8"));

test("book_init stores the language, English by default", async (t) => {
  const withDefault = await newProject(t);
  assert.equal(registry(withDefault.dir).language, "en");
  assert.match(withDefault.created.language, /English rules/);

  const german = await newProject(t, { language: "de-AT" });
  assert.equal(registry(german.dir).language, "de-AT");
});

test("book_init rejects something that is not a language tag", async (t) => {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  await assert.rejects(
    callJson(tools(), "book_init", { title: "T", author: "A", genre: "G", language: "Deutsch!" }),
    /not a language tag/
  );
});

test("book_project_update changes the book's details", async (t) => {
  const { dir, api } = await newProject(t);
  const result = await callJson(api, "book_project_update", {
    title: "Das Hafenlicht",
    targetWordCount: 95000,
    language: "de",
  });

  assert.deepEqual(result.changed.title, { from: "Der Hafen", to: "Das Hafenlicht" });
  assert.deepEqual(result.changed.language, { from: "en", to: "de" });
  const stored = registry(dir);
  assert.equal(stored.title, "Das Hafenlicht");
  assert.equal(stored.targetWordCount, 95000);
  assert.equal(stored.language, "de");
  assert.equal(stored.author, "A. Autorin", "fields not passed are untouched");
});

test("book_project_update refuses nonsense and says when the cover disagrees", async (t) => {
  const { api } = await newProject(t);
  await assert.rejects(callJson(api, "book_project_update", {}), /Nothing to update/);
  await assert.rejects(callJson(api, "book_project_update", { title: "  " }), /cannot be empty/);
  await assert.rejects(
    callJson(api, "book_project_update", { targetWordCount: -5 }),
    /positive/
  );
  await assert.rejects(
    callJson(api, "book_project_update", { language: "german language" }),
    /not a language tag/
  );

  await callJson(api, "book_cover_create_spec", {
    targetPlatform: "kindle",
    mood: "dark",
    colorPalette: ["navy"],
    typography: { titleFont: "serif", authorFont: "serif" },
    imagery: "sea",
    style: "photographic",
  });
  const result = await callJson(api, "book_project_update", { title: "Neu" });
  assert.match(result.notes.join(" "), /cover spec still says "Der Hafen"/);
});

test("the EPUB declares the project's language unless told otherwise", async (t) => {
  const { dir, api } = await newProject(t, { language: "de" });
  await callJson(api, "book_chapter_create", { title: "Eins", synopsis: "s", content: "# Eins\n\nText." });

  const out = path.join(dir, "b.epub");
  const result = await callJson(api, "book_export_epub", { outputPath: out });
  assert.equal(result.metadata.language, "de");

  const zip = await JSZip.loadAsync(fs.readFileSync(out));
  const opf = await zip.file("OEBPS/content.opf").async("string");
  assert.match(opf, /<dc:language>de<\/dc:language>/);
  const nav = await zip.file("OEBPS/nav.xhtml").async("string");
  assert.match(nav, /<h1>Inhalt<\/h1>/);
  assert.match(nav, /xml:lang="de"/);

  const overridden = await callJson(api, "book_export_epub", { outputPath: out, language: "en-GB" });
  assert.equal(overridden.metadata.language, "en-GB");
});

test("the DOCX is marked with the book's language and labelled in it", async (t) => {
  const { dir, api } = await newProject(t, { language: "de" });
  await callJson(api, "book_chapter_create", { title: "Eins", synopsis: "s", content: "# Eins\n\nText." });

  const out = path.join(dir, "m.docx");
  await callJson(api, "book_export_docx", { outputPath: out });
  const zip = await JSZip.loadAsync(fs.readFileSync(out));
  const styles = await zip.file("word/styles.xml").async("string");
  assert.match(styles, /<w:lang w:val="de-DE"\/>/);
  const doc = await zip.file("word/document.xml").async("string");
  assert.match(doc, />Inhalt</);
  assert.match(doc, />von A\. Autorin</);
});

test("the preview page carries the book's language", async (t) => {
  const { dir, api } = await newProject(t, { language: "de" });
  await callJson(api, "book_chapter_create", { title: "Eins", synopsis: "s", content: "# Eins\n\nText." });
  await callJson(api, "book_preview", {});
  assert.match(fs.readFileSync(path.join(dir, "preview.html"), "utf-8"), /<html lang="de">/);
});

test("a language without rules is reported as partially checked, not clean", async (t) => {
  const { api } = await newProject(t, { language: "fr" });
  await callJson(api, "book_style_set", GUIDE);

  const checked = await callJson(api, "book_style_check", {
    passage: "Il marchait vers le port. Elle dit qu'il pleuvait.",
  });
  assert.equal(checked.score, "partially_checked");
  assert.deepEqual(checked.checksSkipped, ["tense", "pointOfView", "passiveVoice"]);
  assert.match(checked.languageNote, /No fr rules/);

  // Language-independent checks still run.
  const avoided = await callJson(api, "book_style_check", { passage: "Il partit suddenly." });
  assert.ok(avoided.violations.some((v) => /suddenly/.test(v.rule)));
});

test("the continuity check says which checks a language without rules skipped", async (t) => {
  const { api } = await newProject(t, { language: "fr" });
  const { chapterId } = await callJson(api, "book_chapter_create", {
    title: "Un",
    synopsis: "s",
    content: "# Un\n\n« Viens », dit Jacques.",
  });
  const checked = await callJson(api, "book_continuity_check", { chapterId: "Un" });
  assert.ok(checked.checksSkipped.includes("unregisteredCharacters"));
  assert.ok(checked.checksSkipped.includes("traitContradictions"));
  assert.match(checked.summary, /did not run/);
  assert.equal(chapterId, "ch-001");
});

test("a project from before the language field is treated as English, and told so", async (t) => {
  const { dir, api } = await newProject(t);
  const file = path.join(dir, ".book-mcp", "registry.json");
  const legacy = registry(dir);
  delete legacy.language;
  fs.writeFileSync(file, JSON.stringify(legacy));

  await callJson(api, "book_style_set", GUIDE);
  const checked = await callJson(api, "book_style_check", { passage: "He walks home." });
  assert.equal(checked.language, "en");
  assert.match(checked.languageNote, /no language set/);
  assert.ok(checked.violations.some((v) => /Tense/.test(v.rule)), "English rules still run");
});

test("dialogue is exempt from the tense and point-of-view rules", async (t) => {
  const { api } = await newProject(t);
  await callJson(api, "book_style_set", GUIDE);

  const speech = await callJson(api, "book_style_check", {
    passage: '"I thought you had gone," she said. "He says the boat is late."',
  });
  assert.deepEqual(speech.styleViolations, [], JSON.stringify(speech.styleViolations));

  const narration = await callJson(api, "book_style_check", {
    passage: "I thought the harbour was empty. He says nothing.",
  });
  const rules = narration.styleViolations.map((v) => v.rule).join(" | ");
  assert.match(rules, /POV/);
  assert.match(rules, /Tense/);
});
