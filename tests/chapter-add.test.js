const test = require("node:test");
const assert = require("node:assert/strict");

const { collectTools, callJson } = require("./helpers/tools");
const { useTempProject, cleanup } = require("./helpers/project");

function tools() {
  const m = (n) => require(`../dist-tsc/tools/${n}`);
  return collectTools(
    m("manuscript").registerManuscriptTools,
    m("history").registerHistoryTools,
    m("chapter-edit").registerChapterEditTools
  );
}

// Four paragraphs as book_chapter_find numbers them: the heading is 1.
const CHAPTER = `# Die Kaimauer

Mara ging über die Kaimauer. Das Wasser war grau.

Kell flickte Netze und sagte nichts.

Später schloß sie die Tür und ging.
`;

async function seed(t, content = CHAPTER) {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const api = tools();
  await callJson(api, "book_init", { title: "Testbuch", author: "A", genre: "Krimi", language: "de" });
  const created = await callJson(api, "book_chapter_create", {
    title: "Die Kaimauer",
    synopsis: "s",
    ...(content === null ? {} : { content }),
  });
  return { dir, api, chapterId: created.chapterId };
}

const read = (api, chapterId) =>
  callJson(api, "book_chapter_read", { chapterId }).then((r) => r.content);

const history = (api, chapterId) =>
  callJson(api, "book_chapter_history_list", { chapterId }).then((h) => h.snapshotCount);

// ---------------------------------------------------------------------------
// book_chapter_append

test("append adds a paragraph at the end and leaves the rest exactly as it was", async (t) => {
  const { api, chapterId } = await seed(t);

  const result = await callJson(api, "book_chapter_append", {
    chapterId,
    content: "Am Morgen war der Hafen leer.",
  });

  assert.equal(result.chapterId, chapterId);
  assert.equal(result.firstNewParagraph, 5);
  assert.equal(result.paragraphsAdded, 1);
  assert.equal(result.wordsAdded, 6);
  assert.equal(typeof result.wordCount, "number");

  const after = await read(api, chapterId);
  assert.equal(after, `${CHAPTER.trimEnd()}\n\nAm Morgen war der Hafen leer.\n`);

  // The paragraph number agrees with the one book_chapter_find reports.
  const found = await callJson(api, "book_chapter_find", { chapterId, query: "Hafen leer" });
  assert.equal(found.occurrences[0].paragraph, result.firstNewParagraph);

  const meta = await callJson(api, "book_chapter_list", {});
  assert.equal(meta.chapters[0].wordCount, result.wordCount, "the registry count is kept in step");
});

test("append never echoes the chapter text, not even on a long chapter", async (t) => {
  const body = Array.from({ length: 200 }, (_, i) => `Absatz ${i}. Prosa, die niemand zurückhaben möchte.`).join("\n\n");
  const chapter = `# Lang\n\n${body}\n`;
  const { api, chapterId } = await seed(t, chapter);

  const result = await callJson(api, "book_chapter_append", { chapterId, content: "Das Ende naht." });
  const reply = JSON.stringify(result);

  assert.ok(reply.length < 1000, `reply is ${reply.length} chars`);
  assert.ok(!reply.includes("Prosa, die niemand"), "existing text must not come back");
  assert.ok(!reply.includes("Das Ende naht"), "the added text is not echoed either");
  assert.equal(result.firstNewParagraph, 202, "heading + 200 paragraphs, then the new one");
});

test("several paragraphs are added as paragraphs, with exactly one blank line at the seam", async (t) => {
  const { api, chapterId } = await seed(t);

  const result = await callJson(api, "book_chapter_append", {
    chapterId,
    content: "\n\n\nErster neuer Absatz.\n\nZweiter neuer Absatz.\n\n\n",
  });

  assert.equal(result.firstNewParagraph, 5);
  assert.equal(result.paragraphsAdded, 2);
  const after = await read(api, chapterId);
  assert.ok(
    after.endsWith("und ging.\n\nErster neuer Absatz.\n\nZweiter neuer Absatz.\n"),
    JSON.stringify(after.slice(-80))
  );
});

test("sceneBreak puts a scene break in front instead of a blank line", async (t) => {
  const { api, chapterId } = await seed(t);

  const result = await callJson(api, "book_chapter_append", {
    chapterId,
    content: "Drei Tage später.",
    sceneBreak: true,
  });

  assert.equal(result.sceneBreakParagraph, 5);
  assert.equal(result.firstNewParagraph, 6);
  assert.equal(result.wordsAdded, 3, "the scene break is not counted as words");
  const after = await read(api, chapterId);
  assert.ok(after.endsWith("und ging.\n\n* * *\n\nDrei Tage später.\n"), JSON.stringify(after.slice(-60)));
});

