const test = require("node:test");
const assert = require("node:assert/strict");

const { collectTools, callJson } = require("./helpers/tools");
const { useTempProject, cleanup } = require("./helpers/project");

function tools() {
  const m = (n) => require(`../dist-tsc/tools/${n}`);
  return collectTools(
    m("manuscript").registerManuscriptTools,
    m("chapter-edit").registerChapterEditTools,
    m("notes").registerNoteTools,
    m("dashboard").registerDashboardTools
  );
}

const CHAPTER = `# Der Kai

Mara ging über den Kai. Sie wusste schon, wer der Tote war.

Kell flickte Netze. Das Wasser war grau.

Später schloss sie die Tür. Das Wasser war grau.
`;

async function seed(t) {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const api = tools();
  await callJson(api, "book_init", { title: "T", author: "A", genre: "G", language: "de" });
  await callJson(api, "book_chapter_create", { title: "Der Kai", synopsis: "s", content: CHAPTER });
  return { dir, api };
}

test("a note is anchored to the words it is about", async (t) => {
  const { api } = await seed(t);
  const added = await callJson(api, "book_note_add", {
    chapterId: "Der Kai",
    anchorText: "Sie wusste schon, wer der Tote war.",
    text: "Woher weiß sie das an dieser Stelle schon?",
    source: "Testleserin A",
    kind: "question",
  });
  assert.equal(added.note.chapterId, "ch-001");
  assert.equal(added.location.paragraph, 2);
  assert.match(added.location.context, /Mara ging über den Kai/);

  await assert.rejects(
    callJson(api, "book_note_add", { chapterId: "ch-001", anchorText: "Gibt es nicht", text: "x" }),
    /is not in chapter ch-001/
  );
});

test("the anchor follows its passage through a revision, and reports when it is cut", async (t) => {
  const { api } = await seed(t);
  const { note } = await callJson(api, "book_note_add", {
    chapterId: "ch-001",
    anchorText: "Kell flickte Netze.",
    text: "Zu knapp.",
    source: "Lektorat",
  });

  // A new paragraph in front moves the passage down one.
  await callJson(api, "book_chapter_replace_text", {
    chapterId: "ch-001",
    oldText: "# Der Kai\n\n",
    newText: "# Der Kai\n\nEs regnete.\n\n",
  });
  let listed = await callJson(api, "book_note_list", {});
  assert.equal(listed.notes[0].location.paragraph, 4);
  assert.equal(listed.notes[0].location.found, true);

  // Cutting the passage loses the anchor, and says so.
  await callJson(api, "book_chapter_replace_text", {
    chapterId: "ch-001",
    oldText: "Kell flickte Netze. ",
    newText: "",
  });
  listed = await callJson(api, "book_note_list", {});
  assert.equal(listed.notes[0].id, note.id);
  assert.equal(listed.notes[0].location.found, false);
  assert.match(listed.lostAnchors, /no longer in their chapter/);
});

test("a repeated passage is told apart by where the note was made", async (t) => {
  const { api } = await seed(t);
  const second = await callJson(api, "book_note_add", {
    chapterId: "ch-001",
    anchorText: "Das Wasser war grau.",
    paragraph: 4,
    text: "Wiederholung.",
  });
  assert.equal(second.location.paragraph, 4);
  assert.equal(second.location.occurrences, 2);
});

test("a note can be pinned to a paragraph, and to the chapter as a whole", async (t) => {
  const { api } = await seed(t);
  const pinned = await callJson(api, "book_note_add", { chapterId: "ch-001", paragraph: 3, text: "Stark." , kind: "praise" });
  assert.equal(pinned.note.anchorText, "Kell flickte Netze. Das Wasser war grau.");
  assert.equal(pinned.location.paragraph, 3);

  const whole = await callJson(api, "book_note_add", { chapterId: "ch-001", text: "Das Kapitel ist zu lang." });
  assert.equal(whole.location.paragraph, null);
  assert.equal(whole.location.found, true);

  await assert.rejects(
    callJson(api, "book_note_add", { chapterId: "ch-001", paragraph: 40, text: "x" }),
    /has no paragraph 40/
  );
});

test("notes are listed by status and source, resolved with a reason, and reopened", async (t) => {
  const { api } = await seed(t);
  const a = await callJson(api, "book_note_add", { chapterId: "ch-001", text: "A", source: "Lektorat" });
  await callJson(api, "book_note_add", { chapterId: "ch-001", text: "B", source: "Testleserin A" });

  await callJson(api, "book_note_resolve", { noteId: a.note.id, resolution: "Absatz gestrichen." });
  const open = await callJson(api, "book_note_list", {});
  assert.deepEqual(open.notes.map((n) => n.text), ["B"]);
  assert.deepEqual(open.bySource, { "Testleserin A": 1 });

  const resolved = await callJson(api, "book_note_list", { status: "resolved", source: "lektorat" });
  assert.equal(resolved.notes[0].resolution, "Absatz gestrichen.");

  await callJson(api, "book_note_resolve", { noteId: a.note.id, reopen: true });
  assert.equal((await callJson(api, "book_note_list", {})).count, 2);

  await callJson(api, "book_note_delete", { noteId: a.note.id });
  await assert.rejects(callJson(api, "book_note_delete", { noteId: a.note.id }), /not found/);
});

test("marking a chapter final with open notes warns, and the dashboard counts them", async (t) => {
  const { api } = await seed(t);
  await callJson(api, "book_note_add", { chapterId: "ch-001", text: "Offen.", source: "Lektorat" });

  const updated = await callJson(api, "book_chapter_update", { chapterId: "ch-001", status: "final" });
  assert.match(updated.warnings.join(" "), /1 open note\(s\) on this chapter \(Lektorat\)/);
  assert.equal(updated.meta.status, "final", "the author still decides");

  const { health } = await callJson(api, "book_dashboard", {});
  const feedback = health.find((f) => f.area === "feedback");
  assert.equal(feedback.severity, "serious", "open feedback on a final chapter");
  assert.match(feedback.detail, /already marked final/);
});

test("deleting a chapter reports the notes left pointing at it", async (t) => {
  const { api } = await seed(t);
  await callJson(api, "book_note_add", { chapterId: "ch-001", text: "Offen." });
  const deleted = await callJson(api, "book_chapter_delete", { chapterId: "ch-001", confirm: true });
  assert.ok(deleted.danglingReferences.some((r) => /1 note\(s\) on this chapter \(1 open\)/.test(r)));
});
