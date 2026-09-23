const test = require("node:test");
const assert = require("node:assert/strict");

const { collectTools, callJson } = require("./helpers/tools");
const { useTempProject, cleanup } = require("./helpers/project");
const { extractDialogue, attributeDialogue } = require("../dist-tsc/tools/voice");

function allTools() {
  const m = (n) => require(`../dist-tsc/tools/${n}`);
  return collectTools(
    m("manuscript").registerManuscriptTools,
    m("storybible").registerStoryBibleTools,
    m("styleguide").registerStyleGuideTools
  );
}

// Two voices built to be opposites: a terse dockhand and a verbose academic.
const KELL = {
  name: "Kell",
  role: "supporting",
  description: "Dockhand.",
  voiceProfile: {
    vocabulary: "nautical, plain, no abstractions",
    sentenceLength: "clipped",
    verbalTics: ["aye", "mate"],
    neverSays: ["furthermore", "consequently", "epistemological"],
    notes: "Never explains himself.",
  },
};

const VANCE = {
  name: "Vance",
  role: "antagonist",
  description: "Professor of law.",
  voiceProfile: {
    vocabulary: "Latinate, abstract, hedging",
    sentenceLength: "rambling",
    verbalTics: ["furthermore", "one might say"],
    neverSays: ["aye", "mate"],
    notes: "Never uses one word where six will do.",
  },
};

async function newProject(t) {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const api = allTools();
  await callJson(api, "book_init", {
    title: "Voice Book",
    author: "A. Writer",
    genre: "crime",
  });
  await callJson(api, "book_style_set", {
    voice: "close third",
    pov: "third person limited",
    tense: "past",
    tone: "cool",
    targetAudience: "adult",
    sentenceStyle: "lean",
    thingsToAvoid: [],
    recurringMotifs: [],
    samplePassage: "The tide went out.",
  });
  const kell = await callJson(api, "book_character_add", KELL);
  const vance = await callJson(api, "book_character_add", VANCE);
  return { dir, api, kell: kell.character, vance: vance.character };
}

test("a voice profile round-trips through add and update", async (t) => {
  const { api, kell } = await newProject(t);

  const fetched = await callJson(api, "book_character_get", { nameOrId: "Kell" });
  assert.equal(fetched.voiceProfile.sentenceLength, "clipped");
  assert.deepEqual(fetched.voiceProfile.verbalTics, ["aye", "mate"]);

  await callJson(api, "book_character_update", {
    characterId: kell.id,
    updates: {
      voiceProfile: {
        vocabulary: "nautical",
        sentenceLength: "short",
        verbalTics: ["aye"],
        neverSays: ["furthermore"],
        notes: "",
      },
    },
  });
  const updated = await callJson(api, "book_character_get", { nameOrId: "Kell" });
  assert.equal(updated.voiceProfile.sentenceLength, "short");
  assert.deepEqual(updated.voiceProfile.neverSays, ["furthermore"]);
});

test("a character with no voice profile is unaffected", async (t) => {
  const { api } = await newProject(t);
  const plain = await callJson(api, "book_character_add", {
    name: "Plain",
    role: "minor",
    description: "d",
  });
  assert.equal(plain.character.voiceProfile, undefined);

  const checked = await callJson(api, "book_style_check", {
    passage: '"Furthermore, one might say the tide is out," Plain said.',
    characterId: plain.character.id,
  });
  assert.equal(checked.voice.checked, false);
  assert.match(checked.voice.note, /no voice profile/);
  assert.equal(checked.voiceViolations.length, 0);
});

test("dialogue in the wrong character's voice is flagged", async (t) => {
  const { api } = await newProject(t);

  // A line written in Vance's register, but spoken by Kell.
  const passage =
    '"Furthermore, the epistemological status of the manifest is, one might say, ' +
    'a matter upon which reasonable parties could differ at considerable length," Kell said.';

  const checked = await callJson(api, "book_style_check", {
    passage,
    characterId: "Kell",
  });

  assert.equal(checked.voice.checked, true);
  assert.ok(
    checked.voiceViolations.length > 0,
    `expected voice violations, got ${JSON.stringify(checked, null, 2)}`
  );

  // It breaks his neverSays list...
  const neverSays = checked.voiceViolations.find((v) => /would never say/.test(v.rule));
  assert.ok(neverSays, `expected a neverSays flag: ${JSON.stringify(checked.voiceViolations)}`);
  assert.match(neverSays.rule, /Kell/);

  // ...and runs far longer than his clipped register...
  const length = checked.voiceViolations.find((v) => /longer than/.test(v.rule));
  assert.ok(length, `expected a sentence-length flag: ${JSON.stringify(checked.voiceViolations)}`);

  // ...and reads as Vance.
  const confusion = checked.voiceViolations.find((v) => /sounds like Vance/.test(v.rule));
  assert.ok(confusion, `expected a voice-confusion flag: ${JSON.stringify(checked.voiceViolations)}`);
  assert.match(confusion.suggestion, /give the line to Vance/);
});

