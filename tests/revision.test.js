const test = require("node:test");
const assert = require("node:assert/strict");

const { collectTools, callJson } = require("./helpers/tools");
const { useTempProject, cleanup } = require("./helpers/project");
const { analyzeProse } = require("../dist-tsc/prose/analyze");
const { checkQuotes } = require("../dist-tsc/revision/stylesheet");
const { de } = require("../dist-tsc/lang/de");
const { en } = require("../dist-tsc/lang/en");

function tools() {
  const m = (n) => require(`../dist-tsc/tools/${n}`);
  return collectTools(
    m("manuscript").registerManuscriptTools,
    m("revision").registerRevisionTools,
    m("storybible").registerStoryBibleTools
  );
}

async function newProject(t, language = "de") {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const api = tools();
  await callJson(api, "book_init", { title: "T", author: "A", genre: "G", language });
  return { dir, api };
}

// ---------------------------------------------------------------------------
// Passes

test("each pass has a checklist in the book's language and the tools for it", async (t) => {
  const { api } = await newProject(t);
  const structural = await callJson(api, "book_revision_checklist", { pass: "structural" });
  assert.equal(structural.name, "Strukturelle Überarbeitung (Entwicklungslektorat)");
  assert.match(structural.order, /^1 of 4: structural → line → copy → proof$/);
  assert.ok(structural.checklist.some((q) => /Ziel, Konflikt und Ausgang/.test(q)));
  assert.ok(structural.tools.includes("book_structure_check"));

  const copy = await callJson(api, "book_revision_checklist", { pass: "copy" });
  assert.ok(copy.tools.includes("book_stylesheet_check"));
});

test("passes are marked per chapter, and a pass out of order is pointed out", async (t) => {
  const { api } = await newProject(t);
  for (const title of ["Eins", "Zwei", "Drei"]) {
    await callJson(api, "book_chapter_create", { title, synopsis: "s", content: `# ${title}\n\nText.` });
  }
  await callJson(api, "book_revision_mark", { pass: "structural", chapters: ["all"] });
  const early = await callJson(api, "book_revision_mark", { pass: "copy", chapters: ["Zwei"] });
  assert.match(early.warnings[0], /ch-002: copy marked before line/);

  await callJson(api, "book_revision_mark", { pass: "line", chapters: ["ch-001"], note: "gestrafft" });
  const status = await callJson(api, "book_revision_status", {});
  assert.deepEqual(status.progress, { structural: "3/3", line: "1/3", copy: "1/3", proof: "0/3" });
  assert.equal(status.next.pass, "line");
  assert.deepEqual(status.next.chapters, ["ch-002", "ch-003"]);
  assert.deepEqual(status.chapters[1].outOfOrder, ["copy"]);

  await callJson(api, "book_revision_mark", { pass: "copy", chapters: ["Zwei"], done: false });
  const after = await callJson(api, "book_revision_status", {});
  assert.equal(after.chapters[1].copy, false);
});

// ---------------------------------------------------------------------------
// Style sheet

test("the style sheet finds variant spellings across the book and says how to fix them", async (t) => {
  const { api } = await newProject(t);
  await callJson(api, "book_chapter_create", {
    title: "Eins",
    synopsis: "s",
    content: "# Eins\n\nSie schrieb eine Email. Dann noch eine eMail.\n",
  });
  await callJson(api, "book_chapter_create", {
    title: "Zwei",
    synopsis: "s",
    content: "# Zwei\n\nDie E-Mail kam an. Email-Adresse? Emails!\n",
  });
  await callJson(api, "book_stylesheet_add", { preferred: "E-Mail", variants: ["Email", "eMail", "E-Mail"] });
  const list = await callJson(api, "book_stylesheet_list", {});
  assert.deepEqual(list.entries[0].variants, ["Email", "eMail"], "the preferred form is not its own variant");

  const checked = await callJson(api, "book_stylesheet_check", {});
  const byVariant = Object.fromEntries(checked.variants.map((v) => [v.variant, v]));
  // Whole words: "Email-Adresse" counts ("-" ends the word), "Emails" does not.
  assert.equal(byVariant.Email.count, 2);
  assert.equal(byVariant.eMail.count, 1);
  assert.equal(byVariant.Email.fix, 'book_replace_text oldText="Email" newText="E-Mail" wholeWord=true');
  assert.equal(byVariant.Email.examples[0].chapterId, "ch-001");

  await callJson(api, "book_stylesheet_remove", { preferred: "E-Mail" });
  await assert.rejects(callJson(api, "book_stylesheet_remove", { preferred: "E-Mail" }), /not in the style sheet/);
});

