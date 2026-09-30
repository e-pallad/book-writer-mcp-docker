const test = require("node:test");
const assert = require("node:assert/strict");

const { collectTools, callJson } = require("./helpers/tools");
const { useTempProject, cleanup } = require("./helpers/project");

function tools() {
  const m = (n) => require(`../dist-tsc/tools/${n}`);
  return collectTools(m("manuscript").registerManuscriptTools, m("history").registerHistoryTools);
}

// Ten words of prose after a two-word heading: twelve words in all.
const CHAPTER = "# Der Hafen\n\nEins zwei drei vier fünf sechs sieben acht neun zehn.\n";

async function seed(t) {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const api = tools();
  await callJson(api, "book_init", { title: "T", author: "A", genre: "G", language: "de" });
  const { chapterId } = await callJson(api, "book_chapter_create", {
    title: "Der Hafen",
    synopsis: "s",
    content: CHAPTER,
  });
  return { api, chapterId };
}

const read = (api, chapterId) =>
  callJson(api, "book_chapter_read", { chapterId }).then((r) => r.content);

test("a content more than 30% shorter is refused with both word counts", async (t) => {
  const { api, chapterId } = await seed(t);

  await assert.rejects(
    () =>
      callJson(api, "book_chapter_update", {
        chapterId,
        content: "Nur noch ein Absatz.",
      }),
    (err) => {
      assert.match(err.message, /new content has 4 words/);
      assert.match(err.message, /has 12/);
      assert.match(err.message, /Nothing was written/);
      assert.match(err.message, /book_chapter_replace_text, book_chapter_append or book_chapter_insert/);
      assert.match(err.message, /confirmShrink=true/);
      return true;
    }
  );

  assert.equal(await read(api, chapterId), CHAPTER, "the chapter must be untouched");
  const history = await callJson(api, "book_chapter_history_list", { chapterId });
  assert.equal(history.snapshotCount, 0, "a refused update files no version");
});

test("a refused update changes nothing else passed along with it", async (t) => {
  const { api, chapterId } = await seed(t);

  await assert.rejects(
    () =>
      callJson(api, "book_chapter_update", {
        chapterId,
        content: "Kurz.",
        title: "Neuer Titel",
        status: "final",
      }),
    /Refused/
  );

  const [meta] = (await callJson(api, "book_chapter_list", {})).chapters;
  assert.equal(meta.title, "Der Hafen", "the rename must not have happened");
  assert.equal(meta.status, "draft");
});

test("confirmShrink=true lets an intended cut through, and it can be reverted", async (t) => {
  const { api, chapterId } = await seed(t);

  const result = await callJson(api, "book_chapter_update", {
    chapterId,
    content: "# Der Hafen\n\nKurz.\n",
    confirmShrink: true,
  });
  assert.equal(result.wordCount, 3);
  assert.equal(await read(api, chapterId), "# Der Hafen\n\nKurz.\n");

  await callJson(api, "book_chapter_revert", { chapterId, timestamp: result.previousVersionSaved });
  assert.equal(await read(api, chapterId), CHAPTER);
});

test("a moderate cut goes through; growing or a metadata change never asks", async (t) => {
  const { api, chapterId } = await seed(t);

  // 12 words -> 9 words is 25% shorter.
  await callJson(api, "book_chapter_update", {
    chapterId,
    content: "# Der Hafen\n\nEins zwei drei vier fünf sechs sieben.\n",
  });
  // 9 words -> 7 words is 22% shorter.
  await callJson(api, "book_chapter_update", {
    chapterId,
    content: "# Der Hafen\n\nEins zwei drei vier fünf.\n",
  });

  await callJson(api, "book_chapter_update", {
    chapterId,
    content: "# Der Hafen\n\nEins zwei drei vier fünf sechs sieben acht neun zehn elf zwölf.\n",
  });
  await callJson(api, "book_chapter_update", { chapterId, status: "review", synopsis: "neu" });

  const [meta] = (await callJson(api, "book_chapter_list", {})).chapters;
  assert.equal(meta.wordCount, 14);
  assert.equal(meta.status, "review");
});

test("the 30% boundary itself is allowed", async (t) => {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const api = tools();
  await callJson(api, "book_init", { title: "T", author: "A", genre: "G" });
  const { chapterId } = await callJson(api, "book_chapter_create", {
    title: "X",
    synopsis: "s",
    content: "a b c d e f g h i j", // ten words, no heading
  });

  // 10 -> 7 is exactly 30% shorter: allowed.
  await callJson(api, "book_chapter_update", { chapterId, content: "a b c d e f g" });
  // 7 -> 4 is 43% shorter: refused.
  await assert.rejects(
    () => callJson(api, "book_chapter_update", { chapterId, content: "a b c d" }),
    /4 words, the chapter "ch-001" \("X"\) has 7 — 43% shorter/
  );
});

test("the tool description points at the partial-edit tools", async (t) => {
  const api = tools();
  const update = api.book_chapter_update;
  assert.match(update.description, /book_chapter_replace_text, book_chapter_append or book_chapter_insert/);
  assert.ok(update.schema.confirmShrink, "confirmShrink is part of the schema");
});