test("sceneBreak reuses the marker the chapter already uses", async (t) => {
  const { api, chapterId } = await seed(t, "# T\n\nErste Szene.\n\n#\n\nZweite Szene.\n");

  await callJson(api, "book_chapter_append", { chapterId, content: "Dritte Szene.", sceneBreak: true });

  const after = await read(api, chapterId);
  assert.ok(after.endsWith("Zweite Szene.\n\n#\n\nDritte Szene.\n"), JSON.stringify(after));
});

test("sceneBreak is left out when there is no prose yet to separate from", async (t) => {
  const { api, chapterId } = await seed(t, null); // "# Die Kaimauer" and nothing else

  const result = await callJson(api, "book_chapter_append", {
    chapterId,
    content: "Der erste Satz.",
    sceneBreak: true,
  });

  assert.equal(result.sceneBreakParagraph, undefined);
  assert.match(result.note, /no prose yet/);
  assert.equal(await read(api, chapterId), "# Die Kaimauer\n\nDer erste Satz.\n");
  assert.equal(result.firstNewParagraph, 2);
});

test("append files the previous version and book_chapter_revert undoes it", async (t) => {
  const { api, chapterId } = await seed(t);
  const original = await read(api, chapterId);

  const result = await callJson(api, "book_chapter_append", { chapterId, content: "Neu." });
  assert.ok(result.previousVersionSaved);
  assert.equal(await history(api, chapterId), 1);

  await callJson(api, "book_chapter_revert", { chapterId, timestamp: result.previousVersionSaved });
  assert.equal(await read(api, chapterId), original, "revert restores the text exactly");
});

test("append to a chapter whose file is still empty can be reverted too", async (t) => {
  const { dir, api, chapterId } = await seed(t);
  // A chapter registered but never written: the file is empty.
  const fs = require("node:fs");
  const path = require("node:path");
  const file = fs.readdirSync(path.join(dir, "chapters"))[0];
  fs.writeFileSync(path.join(dir, "chapters", file), "");

  const result = await callJson(api, "book_chapter_append", { chapterId, content: "Erster Satz." });
  assert.equal(await read(api, chapterId), "Erster Satz.\n");
  assert.equal(result.firstNewParagraph, 1);

  await callJson(api, "book_chapter_revert", { chapterId, timestamp: result.previousVersionSaved });
  assert.equal(await read(api, chapterId), "");
});

test("append dryRun reports the numbers and writes nothing", async (t) => {
  const { api, chapterId } = await seed(t);

  const dry = await callJson(api, "book_chapter_append", {
    chapterId,
    content: "Am Morgen war der Hafen leer.",
    dryRun: true,
  });

  assert.equal(dry.dryRun, true);
  assert.equal(dry.firstNewParagraph, 5);
  assert.equal(dry.wordsAdded, 6);
  assert.equal(await read(api, chapterId), CHAPTER, "dryRun must not write");
  assert.equal(await history(api, chapterId), 0, "dryRun must file no version");
});

test("empty content is refused and nothing is written", async (t) => {
  const { api, chapterId } = await seed(t);

  await assert.rejects(
    () => callJson(api, "book_chapter_append", { chapterId, content: " \n\n " }),
    /cannot be empty/
  );
  assert.equal(await read(api, chapterId), CHAPTER);
  assert.equal(await history(api, chapterId), 0);
});

test("concurrent appends to one chapter both land", async (t) => {
  const { api, chapterId } = await seed(t);

  await Promise.all([
    callJson(api, "book_chapter_append", { chapterId, content: "Erstens." }),
    callJson(api, "book_chapter_append", { chapterId, content: "Zweitens." }),
  ]);

  const after = await read(api, chapterId);
  assert.ok(after.includes("Erstens."), "first append survived");
  assert.ok(after.includes("Zweitens."), "second append survived");
  assert.equal(await history(api, chapterId), 2);
});

// ---------------------------------------------------------------------------
// book_chapter_insert

test("insert after a paragraph puts the text between it and the next one", async (t) => {
  const { api, chapterId } = await seed(t);

  const result = await callJson(api, "book_chapter_insert", {
    chapterId,
    content: "Eine Möwe schrie.",
    afterParagraph: 2,
  });

  assert.equal(result.chapterId, chapterId);
  assert.equal(result.firstNewParagraph, 3);
  assert.equal(result.insertedAfterParagraph, 2);
  assert.equal(result.wordsAdded, 3);

  const after = await read(api, chapterId);
  assert.equal(
    after,
    CHAPTER.replace(
      "Das Wasser war grau.\n\n",
      "Das Wasser war grau.\n\nEine Möwe schrie.\n\n"
    )
  );

  // The paragraphs that followed have moved down by one.
  const found = await callJson(api, "book_chapter_find", { chapterId, query: "Kell flickte" });
  assert.equal(found.occurrences[0].paragraph, 4);
});

