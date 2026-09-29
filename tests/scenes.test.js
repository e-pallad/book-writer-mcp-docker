const test = require("node:test");
const assert = require("node:assert/strict");

const { collectTools, callJson } = require("./helpers/tools");
const { useTempProject, cleanup } = require("./helpers/project");
const { splitScenes } = require("../dist-tsc/scenes/scenes");

function tools() {
  const m = (n) => require(`../dist-tsc/tools/${n}`);
  return collectTools(
    m("manuscript").registerManuscriptTools,
    m("chapter-edit").registerChapterEditTools,
    m("storybible").registerStoryBibleTools,
    m("styleguide").registerStyleGuideTools,
    m("continuity").registerContinuityTools,
    m("scenes").registerSceneTools,
    m("dashboard").registerDashboardTools
  );
}

const CHAPTER = `# Der Kai

Mara stand am Kai und wartete auf das Boot.

Es kam nicht.

* * *

Kell flickte Netze im Schuppen. Er dachte an das Geld.

***

Am Abend trafen sie sich in der Kneipe.
`;

test("a chapter splits into scenes at its breaks, with paragraph ranges", () => {
  const scenes = splitScenes(CHAPTER);
  assert.equal(scenes.length, 3);
  assert.deepEqual(
    scenes.map((s) => [s.index, s.firstParagraph, s.lastParagraph, s.words]),
    [
      [1, 2, 3, 12],
      [2, 5, 5, 10],
      [3, 7, 7, 8],
    ]
  );
  assert.equal(scenes[0].opening, "Mara stand am Kai und wartete auf das Boot. Es kam nicht.");
  assert.ok(!scenes[0].text.includes("# Der Kai"), "the chapter heading belongs to no scene");

  assert.equal(splitScenes("# Nur\n\nEin Absatz.").length, 1, "no breaks: one scene");
  assert.equal(splitScenes("Vorher.\n***\nNachher.").length, 2, "a break needs no blank lines");
  assert.equal(splitScenes("***\n\nDanach.").length, 1, "an empty scene is no scene");
});

async function seed(t, pov = "personaler Erzähler (Er/Sie)") {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const api = tools();
  await callJson(api, "book_init", { title: "T", author: "A", genre: "G", language: "de" });
  await callJson(api, "book_style_set", {
    voice: "v", pov, tense: "past", tone: "t", targetAudience: "a",
    sentenceStyle: "s", thingsToAvoid: [], recurringMotifs: [], samplePassage: "p",
  });
  await callJson(api, "book_character_add", { name: "Mara Vance", role: "protagonist", description: "d" });
  await callJson(api, "book_character_add", { name: "Kell", role: "supporting", description: "d" });
  await callJson(api, "book_setting_add", { name: "Der Kai", description: "d", type: "location" });
  await callJson(api, "book_chapter_create", { title: "Der Kai", synopsis: "s", content: CHAPTER });
  return { dir, api };
}

test("a scene's point of view, place, goal, conflict and outcome are noted and listed", async (t) => {
  const { api } = await seed(t);
  const set = await callJson(api, "book_scene_set", {
    chapterId: "Der Kai",
    scene: 1,
    pov: "Mara",
    setting: "der kai",
    time: "Samstag, früh",
    goal: "Das Boot abfangen",
    conflict: "Es kommt nicht",
    outcome: "Sie ahnt, dass Kell lügt",
  });
  assert.equal(set.scene.pov, "Mara Vance", "resolved by first name");
  assert.equal(set.note, undefined, "a known setting needs no note");

  const other = await callJson(api, "book_scene_set", { chapterId: "ch-001", scene: 2, pov: "Kell", setting: "Schuppen" });
  assert.match(other.note, /not a setting in the story bible/);

  const listed = await callJson(api, "book_scene_list", { chapterId: "ch-001" });
  assert.equal(listed.totalScenes, 3);
  assert.equal(listed.described, 2);
  const [one, two, three] = listed.chapters[0].scenes;
  assert.equal(one.pov, "Mara Vance");
  assert.equal(one.conflict, "Es kommt nicht");
  assert.equal(one.paragraphs, "2–3");
  assert.equal(two.setting, "Schuppen");
  assert.equal(three.pov, undefined);
  assert.match(listed.withoutConflict, /1 described scene/);

  const shares = Object.fromEntries(listed.pointOfView.map((p) => [p.character, p.scenes]));
  assert.deepEqual(shares, { "Mara Vance": 1, Kell: 1, "(not set)": 1 });
});

