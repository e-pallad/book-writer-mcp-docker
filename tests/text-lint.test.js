const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { collectTools, callJson } = require("./helpers/tools");
const { useTempProject, cleanup } = require("./helpers/project");

function tools() {
  const m = (n) => require(`../dist-tsc/tools/${n}`);
  return collectTools(m("manuscript").registerManuscriptTools, m("book-edit").registerBookEditTools);
}

const { findSubstituteSpellings } = require("../dist-tsc/prose/substitute-spelling");

const words = (text, exclusions) =>
  findSubstituteSpellings(text, exclusions).map((h) => `${h.word}>${h.suggestion}`);

// ---------------------------------------------------------------------------
// The heuristic

test("spelled-out umlauts and ß are found, with the letter suggested", () => {
  assert.deepEqual(words("Ueber die Bruecke ging er fuer sie, schoen und waehrend."), [
    "Ueber>Über",
    "Bruecke>Brücke",
    "fuer>für",
    "schoen>schön",
    "waehrend>während",
  ]);
  assert.deepEqual(words("Die Strasse war gross, draussen hiess es heiss."), [
    "Strasse>Straße",
    "gross>groß",
    "draussen>draußen",
    "hiess>hieß",
    "heiss>heiß",
  ]);
  assert.deepEqual(words("groesser, regelmaessig, Grossstadt, UEBER"), [
    "groesser>größer",
    "regelmaessig>regelmäßig",
    "Grossstadt>Großstadt",
    "UEBER>ÜBER",
  ]);
});

test("correct spellings with ue, ae, oe and ss are left alone", () => {
  const correct = [
    "Feuer", "Michael", "Michaels", "Poet", "Poesie", "Israel", "Oboe", "Statue",
    "Quelle", "aktuell", "Duell", "Duett", "Frequenz", "Samuel", "Bauer", "Mauer",
    "neue", "Treue", "Abenteuer", "zuerst", "Goethe", "Aerobic",
    // ss after a short vowel is correct since the spelling reform
    "muss", "dass", "Wasser", "Schloss", "Fluss", "küssen",
    // aus + s-word is a compound, not a misspelling
    "aussehen", "Aussage", "herausstellen",
    // Eis + Schrank, Preis + Schild
    "Eisschrank", "Preisschild", "Eisstadion",
    // Capitals write ß as SS
    "STRASSE",
  ];
  assert.deepEqual(words(correct.join(" ")), []);
});

test("Müller and Hütte are still found although aktuell and Duett are not", () => {
  assert.deepEqual(words("Mueller Huette aktuell Duett"), ["Mueller>Müller", "Huette>Hütte"]);
});

// ---------------------------------------------------------------------------
// The tool

async function seed(t, language = "de") {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const api = tools();
  await callJson(api, "book_init", { title: "Ueber das Meer", author: "A", genre: "G", language });
  await callJson(api, "book_chapter_create", {
    title: "Die Bruecke",
    synopsis: "Mara geht ueber die Bruecke.",
    content:
      "# Die Bruecke\n\nMichael sass am Feuer.\n\nDann ging Mara ueber die Strasse. Es war heiss.\n\nNichts weiter.\n",
  });
  await callJson(api, "book_chapter_create", {
    title: "Der Hafen",
    synopsis: "Am Kai.",
    content: "# Der Hafen\n\nDer Hafen lag still. Wasser, nichts als Wasser.\n",
  });

  const mcp = path.join(dir, ".book-mcp");
  const biblePath = path.join(mcp, "story-bible.json");
  const bible = JSON.parse(fs.readFileSync(biblePath, "utf-8"));
  bible.characters.push({
    id: "char-1",
    name: "Mara",
    aliases: [],
    role: "protagonist",
    description: "Sie ist schoen und muede.",
    backstory: "",
    traits: ["mutig"],
    relationships: [],
    firstAppearance: "ch-001",
    notes: "",
  });
  bible.settings.push({ id: "set-1", name: "Der Kai", description: "Nass.", type: "location", notes: "" });
  bible.plotThreads.push({
    id: "thread-1",
    title: "Die Schuld",
    status: "open",
    openedIn: "ch-001",
    summary: "Mara muss fuer ihre Luege buessen.",
    keywords: ["Luege"],
  });
  fs.writeFileSync(biblePath, JSON.stringify(bible, null, 2));

  fs.writeFileSync(
    path.join(mcp, "outline.json"),
    JSON.stringify({
      acts: [{ act: "Erster Akt", chapters: [{ title: "Die Bruecke", synopsis: "Mara ist mued.", scenes: ["Oel im Wasser"] }] }],
    })
  );
  return { dir, api };
}