test("insert before a paragraph puts the text in front of it", async (t) => {
  const { api, chapterId } = await seed(t);

  const result = await callJson(api, "book_chapter_insert", {
    chapterId,
    content: "Es war früh.\n\nNiemand war wach.",
    beforeParagraph: 2,
  });

  assert.equal(result.firstNewParagraph, 2);
  assert.equal(result.paragraphsAdded, 2);
  assert.equal(result.insertedBeforeParagraph, 2);

  const after = await read(api, chapterId);
  assert.equal(
    after,
    CHAPTER.replace("# Die Kaimauer\n\n", "# Die Kaimauer\n\nEs war früh.\n\nNiemand war wach.\n\n")
  );
});

test("insert after the last paragraph behaves like append", async (t) => {
  const { api, chapterId } = await seed(t);

  const result = await callJson(api, "book_chapter_insert", {
    chapterId,
    content: "Schluss.",
    afterParagraph: 4,
  });

  assert.equal(result.firstNewParagraph, 5);
  assert.equal(await read(api, chapterId), `${CHAPTER.trimEnd()}\n\nSchluss.\n`);
});

test("insert reports only short excerpts of the neighbours, not the chapter", async (t) => {
  const long = "Wort ".repeat(100).trim() + ".";
  const { api, chapterId } = await seed(t, `# T\n\n${long}\n\nKurz.\n`);

  const result = await callJson(api, "book_chapter_insert", {
    chapterId,
    content: "Dazwischen.",
    afterParagraph: 2,
  });

  assert.ok(result.between.before.length <= 61, result.between.before);
  assert.ok(result.between.before.startsWith("…"));
  assert.equal(result.between.after, "Kurz.");
  assert.ok(!JSON.stringify(result).includes(long));
});

test("insert needs exactly one of afterParagraph and beforeParagraph", async (t) => {
  const { api, chapterId } = await seed(t);

  await assert.rejects(
    () => callJson(api, "book_chapter_insert", { chapterId, content: "x" }),
    /exactly one of afterParagraph or beforeParagraph/
  );
  await assert.rejects(
    () =>
      callJson(api, "book_chapter_insert", {
        chapterId,
        content: "x",
        afterParagraph: 1,
        beforeParagraph: 2,
      }),
    /exactly one of afterParagraph or beforeParagraph/
  );
  assert.equal(await read(api, chapterId), CHAPTER);
});

test("insert at a paragraph that does not exist is refused and writes nothing", async (t) => {
  const { api, chapterId } = await seed(t);

  await assert.rejects(
    () => callJson(api, "book_chapter_insert", { chapterId, content: "x", afterParagraph: 9 }),
    /has 4 paragraph\(s\), so paragraph 9 does not exist/
  );
  await assert.rejects(
    () => callJson(api, "book_chapter_insert", { chapterId, content: "x", beforeParagraph: 0 }),
    /start at 1/
  );
  await assert.rejects(
    () => callJson(api, "book_chapter_insert", { chapterId, content: "x", afterParagraph: 1.5 }),
    /whole number/
  );

  assert.equal(await read(api, chapterId), CHAPTER);
  assert.equal(await history(api, chapterId), 0, "a refused insert files no version");
});

test("insert files the previous version and book_chapter_revert undoes it", async (t) => {
  const { api, chapterId } = await seed(t);

  const result = await callJson(api, "book_chapter_insert", {
    chapterId,
    content: "Eingeschoben.",
    beforeParagraph: 3,
  });
  assert.ok(result.previousVersionSaved);

  await callJson(api, "book_chapter_revert", { chapterId, timestamp: result.previousVersionSaved });
  assert.equal(await read(api, chapterId), CHAPTER);
});

test("insert dryRun reports the position and writes nothing", async (t) => {
  const { api, chapterId } = await seed(t);

  const dry = await callJson(api, "book_chapter_insert", {
    chapterId,
    content: "Eine Möwe schrie.",
    afterParagraph: 3,
    dryRun: true,
  });

  assert.equal(dry.dryRun, true);
  assert.equal(dry.firstNewParagraph, 4);
  assert.equal(dry.between.before, "Kell flickte Netze und sagte nichts.");
  assert.equal(await read(api, chapterId), CHAPTER);
  assert.equal(await history(api, chapterId), 0);
});

test("insert into a chapter that holds only its heading", async (t) => {
  const { api, chapterId } = await seed(t, null);

  const result = await callJson(api, "book_chapter_insert", {
    chapterId,
    content: "Der erste Absatz.",
    afterParagraph: 1,
  });

  assert.equal(result.firstNewParagraph, 2);
  assert.equal(await read(api, chapterId), "# Die Kaimauer\n\nDer erste Absatz.\n");
});

test("append and insert accept a chapter by position", async (t) => {
  const { api } = await seed(t);

  const appended = await callJson(api, "book_chapter_append", { chapterId: "#1", content: "Ende." });
  assert.equal(appended.chapterId, "ch-001");
  const inserted = await callJson(api, "book_chapter_insert", {
    chapterId: "#1",
    content: "Mitte.",
    afterParagraph: 2,
  });
  assert.equal(inserted.chapterId, "ch-001");
});