test("scene notes follow their scene when a scene is inserted before it", async (t) => {
  const { api } = await seed(t);
  await callJson(api, "book_scene_set", { chapterId: "ch-001", scene: 2, pov: "Kell", goal: "Geld" });

  // A new scene in front: Kell's scene is now the third.
  await callJson(api, "book_chapter_replace_text", {
    chapterId: "ch-001",
    oldText: "* * *\n\nKell flickte",
    newText: "* * *\n\nEin Möwenschrei.\n\n* * *\n\nKell flickte",
  });
  const listed = await callJson(api, "book_scene_list", { chapterId: "ch-001" });
  const scenes = listed.chapters[0].scenes;
  assert.equal(scenes.length, 4);
  assert.equal(scenes[1].pov, undefined, "the new scene has no notes");
  assert.equal(scenes[2].pov, "Kell");
  assert.equal(scenes[2].goal, "Geld");
});

test("notes on a scene whose opening was rewritten are reported as lost, not reassigned", async (t) => {
  const { api } = await seed(t);
  await callJson(api, "book_scene_set", { chapterId: "ch-001", scene: 3, pov: "Mara", summary: "Treffen" });
  await callJson(api, "book_chapter_replace_text", {
    chapterId: "ch-001",
    oldText: "Am Abend trafen sie sich in der Kneipe.",
    newText: "Spät in der Nacht saßen sie beim Wirt.",
  });
  const listed = await callJson(api, "book_scene_list", {});
  assert.equal(listed.chapters[0].scenes[2].pov, undefined);
  assert.equal(listed.lostMetadata.length, 1);
  assert.equal(listed.lostMetadata[0].summary, "Treffen");
  assert.match(listed.lostHint, /book_scene_set/);
});

test("the continuity check flags a POV character who is never named in their scene", async (t) => {
  const { api } = await seed(t);
  await callJson(api, "book_scene_set", { chapterId: "ch-001", scene: 2, pov: "Mara" });
  const checked = await callJson(api, "book_continuity_check", { chapterId: "ch-001" });
  const pov = checked.flags.find((f) => /point of view/.test(f.description));
  assert.ok(pov, JSON.stringify(checked.flags));
  assert.match(pov.description, /Scene 2 is told from Mara Vance's point of view, but never names them/);

  await callJson(api, "book_scene_set", { chapterId: "ch-001", scene: 2, pov: "Kell" });
  const fixed = await callJson(api, "book_continuity_check", { chapterId: "ch-001" });
  assert.ok(!fixed.flags.some((f) => /point of view/.test(f.description)));
});

test("a first-person book is not checked for a named narrator", async (t) => {
  const { api } = await seed(t, "Ich-Erzählerin");
  await callJson(api, "book_scene_set", { chapterId: "ch-001", scene: 2, pov: "Mara" });
  const checked = await callJson(api, "book_continuity_check", { chapterId: "ch-001" });
  assert.ok(!checked.flags.some((f) => /point of view/.test(f.description)));
});

test("the dashboard shows how the scenes are shared between points of view", async (t) => {
  const { api } = await seed(t);
  await callJson(api, "book_scene_set", { chapterId: "ch-001", scene: 1, pov: "Mara" });
  await callJson(api, "book_scene_set", { chapterId: "ch-001", scene: 3, pov: "Mara" });
  const { scenes } = await callJson(api, "book_dashboard", { sections: ["scenes"] });
  assert.equal(scenes.total, 3);
  assert.equal(scenes.described, 2);
  assert.equal(scenes.pointOfView[0].character, "Mara Vance");
  assert.equal(scenes.pointOfView[0].scenes, 2);
});

test("setting a scene that does not exist, or nothing at all, is refused", async (t) => {
  const { api } = await seed(t);
  await assert.rejects(callJson(api, "book_scene_set", { chapterId: "ch-001", scene: 9, pov: "Kell" }), /has 3 scene\(s\)/);
  await assert.rejects(callJson(api, "book_scene_set", { chapterId: "ch-001", scene: 1 }), /Nothing to set/);
  await assert.rejects(callJson(api, "book_scene_set", { chapterId: "ch-001", scene: 1, pov: "Niemand" }), /not found/);
});
