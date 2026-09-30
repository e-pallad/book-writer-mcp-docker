const test = require("node:test");
const assert = require("node:assert/strict");

const { collectTools, callJson } = require("./helpers/tools");
const { useTempProject, cleanup } = require("./helpers/project");
const { extractDialogue, attributeDialogue, speakerTagsIn } = require("../dist-tsc/tools/voice");
const { de } = require("../dist-tsc/lang/de");

function tools() {
  const m = (n) => require(`../dist-tsc/tools/${n}`);
  return collectTools(
    m("manuscript").registerManuscriptTools,
    m("storybible").registerStoryBibleTools,
    m("styleguide").registerStyleGuideTools,
    m("timeline").registerTimelineTools,
    m("continuity").registerContinuityTools
  );
}

const GUIDE = {
  voice: "nah an der Figur",
  pov: "personaler Erzähler (Er/Sie)",
  tense: "past",
  tone: "kühl",
  targetAudience: "Erwachsene",
  sentenceStyle: "knapp",
  thingsToAvoid: [],
  recurringMotifs: [],
  samplePassage: "Das Wasser war grau.",
};

async function newProject(t, guide = GUIDE) {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const api = tools();
  await callJson(api, "book_init", {
    title: "Der Hafen",
    author: "A. Autorin",
    genre: "Krimi",
    language: "de",
  });
  await callJson(api, "book_style_set", guide);
  return { dir, api };
}

const rulesOf = (checked) => checked.styleViolations.map((v) => v.rule).join(" | ");

// ---------------------------------------------------------------------------
// Tense

test("Präsens in a Präteritum book is flagged, inverted word order included", async (t) => {
  const { api } = await newProject(t);
  const checked = await callJson(api, "book_style_check", {
    passage: "Mara stand am Kai. Dann geht sie zum Wasser und sieht hinaus.",
  });
  assert.equal(checked.language, "de");
  assert.match(rulesOf(checked), /should be past tense/);
  assert.match(checked.styleViolations[0].excerpt, /geht sie/);
});

test("clean Präteritum narration passes, and present-tense speech is exempt", async (t) => {
  const { api } = await newProject(t);
  const checked = await callJson(api, "book_style_check", {
    passage:
      "Dann ging sie zum Wasser und sah hinaus. »Ich gehe jetzt«, sagte sie. „Er kommt nicht“, sagte Kell.",
  });
  assert.deepEqual(checked.styleViolations, [], JSON.stringify(checked.styleViolations));
  assert.equal(checked.score, "clean");
});

test("Präteritum in a Präsens book is flagged", async (t) => {
  const { api } = await newProject(t, { ...GUIDE, tense: "present" });
  const checked = await callJson(api, "book_style_check", {
    passage: "Sie geht zum Kai. Dann sah sie das Boot.",
  });
  assert.match(rulesOf(checked), /should be present tense/);
});

// ---------------------------------------------------------------------------
// Point of view

test("an Ich-Erzähler book flags third-person thought, a personal narrator first-person", async (t) => {
  const first = await newProject(t, { ...GUIDE, pov: "Ich-Erzählerin" });
  const inFirst = await callJson(first.api, "book_style_check", {
    passage: "Ich stand am Fenster. Er wusste nichts davon, dachte sie.",
  });
  assert.match(rulesOf(inFirst), /first person narration/);

  const third = await newProject(t);
  const inThird = await callJson(third.api, "book_style_check", {
    passage: "Sie stand am Fenster. Das war zu spät, dachte ich.",
  });
  assert.match(rulesOf(inThird), /third person narration/);

  const speech = await callJson(third.api, "book_style_check", {
    passage: "»Das war zu spät, dachte ich«, sagte sie.",
  });
  assert.doesNotMatch(rulesOf(speech), /POV/, "thought inside dialogue is not narration");
});

// ---------------------------------------------------------------------------
// Passive

test("heavy passive is flagged, a little is not", async (t) => {
  const { api } = await newProject(t);
  const heavy = await callJson(api, "book_style_check", {
    passage:
      "Die Tür wurde geöffnet. Das Fenster wurde geschlossen. Der Brief wurde langsam gelesen. Die Kerze wurde gelöscht.",
  });
  assert.match(rulesOf(heavy), /passive/);

  const light = await callJson(api, "book_style_check", {
    passage: "Die Tür wurde geöffnet. Mara trat ein und las den Brief.",
  });
  assert.doesNotMatch(rulesOf(light), /passive/);
});

// ---------------------------------------------------------------------------
// Dialogue

test("German quotation marks are read the right way round", () => {
  const guillemets = extractDialogue("»Komm her«, sagte Mara. »Wie geht es dir?«, fragte Kell.", de);
  assert.deepEqual(
    guillemets.map((l) => [l.text, l.speaker]),
    [
      ["Komm her", "Mara"],
      ["Wie geht es dir?", "Kell"],
    ],
    "»…« must not be read as «…», which captures the narration in between"
  );

  const lowHigh = extractDialogue("„Komm her“, sagte Mara. „Nein“, rief Kell.", de);
  assert.deepEqual(
    lowHigh.map((l) => [l.text, l.speaker]),
    [
      ["Komm her", "Mara"],
      ["Nein", "Kell"],
    ]
  );
});

test("a noun or an opening adverb before a verb of speech is not a speaker", () => {
  assert.deepEqual(
    speakerTagsIn(
      "Die alte Frau sagte nichts. Hinterher sagte er etwas. Leise rief sie. Dann fragte Kell.",
      de
    ),
    ["Kell"]
  );
  assert.deepEqual(speakerTagsIn("»Komm«, sagte Mara. Mara lachte.", de), ["Mara", "Mara"]);
});