test("the mirror case: Vance speaking like Kell is flagged too", async (t) => {
  const { api } = await newProject(t);

  const checked = await callJson(api, "book_style_check", {
    passage: '"Aye. Tide\'s out, mate." Vance said.',
    characterId: "Vance",
  });

  assert.ok(checked.voiceViolations.length > 0);
  const neverSays = checked.voiceViolations.find((v) => /would never say/.test(v.rule));
  assert.ok(neverSays, JSON.stringify(checked.voiceViolations));
  assert.match(neverSays.rule, /Vance/);

  const confusion = checked.voiceViolations.find((v) => /sounds like Kell/.test(v.rule));
  assert.ok(confusion, JSON.stringify(checked.voiceViolations));
});

test("dialogue that fits the character passes clean", async (t) => {
  const { api } = await newProject(t);

  const checked = await callJson(api, "book_style_check", {
    passage: '"Aye. Tide\'s out, mate." Kell said. "Rope\'s frayed."',
    characterId: "Kell",
  });

  assert.deepEqual(
    checked.voiceViolations,
    [],
    `expected no voice violations, got ${JSON.stringify(checked.voiceViolations, null, 2)}`
  );
});

test("another character's tagged dialogue is not held against this one", async (t) => {
  const { api } = await newProject(t);

  // Vance rambles, but the check is for Kell — whose own line is in register.
  const passage =
    '"Aye," Kell said. ' +
    '"Furthermore, one might say the matter is considerably more involved than ' +
    'a simple reading of the manifest would tend to suggest," Vance replied.';

  const checked = await callJson(api, "book_style_check", {
    passage,
    characterId: "Kell",
  });

  assert.equal(checked.voice.linesAttributedToOthers, 1, JSON.stringify(checked.voice));
  assert.deepEqual(
    checked.voiceViolations,
    [],
    `Vance's line should not be charged to Kell: ${JSON.stringify(checked.voiceViolations)}`
  );
});

test("the global style guide still applies alongside the voice check", async (t) => {
  const { api } = await newProject(t);

  await callJson(api, "book_style_set", {
    voice: "close third",
    pov: "third person limited",
    tense: "past",
    tone: "cool",
    targetAudience: "adult",
    sentenceStyle: "lean",
    thingsToAvoid: ["suddenly"],
    recurringMotifs: [],
    samplePassage: "s",
  });

  const checked = await callJson(api, "book_style_check", {
    passage: 'Suddenly the door opened. "Furthermore, mate." Kell said.',
    characterId: "Kell",
  });

  assert.ok(
    checked.styleViolations.some((v) => /Avoid: "suddenly"/.test(v.rule)),
    JSON.stringify(checked.styleViolations)
  );
  assert.ok(checked.voiceViolations.some((v) => /would never say/.test(v.rule)));
  // Both feed the combined list and the score.
  assert.equal(
    checked.violations.length,
    checked.styleViolations.length + checked.voiceViolations.length
  );
});

test("book_style_check without a character behaves exactly as before", async (t) => {
  const { api } = await newProject(t);
  const checked = await callJson(api, "book_style_check", {
    passage: '"Furthermore, mate." Kell said.',
  });
  assert.equal(checked.voice, undefined);
  assert.equal(checked.voiceViolations.length, 0);
});

test("an unknown character is rejected", async (t) => {
  const { api } = await newProject(t);
  await assert.rejects(
    () => callJson(api, "book_style_check", { passage: "x", characterId: "Nobody" }),
    /not found/
  );
});

test("dialogue extraction handles curly quotes and speaker tags", () => {
  const straight = extractDialogue('"Aye," Kell said. "Rope\'s frayed."');
  assert.equal(straight.length, 2);
  assert.equal(straight[0].text, "Aye,");
  assert.equal(straight[0].speaker, "Kell");

  const curly = extractDialogue("“Aye,” Kell said.");
  assert.equal(curly.length, 1);
  assert.equal(curly[0].text, "Aye,");
  assert.equal(curly[0].speaker, "Kell");

  // "said Kell" as well as "Kell said".
  const inverted = extractDialogue('"Aye," said Kell.');
  assert.equal(inverted[0].speaker, "Kell");

  // No tag at all leaves the speaker unknown rather than guessed.
  assert.equal(extractDialogue('"Aye."')[0].speaker, undefined);
});

test("untagged dialogue counts as the character under review", () => {
  const character = { id: "c1", name: "Kell", aliases: [], voiceProfile: {} };
  const lines = extractDialogue('"Aye." "Furthermore," Vance said.');
  const { own, others } = attributeDialogue(character, lines);
  assert.equal(own.length, 1);
  assert.equal(own[0].text, "Aye.");
  assert.equal(others.length, 1);
});

test("a full name is matched by a first-name dialogue tag", () => {
  const character = { id: "c1", name: "Mara Vance", aliases: [], voiceProfile: {} };
  const lines = extractDialogue('"Here," Mara said.');
  const { own } = attributeDialogue(character, lines);
  assert.equal(own.length, 1);
});
