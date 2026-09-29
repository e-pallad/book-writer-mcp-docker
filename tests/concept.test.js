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
    m("concept").registerConceptTools,
    m("storybible").registerStoryBibleTools,
    m("metadata").registerMetadataTools,
    m("author").registerAuthorTools
  );
}

async function newProject(t, language = "de") {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const api = tools();
  await callJson(api, "book_init", { title: "Der Hafen", author: "Anna Autorin", genre: "Kriminalroman", language, targetWordCount: 80000 });
  return { dir, api };
}

test("the concept is saved, cleared by an empty value, and reviewed", async (t) => {
  const { api } = await newProject(t);
  const saved = await callJson(api, "book_concept_set", {
    bookType: "fiction",
    premise: "Eine Hafeninspektorin findet einen Toten, der ihr Bruder sein könnte.",
    logline: "Eine Inspektorin muss einen Mord aufklären. Der Tote ist vielleicht ihr Bruder. Und niemand hilft ihr.",
    comparableTitles: [{ title: "Tannöd", author: "Andrea Maria Schenkel" }],
  });
  assert.deepEqual(saved.missingForExpose, ["targetAudience"]);
  assert.match(saved.advice.join(" "), /A logline is one sentence/);
  assert.match(saved.advice.join(" "), /Say for each comparable title/);

  const cleared = await callJson(api, "book_concept_set", { premise: "" });
  assert.equal(cleared.concept.premise, undefined);
  assert.ok(cleared.missingForExpose.includes("premise"));

  await assert.rejects(callJson(api, "book_concept_set", {}), /Nothing to set/);
});

test("non-fiction asks for an argument and a promise instead of a premise", async (t) => {
  const { api } = await newProject(t);
  const saved = await callJson(api, "book_concept_set", { bookType: "nonfiction", logline: "Wie Häfen Städte bauen." });
  assert.deepEqual(saved.missingForExpose, ["coreThesis", "readerPromise", "targetAudience", "comparableTitles"]);
});

async function fullProject(t, language = "de") {
  const ctx = await newProject(t, language);
  const { api } = ctx;
  await callJson(api, "book_concept_set", {
    bookType: "fiction",
    premise: "Eine Hafeninspektorin findet einen Toten.",
    logline: "Eine Inspektorin jagt den Mörder ihres Bruders durch den Hamburger Hafen.",
    centralQuestion: "Wer hat Jonas getötet?",
    targetAudience: "Leser·innen von Regionalkrimis",
    comparableTitles: [{ title: "Tannöd", author: "Andrea Maria Schenkel", year: 2006, why: "dichte Atmosphäre" }],
    uniqueSellingPoint: "Der Hafen als Figur.",
  });
  await callJson(api, "book_theme_add", { name: "Schuld", description: "Wer trägt sie?" });
  await callJson(api, "book_character_add", {
    name: "Mara Vance",
    role: "protagonist",
    description: "Inspektorin am Hafen. Hat ein Geheimnis.",
  });
  await callJson(api, "book_author_update_profile", { name: "Anna Autorin", summary: "Lebt in Hamburg." });
  await callJson(api, "book_author_update_intro", { fullIntro: "Anna Autorin lebt und schreibt in Hamburg." });
  const paragraph = "Wort ".repeat(18).trim();
  for (let i = 1; i <= 4; i++) {
    await callJson(api, "book_chapter_create", {
      title: `Kapitel ${i}`,
      synopsis: i === 4 ? "" : `Was in Kapitel ${i} geschieht.`,
      content: `# Kapitel ${i}\n\n${Array(200).fill(paragraph).join("\n\n")}\n`,
    });
  }
  return ctx;
}

test("the exposé is written from the project, in the book's language, gaps marked", async (t) => {
  const { dir, api } = await fullProject(t);
  const result = await callJson(api, "book_expose_generate", { includeSample: false });
  const md = fs.readFileSync(result.outputPath, "utf-8");

  for (const expected of [
    "# Exposé: Der Hafen",
    "**Genre:** Kriminalroman",
    `ca. ${result.extent.normPages} Normseiten`,
    "**Zielgruppe:** Leser·innen von Regionalkrimis",
    "**Stand:** in Arbeit (0 von 4 Kapiteln abgeschlossen)",
    "## Pitch\n\nEine Inspektorin jagt den Mörder",
    "## Prämisse",
    "## Zentrale Frage\n\nWer hat Jonas getötet?",
    "- **Schuld** — Wer trägt sie?",
    "- **Kapitel 1 – Kapitel 1:** Was in Kapitel 1 geschieht.",
    "- **Mara Vance** (Hauptfigur) — Inspektorin am Hafen. Hat ein Geheimnis.",
    "- *Tannöd* — Andrea Maria Schenkel (2006): dichte Atmosphäre",
    "## Was dieses Buch besonders macht",
    "## Zur Person\n\nAnna Autorin lebt und schreibt in Hamburg.",
  ]) {
    assert.ok(md.includes(expected), `missing "${expected}" in:\n${md}`);
  }
  assert.match(md, /\[TODO: Zusammenfassung fehlt — book_chapter_update synopsis=…\]/, "a chapter without a synopsis is marked");
  assert.ok(result.missing.some((m) => /Inhalt \(1\)/.test(m)), JSON.stringify(result.missing));
  assert.equal(path.dirname(result.outputPath), dir);
});

test("the sample is whole chapters from the start, as a Normseite manuscript", async (t) => {
  const { dir, api } = await fullProject(t);
  const result = await callJson(api, "book_expose_generate", { samplePages: 10, contact: ["Anna Autorin"] });
  assert.ok(result.sample.chapters >= 1 && result.sample.chapters < 4, JSON.stringify(result.sample));
  assert.equal(result.sample.file, path.join(dir, "leseprobe.docx"));

  const zip = await JSZip.loadAsync(fs.readFileSync(result.sample.file));
  const doc = await zip.file("word/document.xml").async("string");
  assert.match(doc, /Leseprobe, ca\. \d+ Normseiten/);
  assert.match(await zip.file("word/styles.xml").async("string"), /Courier New/);

  const md = fs.readFileSync(result.outputPath, "utf-8");
  assert.match(md, /## Leseprobe\n\nBeiliegend: die ersten \d Kapitel|## Leseprobe\n\nBeiliegend: das erste Kapitel/);
});

test("an English project gets a proposal in English with a Standard Manuscript sample", async (t) => {
  const { api } = await newProject(t, "en");
  await callJson(api, "book_chapter_create", { title: "One", synopsis: "It begins.", content: "# One\n\nWords here.\n" });
  const result = await callJson(api, "book_expose_generate", {});
  const md = fs.readFileSync(result.outputPath, "utf-8");
  assert.match(md, /^# Book Proposal: Der Hafen/);
  assert.match(md, /\[TODO: Logline missing — book_concept_set logline=…\]/);
  assert.match(result.sample.file, /sample\.docx$/);
  assert.ok(result.missing.includes("Logline"));
});
