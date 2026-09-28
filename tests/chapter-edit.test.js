const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

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

// Umlauts, an eszett and a repeated phrase, so the awkward cases are present
// from the start rather than bolted on in one test.
const CHAPTER = `# Die Kaimauer

Mara ging über die Kaimauer. Das Wasser war grau.

Kell flickte Netze und sagte nichts. Das Wasser war grau.

Später schloß sie die Tür und ging.
`;

async function seed(t, content = CHAPTER) {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const api = tools();
  await callJson(api, "book_init", {
    title: "Testbuch",
    author: "A. Autorin",
    genre: "Krimi",
  });
  const created = await callJson(api, "book_chapter_create", {
    title: "Die Kaimauer",
    synopsis: "s",
    content,
  });
  return { dir, api, chapterId: created.chapterId };
}

const readFile = (dir, api) =>
  callJson(api, "book_chapter_read", { chapterId: "ch-001" }).then((r) => r.content);

test("a single match is replaced and the rest of the chapter is untouched", async (t) => {
  const { dir, api, chapterId } = await seed(t);
  const before = await readFile(dir, api);

  const result = await callJson(api, "book_chapter_replace_text", {
    chapterId,
    oldText: "Kell flickte Netze und sagte nichts.",
    newText: "Kell flickte Netze und pfiff.",
  });

  assert.equal(result.matches, 1);
  assert.equal(result.replaced, 1);
  assert.equal(typeof result.wordCountBefore, "number");
  assert.equal(typeof result.wordCountAfter, "number");

  const after = await readFile(dir, api);

  // The point of the tool: everything except the replaced passage is identical.
  assert.equal(
    after,
    before.replace(
      "Kell flickte Netze und sagte nichts.",
      "Kell flickte Netze und pfiff."
    ),
    "only the matched passage may change"
  );
  assert.ok(after.includes("Mara ging über die Kaimauer."));
  assert.ok(after.includes("Später schloß sie die Tür und ging."));
  assert.ok(after.startsWith("# Die Kaimauer"));
});

test("the reply stays small on a chapter worth saving tokens on", async (t) => {
  // The point of the tool is a reply far smaller than the chapter. On a
  // four-paragraph chapter an 80-character context window covers most of it
  // anyway, so the claim is only meaningful at a realistic length.
  const body = Array.from(
    { length: 200 },
    (_, i) => `Absatz ${i}. Hier steht Prosa, die niemand zurückbekommen möchte.`
  ).join("\n\n");
  const chapter = `# Langes Kapitel\n\n${body}\n\nDie gesuchte Stelle steht hier.\n`;
  const { api, chapterId } = await seed(t, chapter);

  const result = await callJson(api, "book_chapter_replace_text", {
    chapterId,
    oldText: "Die gesuchte Stelle steht hier.",
    newText: "Die gesuchte Stelle steht jetzt dort.",
  });

  const serialised = JSON.stringify(result);
  assert.ok(
    serialised.length < chapter.length / 10,
    `reply ${serialised.length} chars vs chapter ${chapter.length} — it should be a fraction`
  );
  assert.ok(
    !serialised.includes("Absatz 5."),
    "text far from the edit must not come back"
  );
});

test("no match: nothing is written and the count is named", async (t) => {
  const { dir, api, chapterId } = await seed(t);
  const before = await readFile(dir, api);

  await assert.rejects(
    () =>
      callJson(api, "book_chapter_replace_text", {
        chapterId,
        oldText: "Diesen Satz gibt es nicht.",
        newText: "egal",
      }),
    /Found 0 occurrences/
  );

  assert.equal(await readFile(dir, api), before, "the chapter must be untouched");
  const history = await callJson(api, "book_chapter_history_list", { chapterId });
  assert.equal(history.snapshotCount, 0, "a refused edit files no version");
});

test("several matches without replaceAll: refused, with the count", async (t) => {
  const { dir, api, chapterId } = await seed(t);
  const before = await readFile(dir, api);

  await assert.rejects(
    () =>
      callJson(api, "book_chapter_replace_text", {
        chapterId,
        oldText: "Das Wasser war grau.",
        newText: "Das Wasser war schwarz.",
      }),
    /Found 2 occurrences/
  );

  assert.equal(await readFile(dir, api), before);
});

test("several matches with replaceAll: all are replaced", async (t) => {
  const { api, chapterId } = await seed(t);

  const result = await callJson(api, "book_chapter_replace_text", {
    chapterId,
    oldText: "Das Wasser war grau.",
    newText: "Das Wasser war schwarz.",
    replaceAll: true,
  });

  assert.equal(result.matches, 2);
  assert.equal(result.replaced, 2);

  const after = await callJson(api, "book_chapter_read", { chapterId });
  assert.equal(after.content.match(/Das Wasser war schwarz\./g).length, 2);
  assert.ok(!after.content.includes("Das Wasser war grau."));
});

