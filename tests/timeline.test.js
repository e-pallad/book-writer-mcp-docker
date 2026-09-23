const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { collectTools, callJson } = require("./helpers/tools");
const { useTempProject, cleanup } = require("./helpers/project");

function allTools() {
  const m = (n) => require(`../dist-tsc/tools/${n}`);
  return collectTools(
    m("manuscript").registerManuscriptTools,
    m("storybible").registerStoryBibleTools,
    m("timeline").registerTimelineTools,
    m("continuity").registerContinuityTools
  );
}

async function newProject(t) {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const api = allTools();
  await callJson(api, "book_init", {
    title: "Timeline Book",
    author: "A. Writer",
    genre: "crime",
  });
  return { dir, api };
}

const readJson = (dir, name) =>
  JSON.parse(fs.readFileSync(path.join(dir, ".book-mcp", name), "utf-8"));

test("events added out of order come back in chronological order", async (t) => {
  const { dir, api } = await newProject(t);

  // Deliberately logged middle, last, first.
  await callJson(api, "book_timeline_add", {
    event: "Mara finds the letter",
    inStoryTime: "Saturday night, ~23:30",
    sortKey: "1997-06-14T23:30",
  });
  await callJson(api, "book_timeline_add", {
    event: "The inquest opens",
    inStoryTime: "the following Thursday, morning",
    sortKey: "1997-06-19T09:00",
  });
  await callJson(api, "book_timeline_add", {
    event: "Kell leaves the harbour",
    inStoryTime: "Friday afternoon, the day before",
    sortKey: "1997-06-13T16:00",
  });

  const listed = await callJson(api, "book_timeline_list", {});
  assert.equal(listed.eventCount, 3);
  assert.deepEqual(
    listed.events.map((e) => e.event),
    ["Kell leaves the harbour", "Mara finds the letter", "The inquest opens"],
    "book_timeline_list should sort by sortKey, not insertion order"
  );

  // Stored in its own file, referenced from the story bible.
  const timeline = readJson(dir, "timeline.json");
  assert.equal(timeline.events.length, 3);
  assert.equal(readJson(dir, "story-bible.json").timelineRef, "timeline.json");
});

test("the story bible references the timeline rather than duplicating it", async (t) => {
  const { dir, api } = await newProject(t);

  const { character } = await callJson(api, "book_character_add", {
    name: "Mara",
    role: "protagonist",
    description: "Dock inspector.",
  });
  await callJson(api, "book_timeline_add", {
    event: "Mara finds the letter",
    inStoryTime: "Saturday night",
    sortKey: "1997-06-14T23:30",
    characterIds: ["Mara"],
  });

  const timeline = readJson(dir, "timeline.json");
  const bible = readJson(dir, "story-bible.json");

  // The event points at the character by id; no copy of her details.
  assert.deepEqual(timeline.events[0].characterIds, [character.id]);
  assert.ok(
    !JSON.stringify(timeline).includes("Dock inspector"),
    "timeline.json should not carry a second copy of character data"
  );
  assert.ok(
    !Array.isArray(bible.timeline),
    "the inline story-bible timeline array should be gone"
  );

  // But the name is resolved on the way out, and follows a rename.
  await callJson(api, "book_character_update", {
    characterId: character.id,
    updates: { name: "Mara Vance" },
  });
  const listed = await callJson(api, "book_timeline_list", {});
  assert.deepEqual(listed.events[0].characters, ["Mara Vance"]);
});

test("events without a sortKey sort last, by chapter order", async (t) => {
  const { api } = await newProject(t);

  const ch1 = await callJson(api, "book_chapter_create", {
    title: "One",
    synopsis: "s",
    content: "# One\n\nbody\n",
  });
  const ch2 = await callJson(api, "book_chapter_create", {
    title: "Two",
    synopsis: "s",
    content: "# Two\n\nbody\n",
  });

  await callJson(api, "book_timeline_add", {
    event: "unplaced, later chapter",
    inStoryTime: "sometime",
    chapterId: ch2.chapterId,
  });
  await callJson(api, "book_timeline_add", {
    event: "unplaced, earlier chapter",
    inStoryTime: "sometime",
    chapterId: ch1.chapterId,
  });
  await callJson(api, "book_timeline_add", {
    event: "placed",
    inStoryTime: "Saturday",
    sortKey: "1997-06-14",
  });

  const listed = await callJson(api, "book_timeline_list", {});
  assert.deepEqual(
    listed.events.map((e) => e.event),
    ["placed", "unplaced, earlier chapter", "unplaced, later chapter"]
  );
  assert.match(listed.note, /2 event\(s\) have no sortKey/);
});