test("a German tag attributes the line for the voice check", async (t) => {
  const { api } = await newProject(t);
  await callJson(api, "book_character_add", {
    name: "Kell",
    role: "supporting",
    description: "Hafenarbeiter.",
    voiceProfile: {
      sentenceLength: "clipped",
      verbalTics: ["Tja"],
      neverSays: ["folglich"],
    },
  });

  const checked = await callJson(api, "book_style_check", {
    passage: "»Folglich müssen wir gehen«, sagte Kell. »Nein«, sagte Mara.",
    characterId: "Kell",
  });
  assert.equal(checked.voice.linesAttributedToCharacter, 1);
  assert.equal(checked.voice.linesAttributedToOthers, 1);
  assert.ok(checked.voiceViolations.some((v) => /would never say "folglich"/.test(v.rule)));
});

test("attribution lets an untagged German line count as the character's own", () => {
  const character = { id: "c1", name: "Kell", aliases: [], voiceProfile: {} };
  const { own, others } = attributeDialogue(
    character,
    extractDialogue("»Tja.« »Das geht nicht«, sagte Mara.", de)
  );
  assert.equal(own.length, 1);
  assert.equal(others.length, 1);
});

// ---------------------------------------------------------------------------
// Continuity

async function chapterWith(api, content) {
  const { chapterId } = await callJson(api, "book_chapter_create", {
    title: `Kapitel ${Math.random()}`,
    synopsis: "s",
    content,
  });
  return chapterId;
}

test("an unregistered speaker is reported; capitalised nouns are not", async (t) => {
  const { api } = await newProject(t);
  await callJson(api, "book_character_add", {
    name: "Mara Vance",
    role: "protagonist",
    description: "d",
  });
  const chapterId = await chapterWith(
    api,
    "# Eins\n\nDer Hafen lag still. Die Frau am Tresen sagte nichts. »Komm«, sagte Mara. »Nein«, rief Bernd. Hinterher sagte er etwas.\n"
  );

  const checked = await callJson(api, "book_continuity_check", { chapterId });
  const unknown = checked.flags.filter((f) => /not in the story bible/.test(f.description));
  assert.deepEqual(
    unknown.map((f) => f.description.match(/"([^"]+)"/)[1]),
    ["Bernd"],
    JSON.stringify(checked.flags)
  );
  assert.equal(checked.checksSkipped, undefined);
});

test("a contradicted trait is found in its inflected form, and nouns are left alone", async (t) => {
  const { api } = await newProject(t);
  await callJson(api, "book_character_add", {
    name: "Mara",
    role: "protagonist",
    description: "d",
    traits: ["groß", "jung"],
  });

  const contradicted = await chapterWith(api, "# Eins\n\nMara, die kleine Frau vom Kai, wartete.\n");
  const flagged = await callJson(api, "book_continuity_check", { chapterId: contradicted });
  assert.ok(
    flagged.flags.some((f) => /"groß".*"klein"/.test(f.description)),
    JSON.stringify(flagged.flags)
  );

  const fine = await chapterWith(
    api,
    "# Zwei\n\nMara lachte über die Kleinigkeit. In ihrem Alter war das normal.\n"
  );
  const unflagged = await callJson(api, "book_continuity_check", { chapterId: fine });
  assert.deepEqual(
    unflagged.flags.filter((f) => /story bible but/.test(f.description)),
    [],
    JSON.stringify(unflagged.flags)
  );
});

test("German weekdays and times of day are checked against the timeline", async (t) => {
  const { api } = await newProject(t);
  await callJson(api, "book_character_add", { name: "Mara", role: "protagonist", description: "d" });
  const chapterId = await chapterWith(api, "# Eins\n\nMara las den Brief am Sonntag.\n");
  await callJson(api, "book_timeline_add", {
    event: "Mara findet den Brief",
    inStoryTime: "Samstag, nachts",
    sortKey: "1997-06-14T23:30",
    chapterId,
    characterIds: ["Mara"],
  });

  const wrongDay = await callJson(api, "book_continuity_check", { chapterId });
  const weekday = wrongDay.flags.find((f) => f.type === "timeline" && f.severity === "error");
  assert.ok(weekday, JSON.stringify(wrongDay.flags));
  assert.match(weekday.description, /samstag/);
  assert.match(weekday.description, /sonntag/);

  // Sonnabend is Saturday by another name.
  await callJson(api, "book_chapter_update", {
    chapterId,
    content: "# Eins\n\nMara las den Brief am Sonnabend, spät in der Nacht.\n",
  });
  const sameDay = await callJson(api, "book_continuity_check", { chapterId });
  assert.deepEqual(sameDay.flags.filter((f) => f.type === "timeline"), [], JSON.stringify(sameDay.flags));

  // "am Morgen" is morning; "morgen" alone is tomorrow and says nothing.
  // A deliberate rewrite to a much shorter text, so the cut is confirmed.
  await callJson(api, "book_chapter_update", {
    chapterId,
    content: "# Eins\n\nMara las den Brief am Morgen.\n",
    confirmShrink: true,
  });
  const morning = await callJson(api, "book_continuity_check", { chapterId });
  assert.ok(morning.flags.some((f) => /morning/.test(f.description)), JSON.stringify(morning.flags));

  await callJson(api, "book_chapter_update", {
    chapterId,
    content: "# Eins\n\nMara las den Brief. Morgen würde sie antworten.\n",
  });
  const tomorrow = await callJson(api, "book_continuity_check", { chapterId });
  assert.deepEqual(tomorrow.flags.filter((f) => f.type === "timeline"), [], JSON.stringify(tomorrow.flags));
});