test("umlauts, eszett and punctuation match exactly", async (t) => {
  const { api, chapterId } = await seed(t);

  const result = await callJson(api, "book_chapter_replace_text", {
    chapterId,
    oldText: "Später schloß sie die Tür und ging.",
    newText: "Später schloss sie die Tür und blieb.",
  });
  assert.equal(result.matches, 1);

  const after = await callJson(api, "book_chapter_read", { chapterId });
  assert.ok(after.content.includes("Später schloss sie die Tür und blieb."));
  assert.ok(!after.content.includes("schloß"));
});

test("a decomposed umlaut still matches the composed one on disk", async (t) => {
  const { api, chapterId } = await seed(t);

  // "ü" as u + combining diaeresis, which is what macOS hands over.
  const decomposed = "Mara ging über die Kaimauer.";
  assert.ok(
    !CHAPTER.includes(decomposed),
    "precondition: the chapter holds the composed form"
  );

  const result = await callJson(api, "book_chapter_replace_text", {
    chapterId,
    oldText: decomposed,
    newText: "Mara ging über den Steg.",
  });
  assert.equal(result.matches, 1, "NFC folding should make the two forms equal");

  const after = await callJson(api, "book_chapter_read", { chapterId });
  assert.ok(after.content.includes("Mara ging über den Steg."));
});

test("the previous version lands in the history and revert restores it", async (t) => {
  const { api, chapterId } = await seed(t);
  const original = (await callJson(api, "book_chapter_read", { chapterId })).content;

  const result = await callJson(api, "book_chapter_replace_text", {
    chapterId,
    oldText: "Kell flickte Netze und sagte nichts.",
    newText: "Kell war fort.",
  });
  assert.ok(result.previousVersionSaved, "a version should have been filed");

  const history = await callJson(api, "book_chapter_history_list", { chapterId });
  assert.equal(history.snapshotCount, 1);
  assert.equal(history.snapshots[0].timestamp, result.previousVersionSaved);

  await callJson(api, "book_chapter_revert", {
    chapterId,
    timestamp: result.previousVersionSaved,
  });

  const restored = await callJson(api, "book_chapter_read", { chapterId });
  assert.equal(restored.content, original, "revert should restore the text exactly");
});

test("dryRun reports the matches and writes nothing", async (t) => {
  const { dir, api, chapterId } = await seed(t);
  const before = await readFile(dir, api);

  const dry = await callJson(api, "book_chapter_replace_text", {
    chapterId,
    oldText: "Das Wasser war grau.",
    newText: "Das Wasser war schwarz.",
    replaceAll: true,
    dryRun: true,
  });

  assert.equal(dry.dryRun, true);
  assert.equal(dry.matches, 2);
  assert.equal(dry.wouldSucceed, true);
  assert.ok(dry.snippets.length > 0);

  assert.equal(await readFile(dir, api), before, "dryRun must not write");
  const history = await callJson(api, "book_chapter_history_list", { chapterId });
  assert.equal(history.snapshotCount, 0, "dryRun must file no version");
});

test("dryRun also reports why an edit would be refused", async (t) => {
  const { api, chapterId } = await seed(t);

  const dry = await callJson(api, "book_chapter_replace_text", {
    chapterId,
    oldText: "Das Wasser war grau.",
    newText: "x",
    dryRun: true,
  });

  assert.equal(dry.wouldSucceed, false);
  assert.match(dry.wouldFailWith, /Found 2 occurrences/);
});

test("a replacement containing $& is inserted literally", async (t) => {
  const { api, chapterId } = await seed(t);

  // String.replace would read these as patterns and mangle the prose.
  await callJson(api, "book_chapter_replace_text", {
    chapterId,
    oldText: "Kell war fort.",
    newText: "x",
    dryRun: true,
  }).catch(() => {});

  const result = await callJson(api, "book_chapter_replace_text", {
    chapterId,
    oldText: "Kell flickte Netze und sagte nichts.",
    newText: "Der Preis war $5 und $& blieb $1.",
  });
  assert.equal(result.matches, 1);

  const after = await callJson(api, "book_chapter_read", { chapterId });
  assert.ok(
    after.content.includes("Der Preis war $5 und $& blieb $1."),
    `the replacement must be literal, got: ${after.content}`
  );
});

test("an empty newText deletes the passage", async (t) => {
  const { api, chapterId } = await seed(t);

  const result = await callJson(api, "book_chapter_replace_text", {
    chapterId,
    oldText: " Das Wasser war grau.",
    newText: "",
    replaceAll: true,
  });
  assert.equal(result.replaced, 2);
  assert.ok(result.wordCountAfter < result.wordCountBefore);

  const after = await callJson(api, "book_chapter_read", { chapterId });
  assert.ok(!after.content.includes("Das Wasser war grau."));
  assert.ok(after.content.includes("Mara ging über die Kaimauer."));
});