test("filters by chapter and by character", async (t) => {
  const { api } = await newProject(t);
  const ch = await callJson(api, "book_chapter_create", {
    title: "Harbour",
    synopsis: "s",
    content: "# Harbour\n\nbody\n",
  });
  await callJson(api, "book_character_add", {
    name: "Kell",
    role: "supporting",
    description: "d",
  });
  await callJson(api, "book_character_add", {
    name: "Mara",
    role: "protagonist",
    description: "d",
  });

  await callJson(api, "book_timeline_add", {
    event: "Kell in the chapter",
    inStoryTime: "t1",
    sortKey: "0001",
    chapterId: "Harbour",
    characterIds: ["Kell"],
  });
  await callJson(api, "book_timeline_add", {
    event: "Mara elsewhere",
    inStoryTime: "t2",
    sortKey: "0002",
    characterIds: ["Mara"],
  });

  const byChapter = await callJson(api, "book_timeline_list", {
    chapterId: ch.chapterId,
  });
  assert.deepEqual(byChapter.events.map((e) => e.event), ["Kell in the chapter"]);

  const byCharacter = await callJson(api, "book_timeline_list", {
    characterId: "Mara",
  });
  assert.deepEqual(byCharacter.events.map((e) => e.event), ["Mara elsewhere"]);
});

test("update and delete correct the record", async (t) => {
  const { api } = await newProject(t);
  const added = await callJson(api, "book_timeline_add", {
    event: "Typo evnet",
    inStoryTime: "Saturday",
  });
  assert.match(added.hint, /No sortKey given/);

  const updated = await callJson(api, "book_timeline_update", {
    eventId: added.event.id,
    event: "Corrected event",
    sortKey: "1997-06-14T23:30",
  });
  assert.equal(updated.event.event, "Corrected event");
  assert.equal(updated.event.sortKey, "1997-06-14T23:30");

  // An empty sortKey unplaces the event again.
  const unplaced = await callJson(api, "book_timeline_update", {
    eventId: added.event.id,
    sortKey: "",
  });
  assert.equal(unplaced.event.sortKey, undefined);

  const deleted = await callJson(api, "book_timeline_delete", {
    eventId: added.event.id,
  });
  assert.equal(deleted.remainingEvents, 0);

  await assert.rejects(
    () => callJson(api, "book_timeline_update", { eventId: added.event.id, notes: "x" }),
    /not found/
  );
});

test("unknown chapters and characters are rejected, not silently stored", async (t) => {
  const { api } = await newProject(t);

  await assert.rejects(
    () =>
      callJson(api, "book_timeline_add", {
        event: "e",
        inStoryTime: "t",
        chapterId: "ch-999",
      }),
    /not found/
  );
  await assert.rejects(
    () =>
      callJson(api, "book_timeline_add", {
        event: "e",
        inStoryTime: "t",
        characterIds: ["Nobody"],
      }),
    /not in the story bible/
  );
});

test("a chapter contradicting a logged event is flagged", async (t) => {
  const { api } = await newProject(t);

  const chapter = await callJson(api, "book_chapter_create", {
    title: "The Letter",
    synopsis: "Mara finds it.",
    content: "# The Letter\n\nMara turned the envelope over on Saturday night.\n",
  });
  await callJson(api, "book_character_add", {
    name: "Mara",
    role: "protagonist",
    description: "d",
  });
  await callJson(api, "book_timeline_add", {
    event: "Mara finds the letter",
    inStoryTime: "Saturday night, ~23:30",
    sortKey: "1997-06-14T23:30",
    chapterId: chapter.chapterId,
    characterIds: ["Mara"],
  });

  // The draft as logged: consistent.
  const clean = await callJson(api, "book_continuity_check", {
    chapterId: chapter.chapterId,
  });
  assert.equal(
    clean.flags.filter((f) => f.type === "timeline").length,
    0,
    `expected no timeline flags, got ${JSON.stringify(clean.flags)}`
  );
  assert.equal(clean.timelineEventsForChapter, 1);

  // Now rewrite it to say Tuesday morning instead.
  await callJson(api, "book_chapter_update", {
    chapterId: chapter.chapterId,
    content: "# The Letter\n\nMara turned the envelope over on Tuesday morning.\n",
  });

  const checked = await callJson(api, "book_continuity_check", {
    chapterId: chapter.chapterId,
  });
  const timelineFlags = checked.flags.filter((f) => f.type === "timeline");
  assert.ok(timelineFlags.length > 0, "the contradiction should be flagged");

  const weekday = timelineFlags.find((f) => /saturday/i.test(f.description));
  assert.ok(weekday, `expected a weekday contradiction, got ${JSON.stringify(timelineFlags)}`);
  assert.equal(weekday.severity, "error");
  assert.match(weekday.description, /tuesday/i);
  assert.match(weekday.suggestion, /book_timeline_update/);
});