test("mixed and typewriter quotation marks are reported", () => {
  const mixed = checkQuotes(["„Komm“, sagte sie. »Nein«, sagte er."], "de");
  assert.equal(mixed.mixed, true);
  assert.match(mixed.hints[0], /Choose one — „…“ or »…«/);

  const typewriter = checkQuotes(['"Come," she said. "Don\'t."'], "en");
  assert.equal(typewriter.typewriter.quotes, 2);
  assert.equal(typewriter.typewriter.apostrophes, 1);
  assert.ok(typewriter.hints.some((h) => /Only typewriter quotes/.test(h)));

  const clean = checkQuotes(["„Komm“, sagte sie. „Nein“, sagte er."], "de");
  assert.deepEqual(clean.hints, []);
});

// ---------------------------------------------------------------------------
// Prose

test("filler words, echoes and long sentences are found in German", () => {
  const text = [
    "Eigentlich wollte sie irgendwie nur kurz schauen. Eigentlich war es aber eigentlich egal.",
    "Die Tür war offen. Hinter der Tür stand ein Mann, und die Tür knarrte.",
    `${"Sie ging und ging ".repeat(12)}bis zum Hafen.`,
  ].join("\n\n");
  const report = analyzeProse(text, de, []);
  assert.equal(report.fillers[0].word, "eigentlich");
  assert.equal(report.fillers[0].count, 3);
  const tuer = report.repetitions.find((r) => r.word === "tür");
  assert.equal(tuer.closeRepeats, 2);
  assert.equal(tuer.example.paragraph, 2);
  assert.ok(report.sentences.longest[0].words >= 40);
  assert.ok(report.hints.some((h) => /sentence\(s\) of 40\+ words/.test(h)));
});

test("character names are not echoes, and dialogue is measured", () => {
  const text = "„Mara?“, rief Kell. „Mara!“ Mara drehte sich um. Mara lachte.";
  const withNames = analyzeProse(text, de, ["Mara", "Kell"]);
  assert.ok(!withNames.repetitions.some((r) => r.word === "mara"));
  assert.ok(withNames.dialogueShare > 0 && withNames.dialogueShare < 1);
});

test("English adverbs are counted", () => {
  const report = analyzeProse("She quickly ran. He slowly walked. They quietly and carefully waited.", en, []);
  assert.equal(report.adverbs.count, 4);
  assert.ok(report.hints.some((h) => /Adverbs in -ly/.test(h)));
});

test("book_prose_check reads a chapter or a passage, and says when a language has no rules", async (t) => {
  const { api } = await newProject(t);
  await callJson(api, "book_character_add", { name: "Mara", role: "protagonist", description: "d" });
  await callJson(api, "book_chapter_create", { title: "Eins", synopsis: "s", content: "# Eins\n\nMara ging. Mara kam. Mara blieb." });
  const chapter = await callJson(api, "book_prose_check", { chapterId: "Eins" });
  assert.equal(chapter.chapterId, "ch-001");
  assert.ok(!chapter.repetitions.some((r) => r.word === "mara"), "the story bible's names are skipped");

  await assert.rejects(callJson(api, "book_prose_check", {}), /either chapterId or passage/);

  const french = await newProject(t, "fr");
  const unchecked = await callJson(french.api, "book_prose_check", { passage: "Il était une fois." });
  assert.equal(unchecked.checked, false);
  assert.match(unchecked.languageNote, /No fr rules/);
});