test("an empty oldText is refused", async (t) => {
  const { api, chapterId } = await seed(t);
  await assert.rejects(
    () =>
      callJson(api, "book_chapter_replace_text", {
        chapterId,
        oldText: "",
        newText: "x",
      }),
    /cannot be empty/
  );
});

test("overlapping text counts the way a replacement behaves", async (t) => {
  const { api, chapterId } = await seed(t, "# T\n\naaa\n");

  // "aa" occurs once in "aaa" non-overlapping, which is what a replace does.
  const dry = await callJson(api, "book_chapter_replace_text", {
    chapterId,
    oldText: "aa",
    newText: "b",
    dryRun: true,
  });
  assert.equal(dry.matches, 1);
});

test("book_chapter_find reports paragraph numbers and context", async (t) => {
  const { api, chapterId } = await seed(t);

  const found = await callJson(api, "book_chapter_find", {
    chapterId,
    query: "Das Wasser war grau.",
  });

  assert.equal(found.matches, 2);
  assert.deepEqual(
    found.occurrences.map((o) => o.paragraph),
    [2, 3],
    "the two occurrences sit in paragraphs 2 and 3"
  );
  for (const occurrence of found.occurrences) {
    assert.equal(occurrence.match, "Das Wasser war grau.");
    assert.equal(typeof occurrence.before, "string");
    assert.equal(typeof occurrence.after, "string");
  }
});

test("book_chapter_find says so when nothing matches", async (t) => {
  const { api, chapterId } = await seed(t);
  const found = await callJson(api, "book_chapter_find", {
    chapterId,
    query: "Gibt es nicht",
  });
  assert.equal(found.matches, 0);
  assert.deepEqual(found.occurrences, []);
  assert.match(found.hint, /exact/);
});

test("many matches return a capped number of snippets", async (t) => {
  const body = Array.from({ length: 10 }, (_, i) => `Zeile ${i} mit Marke.`).join("\n\n");
  const { api, chapterId } = await seed(t, `# T\n\n${body}\n`);

  const result = await callJson(api, "book_chapter_replace_text", {
    chapterId,
    oldText: "Marke",
    newText: "Zeichen",
    replaceAll: true,
  });

  assert.equal(result.replaced, 10);
  assert.equal(result.snippets.length, 3, "snippets are capped");
  assert.equal(result.snippetsOmitted, 7);
});

test("book_chapter_read still returns the whole chapter by default", async (t) => {
  const { api, chapterId } = await seed(t);
  const whole = await callJson(api, "book_chapter_read", { chapterId });
  assert.equal(whole.content, CHAPTER);
  assert.equal(whole.paragraphRange, undefined, "the default response is unchanged");
});

test("book_chapter_read can return a paragraph range", async (t) => {
  const { api, chapterId } = await seed(t);

  const part = await callJson(api, "book_chapter_read", {
    chapterId,
    fromParagraph: 2,
    toParagraph: 2,
  });
  assert.equal(part.content, "Mara ging über die Kaimauer. Das Wasser war grau.");
  assert.equal(part.paragraphRange.totalParagraphs, 4);
  assert.equal(part.paragraphRange.truncated, true);

  // An open end reads to the end of the chapter.
  const tail = await callJson(api, "book_chapter_read", { chapterId, fromParagraph: 4 });
  assert.ok(tail.content.startsWith("Später schloß"));

  await assert.rejects(
    () => callJson(api, "book_chapter_read", { chapterId, fromParagraph: 3, toParagraph: 2 }),
    /is after toParagraph/
  );
  await assert.rejects(
    () => callJson(api, "book_chapter_read", { chapterId, fromParagraph: 99 }),
    /does not exist/
  );
});

test("concurrent replacements on one chapter do not lose each other", async (t) => {
  const { api, chapterId } = await seed(t);

  await Promise.all([
    callJson(api, "book_chapter_replace_text", {
      chapterId,
      oldText: "Mara ging über die Kaimauer.",
      newText: "Mara stand auf der Kaimauer.",
    }),
    callJson(api, "book_chapter_replace_text", {
      chapterId,
      oldText: "Später schloß sie die Tür und ging.",
      newText: "Später blieb die Tür offen.",
    }),
  ]);

  const after = await callJson(api, "book_chapter_read", { chapterId });
  assert.ok(after.content.includes("Mara stand auf der Kaimauer."), "first edit survived");
  assert.ok(after.content.includes("Später blieb die Tür offen."), "second edit survived");
});