test("an event that happens before one in an earlier chapter is flagged", async (t) => {
  const { api } = await newProject(t);

  const first = await callJson(api, "book_chapter_create", {
    title: "First",
    synopsis: "s",
    content: "# First\n\nThe inquest opened.\n",
  });
  const second = await callJson(api, "book_chapter_create", {
    title: "Second",
    synopsis: "s",
    content: "# Second\n\nKell left the harbour.\n",
  });

  await callJson(api, "book_timeline_add", {
    event: "The inquest opens",
    inStoryTime: "Thursday morning",
    sortKey: "1997-06-19T09:00",
    chapterId: first.chapterId,
  });
  // Logged in the later chapter, but happens days earlier.
  await callJson(api, "book_timeline_add", {
    event: "Kell leaves the harbour",
    inStoryTime: "Friday afternoon",
    sortKey: "1997-06-13T16:00",
    chapterId: second.chapterId,
  });

  const checked = await callJson(api, "book_continuity_check", {
    chapterId: second.chapterId,
  });
  const flag = checked.flags.find(
    (f) => f.type === "timeline" && /happens before/.test(f.description)
  );
  assert.ok(flag, `expected a chronology flag, got ${JSON.stringify(checked.flags)}`);
  assert.equal(flag.severity, "error");
  assert.match(flag.suggestion, /flashback/);
});

test("a character the timeline places in a chapter but who never appears is flagged", async (t) => {
  const { api } = await newProject(t);
  const chapter = await callJson(api, "book_chapter_create", {
    title: "Absent",
    synopsis: "s",
    content: "# Absent\n\nThe room was empty when Mara arrived.\n",
  });
  await callJson(api, "book_character_add", {
    name: "Mara",
    role: "protagonist",
    description: "d",
  });
  await callJson(api, "book_character_add", {
    name: "Kell",
    role: "supporting",
    description: "d",
  });

  await callJson(api, "book_timeline_add", {
    event: "Kell waits inside",
    inStoryTime: "later that night",
    sortKey: "1997-06-14T23:40",
    chapterId: chapter.chapterId,
    characterIds: ["Kell"],
  });

  const checked = await callJson(api, "book_continuity_check", {
    chapterId: chapter.chapterId,
  });
  const flag = checked.flags.find(
    (f) => f.type === "timeline" && /never named/.test(f.description)
  );
  assert.ok(flag, `expected an absent-character flag, got ${JSON.stringify(checked.flags)}`);
  assert.equal(flag.severity, "warning");
});

test("a chapter with no logged events is not second-guessed", async (t) => {
  const { api } = await newProject(t);
  const chapter = await callJson(api, "book_chapter_create", {
    title: "Unlogged",
    synopsis: "s",
    content: "# Unlogged\n\nIt was Tuesday morning, then Saturday night.\n",
  });

  const checked = await callJson(api, "book_continuity_check", {
    chapterId: chapter.chapterId,
  });
  assert.equal(checked.flags.filter((f) => f.type === "timeline").length, 0);
  assert.equal(checked.timelineEventsForChapter, 0);
  assert.match(checked.timelineNote, /No timeline events are logged/);
});

test("an older project's inline timeline is migrated, not dropped", async (t) => {
  const { dir, api } = await newProject(t);

  // Rewrite story-bible.json the way an older version left it.
  const biblePath = path.join(dir, ".book-mcp", "story-bible.json");
  const bible = JSON.parse(fs.readFileSync(biblePath, "utf-8"));
  delete bible.timelineRef;
  bible.timeline = [
    { id: "old-2", event: "Second thing", chapterId: "ch-002", order: 2 },
    { id: "old-1", event: "First thing", chapterId: "ch-001", order: 1 },
  ];
  fs.writeFileSync(biblePath, JSON.stringify(bible, null, 2));
  fs.rmSync(path.join(dir, ".book-mcp", "timeline.json"));

  const listed = await callJson(api, "book_timeline_list", {});
  assert.deepEqual(
    listed.events.map((e) => e.event),
    ["First thing", "Second thing"],
    "migrated events should keep their old order"
  );
  assert.equal(listed.events[0].id, "old-1");

  const after = JSON.parse(fs.readFileSync(biblePath, "utf-8"));
  assert.equal(after.timelineRef, "timeline.json");
  assert.equal(after.timeline, undefined, "the inline array should be cleared");
});

test("concurrent timeline_add calls all land with distinct ids", async (t) => {
  const { dir, api } = await newProject(t);

  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      callJson(api, "book_timeline_add", {
        event: `Event ${i}`,
        inStoryTime: `t${i}`,
        sortKey: String(i).padStart(4, "0"),
      })
    )
  );

  const timeline = readJson(dir, "timeline.json");
  assert.equal(timeline.events.length, 20);
  assert.equal(new Set(timeline.events.map((e) => e.id)).size, 20);
});

test("deleting a chapter reports the timeline events it orphans", async (t) => {
  const { api } = await newProject(t);
  const chapter = await callJson(api, "book_chapter_create", {
    title: "Doomed",
    synopsis: "s",
    content: "# Doomed\n\nbody\n",
  });
  await callJson(api, "book_timeline_add", {
    event: "Something happens here",
    inStoryTime: "Saturday",
    sortKey: "0001",
    chapterId: chapter.chapterId,
  });

  const deleted = await callJson(api, "book_chapter_delete", {
    chapterId: chapter.chapterId,
    confirm: true,
  });

  assert.ok(
    deleted.danglingReferences?.some((r) => /Timeline event/.test(r)),
    `expected a dangling timeline reference, got ${JSON.stringify(deleted.danglingReferences)}`
  );
});
