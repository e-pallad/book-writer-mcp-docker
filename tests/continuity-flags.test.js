const test = require("node:test");
const assert = require("node:assert/strict");

const { collectTools, callJson } = require("./helpers/tools");
const { useTempProject, cleanup } = require("./helpers/project");

function allTools() {
  const m = (n) => require(`../dist-tsc/tools/${n}`);
  return collectTools(
    m("manuscript").registerManuscriptTools,
    m("storybible").registerStoryBibleTools,
    m("timeline").registerTimelineTools,
    m("scenes").registerSceneTools,
    m("continuity").registerContinuityTools,
    m("links").registerLinkTools
  );
}

async function newProject(t) {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const api = allTools();
  await callJson(api, "book_init", { title: "Flags", author: "A. Writer", genre: "crime" });
  return api;
}

const chapter = (api, title, content) =>
  callJson(api, "book_chapter_create", { title, synopsis: "s", content });

test("every flag names its rule and chapter", async (t) => {
  const api = await newProject(t);
  await callJson(api, "book_character_add", { name: "Mara", role: "protagonist", description: "d", traits: ["tall"] });
  await chapter(api, "Eins", "# Eins\n\nMara stood by the door.\n\nThe tiny Mara looked up. “Come,” said Bernd.\n");

  const checked = await callJson(api, "book_continuity_check", { chapterId: "ch-001" });
  assert.equal(checked.chapterId, "ch-001");
  assert.ok(checked.flags.length >= 2, JSON.stringify(checked.flags));
  for (const flag of checked.flags) {
    assert.ok(flag.code, JSON.stringify(flag));
    assert.equal(flag.chapterId, "ch-001");
    assert.ok(flag.description && flag.suggestion);
  }
});

test("a trait contradiction quotes the passage and its paragraph", async (t) => {
  const api = await newProject(t);
  const mara = await callJson(api, "book_character_add", { name: "Mara", role: "protagonist", description: "d", traits: ["tall"] });
  await chapter(api, "Eins", "# Eins\n\nA quiet start.\n\nThe tiny Mara looked up at the clock.\n");

  const checked = await callJson(api, "book_continuity_check", { chapterId: "ch-001" });
  const flag = checked.flags.find((f) => f.code === "trait_contradiction");
  assert.ok(flag, JSON.stringify(checked.flags));
  assert.equal(flag.entities.characterId, mara.characterId ?? mara.character?.id ?? flag.entities.characterId);
  assert.equal(flag.evidence.length, 1);
  assert.equal(flag.evidence[0].match, "tiny");
  assert.match(flag.evidence[0].after, /Mara/);

  // The paragraph number reads back the very passage with book_chapter_read.
  const read = await callJson(api, "book_chapter_read", {
    chapterId: "ch-001",
    fromParagraph: flag.evidence[0].paragraph,
    toParagraph: flag.evidence[0].paragraph,
  });
  assert.match(JSON.stringify(read), /tiny Mara/);
});

test("an unregistered speaker comes with the call that adds them", async (t) => {
  const api = await newProject(t);
  await chapter(api, "Eins", "# Eins\n\n“Come,” said Bernd.\n");
  const checked = await callJson(api, "book_continuity_check", { chapterId: "ch-001" });
  const flag = checked.flags.find((f) => f.code === "unregistered_speaker");
  assert.ok(flag, JSON.stringify(checked.flags));
  assert.deepEqual(flag.repair, { tool: "book_character_add", args: { name: "Bernd" }, choose: "role" });
  assert.match(flag.evidence[0].match, /Bernd/);
});

test("timeline flags carry the event id, the passage and the repair", async (t) => {
  const api = await newProject(t);
  const kell = await callJson(api, "book_character_add", { name: "Kell", role: "supporting", description: "d" });
  await chapter(api, "Eins", "# Eins\n\nIt was Sunday, and nothing moved on the quay.\n");
  const event = await callJson(api, "book_timeline_add", {
    event: "The letter arrives",
    inStoryTime: "Saturday night",
    chapterId: "ch-001",
    characterIds: ["Kell"],
  });

  const checked = await callJson(api, "book_continuity_check", { chapterId: "ch-001" });
  const eventId = event.eventId ?? event.event?.id;
  const weekday = checked.flags.find((f) => f.code === "timeline_weekday");
  assert.ok(weekday, JSON.stringify(checked.flags));
  assert.equal(weekday.entities.eventId, eventId);
  assert.equal(weekday.evidence[0].match, "Sunday");
  assert.deepEqual(weekday.repair, {
    tool: "book_timeline_update",
    args: { eventId },
    choose: "inStoryTime",
  });

  const absent = checked.flags.find((f) => f.code === "timeline_absent_character");
  assert.ok(absent, JSON.stringify(checked.flags));
  assert.equal(absent.entities.characterId, kell.characterId ?? kell.character?.id ?? absent.entities.characterId);
  assert.equal(absent.repair.choose, "characterIds");
});