test("book_text_lint counts per place and gives at most 3 examples each", async (t) => {
  const { api } = await seed(t);

  const result = await callJson(api, "book_text_lint", {});
  const { locations } = result;

  // Chapter text: Bruecke (heading), ueber, Strasse, heiss. Not Michael,
  // Feuer, Wasser — and "sass" is a long vowel no rule can know about.
  assert.equal(locations.chapters.count, 4);
  assert.deepEqual(locations.chapters.byChapter, { "ch-001": 4 });
  assert.equal(locations.chapters.examples.length, 3);
  assert.deepEqual(locations.chapters.examples[0], {
    chapterId: "ch-001",
    paragraph: 1,
    word: "Bruecke",
    suggestion: "Brücke",
  });
  assert.deepEqual(
    locations.chapters.examples.slice(1).map((e) => [e.word, e.paragraph]),
    [["ueber", 3], ["Strasse", 3]]
  );

  // Chapter title and book title.
  assert.equal(locations.titles.count, 2);
  assert.deepEqual(
    locations.titles.examples.map((e) => e.where),
    ["title of ch-001", "book title"]
  );
  // "ueber die Bruecke"
  assert.equal(locations.synopses.count, 2);
  // "schoen", "muede"
  assert.equal(locations.storyBible.count, 2);
  assert.match(locations.storyBible.examples[0].where, /character "Mara": description/);
  // "Die Bruecke", "Oel"; "mued" ends in -ued and is still reported
  assert.equal(locations.outline.count, 3);
  // "fuer", "Luege", "buessen" in the summary; "Luege" again as a keyword
  assert.equal(locations.plotThreads.count, 4);
  assert.ok(locations.plotThreads.examples.length <= 3);

  assert.equal(
    result.total,
    4 + 2 + 2 + 2 + 3 + 4,
    "the total is the sum of the places"
  );
  assert.equal(result.warning, undefined, "a German project gets no language warning");
});

test("book_text_lint is read-only and never returns chapter text", async (t) => {
  const { dir, api } = await seed(t);
  const snapshot = () => {
    const files = {};
    const walk = (d) => {
      for (const name of fs.readdirSync(d)) {
        const full = path.join(d, name);
        if (fs.statSync(full).isDirectory()) walk(full);
        else files[full] = fs.readFileSync(full, "utf-8");
      }
    };
    walk(dir);
    return files;
  };

  const before = snapshot();
  const result = await callJson(api, "book_text_lint", {});
  assert.deepEqual(snapshot(), before, "nothing on disk may change");
  assert.ok(!JSON.stringify(result).includes("Dann ging Mara"), "no chapter text in the reply");
});

test("exclude leaves further words alone", async (t) => {
  const { api } = await seed(t);

  const result = await callJson(api, "book_text_lint", { exclude: ["Bruecke", "Strasse"] });
  // Only "ueber" and "heiss" are left in the text.
  assert.equal(result.locations.chapters.count, 2);
  assert.equal(result.locations.titles.count, 1, "only the book title is left");
});

test("a clean book says so", async (t) => {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const api = tools();
  await callJson(api, "book_init", { title: "Über das Meer", author: "A", genre: "G", language: "de" });
  await callJson(api, "book_chapter_create", {
    title: "Die Brücke",
    synopsis: "Mara geht über die Brücke.",
    content: "# Die Brücke\n\nMichael saß am Feuer. Es war heiß, und sie musste gehen.\n",
  });

  const result = await callJson(api, "book_text_lint", {});
  assert.equal(result.total, 0);
  assert.match(result.message, /No spelled-out umlauts/);
  assert.deepEqual(result.locations.chapters, { count: 0 });
});

test("a project not set to German gets a warning", async (t) => {
  const { api } = await seed(t, "en");

  const result = await callJson(api, "book_text_lint", {});
  assert.match(result.warning, /project language is "en"/);
  assert.match(result.warning, /book_project_update language="de"/);
});

test("settings are a place of their own, and scene summaries count as synopses", async (t) => {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const m = (n) => require(`../dist-tsc/tools/${n}`);
  const api = collectTools(
    m("manuscript").registerManuscriptTools,
    m("book-edit").registerBookEditTools,
    m("storybible").registerStoryBibleTools,
    m("scenes").registerSceneTools
  );
  await callJson(api, "book_init", { title: "Das Meer", author: "A", genre: "G", language: "de" });
  await callJson(api, "book_chapter_create", {
    title: "Der Kai",
    synopsis: "Am Kai.",
    content: "# Der Kai\n\nMara wartete.\n\n* * *\n\nKell kam spät.\n",
  });
  await callJson(api, "book_setting_add", {
    name: "Hafenstrasse",
    description: "Eine Gasse hinter dem Kai.",
    type: "location",
    notes: "Riecht nach Oel.",
  });
  await callJson(api, "book_scene_set", { chapterId: "ch-001", scene: 2, summary: "Kell kommt zurueck." });

  const { locations, total } = await callJson(api, "book_text_lint", {});
  assert.equal(locations.settings.count, 2);
  assert.deepEqual(
    locations.settings.examples.map((e) => [e.where, e.word]),
    [
      ['setting "Hafenstrasse": name', "Hafenstrasse"],
      ['setting "Hafenstrasse": notes', "Oel"],
    ]
  );
  assert.equal(locations.storyBible.count, 0, "settings are no longer counted as story bible");
  assert.equal(locations.synopses.count, 1);
  assert.equal(locations.synopses.examples[0].where, "summary of scene 2 in ch-001");
  assert.equal(total, 3);
});