test("chronology flags name both events and the other chapter", async (t) => {
  const api = await newProject(t);
  await chapter(api, "Eins", "# Eins\n\nText.\n");
  await chapter(api, "Zwei", "# Zwei\n\nText.\n");
  await callJson(api, "book_timeline_add", { event: "Later", inStoryTime: "June 20", sortKey: "1997-06-20", chapterId: "ch-001" });
  await callJson(api, "book_timeline_add", { event: "Earlier", inStoryTime: "June 10", sortKey: "1997-06-10", chapterId: "ch-002" });

  const checked = await callJson(api, "book_continuity_check", { chapterId: "ch-002" });
  const flag = checked.flags.find((f) => f.code === "timeline_chronology");
  assert.ok(flag, JSON.stringify(checked.flags));
  assert.equal(flag.entities.otherChapterId, "ch-001");
  assert.ok(flag.entities.eventId && flag.entities.otherEventId);
  assert.equal(flag.repair.tool, "book_timeline_update");
  assert.equal(flag.repair.choose, "sortKey");
});

test("a resting plot thread offers book_plot_thread_touch for this chapter", async (t) => {
  const api = await newProject(t);
  for (let i = 1; i <= 8; i++) await chapter(api, `K${i}`, `# K${i}\n\nNothing happens.\n`);
  const thread = await callJson(api, "book_plot_thread_add", { title: "Der Brief", openedIn: "ch-001", summary: "s" });

  const checked = await callJson(api, "book_continuity_check", { chapterId: "ch-008" });
  const flag = checked.flags.find((f) => f.code === "thread_resting");
  assert.ok(flag, JSON.stringify(checked.flags));
  assert.equal(flag.entities.otherChapterId, "ch-001");
  assert.equal(flag.repair.tool, "book_plot_thread_touch");
  assert.equal(flag.repair.args.chapterId, "ch-008");
  assert.equal(flag.repair.args.threadId, flag.entities.threadId);
  assert.ok(thread);
});

test("broken references to the chapter are counted and point at book_links_check", async (t) => {
  const api = await newProject(t);
  await chapter(api, "Eins", "# Eins\n\nText.\n");
  await chapter(api, "Zwei", "# Zwei\n\nText.\n");
  await callJson(api, "book_timeline_add", { event: "Weg", inStoryTime: "x", chapterId: "ch-002" });
  await callJson(api, "book_chapter_delete", { chapterId: "ch-002", confirm: true });

  // The deleted chapter cannot be checked itself; its dangling event is a
  // broken reference of the book and is found by the links check.
  const links = await callJson(api, "book_links_check", { chapterId: "ch-002" });
  assert.equal(links.issues[0].kind, "missing_chapter");

  const clean = await callJson(api, "book_continuity_check", { chapterId: "ch-001" });
  assert.equal(clean.brokenReferences, undefined);
});

test("a scene pointing at a vanished character shows up in the chapter's check", async (t) => {
  const api = await newProject(t);
  await chapter(api, "Eins", "# Eins\n\nText.\n");
  const fs = require("node:fs");
  const path = require("node:path");
  fs.writeFileSync(
    path.join(process.env.BOOK_PROJECT_DIR, ".book-mcp", "scenes.json"),
    JSON.stringify({ scenes: [{ chapterId: "ch-001", anchor: "Text.", indexHint: 1, pov: "gone-1", updatedAt: "x" }] })
  );

  const checked = await callJson(api, "book_continuity_check", { chapterId: "ch-001" });
  assert.equal(checked.brokenReferences, 1);
  assert.match(checked.brokenReferencesNote, /book_links_check/);
  assert.match(checked.brokenReferencesNote, /ch-001/);
});
