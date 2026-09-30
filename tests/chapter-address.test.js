const test = require("node:test");
const assert = require("node:assert/strict");

const { collectTools, callJson } = require("./helpers/tools");
const { useTempProject, cleanup } = require("./helpers/project");

function tools() {
  const m = (n) => require(`../dist-tsc/tools/${n}`);
  return collectTools(
    m("manuscript").registerManuscriptTools,
    m("chapter-edit").registerChapterEditTools,
    m("book-edit").registerBookEditTools
  );
}

async function project(t, titles) {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const api = tools();
  await callJson(api, "book_init", { title: "T", author: "A", genre: "G", language: "de" });
  for (const title of titles) {
    await callJson(api, "book_chapter_create", {
      title,
      synopsis: "s",
      content: `# ${title}\n\nText von ${title}.\n`,
    });
  }
  return api;
}

const idOf = (api, ref) =>
  callJson(api, "book_chapter_read", { chapterId: ref }).then((r) => r.meta.id);

// ---------------------------------------------------------------------------
// By position

test('"#N" is the Nth chapter in reading order, not the Nth id', async (t) => {
  const api = await project(t, ["Eins", "Zwei", "Drei"]);

  // ch-003 moves to the front: from now on it is chapter 1.
  await callJson(api, "book_chapter_reorder", { chapterId: "ch-003", newOrder: 1 });

  assert.equal(await idOf(api, "#1"), "ch-003");
  assert.equal(await idOf(api, "#2"), "ch-001");
  assert.equal(await idOf(api, "# 3"), "ch-002", "a space after # is allowed");
});

test("a position past the last chapter is refused with the range", async (t) => {
  const api = await project(t, ["Eins", "Zwei"]);

  await assert.rejects(() => idOf(api, "#3"), /no chapter #3: the book has 2 chapter\(s\), #1 to #2/);
  await assert.rejects(() => idOf(api, "#0"), /no chapter #0/);
});

test("ids and exact titles still win over a position", async (t) => {
  const api = await project(t, ["Eins", "#1"]);

  assert.equal(await idOf(api, "ch-001"), "ch-001");
  // A chapter actually titled "#1" answered to that name before positions
  // existed, and still does.
  assert.equal(await idOf(api, "#1"), "ch-002");
  assert.equal(await idOf(api, "#2"), "ch-002");
});

test("positions work wherever chapters are named, including chapter lists", async (t) => {
  const api = await project(t, ["Eins", "Zwei"]);

  const found = await callJson(api, "book_find", { query: "Text von", chapters: ["#2"] });
  assert.deepEqual(
    found.results.map((r) => r.chapterId),
    ["ch-002"]
  );

  const replaced = await callJson(api, "book_chapter_replace_text", {
    chapterId: "#2",
    oldText: "Text von Zwei.",
    newText: "Anderer Text.",
  });
  assert.equal(replaced.chapterId, "ch-002");
});

// ---------------------------------------------------------------------------
// Titles with umlauts spelled out

test("ue/ae/oe/ss in a title find the chapter spelled with ü/ä/ö/ß", async (t) => {
  const api = await project(t, ["Über die Brücke", "Die Straße", "Mädchen und Löwen"]);

  assert.equal(await idOf(api, "Ueber die Bruecke"), "ch-001");
  assert.equal(await idOf(api, "ueber die bruecke"), "ch-001");
  assert.equal(await idOf(api, "Die Strasse"), "ch-002");
  assert.equal(await idOf(api, "Maedchen und Loewen"), "ch-003");
  // And the other way round.
  const api2 = await project(t, ["Gruesse aus Koeln"]);
  assert.equal(await idOf(api2, "Grüße aus Köln"), "ch-001");
});

test("the folding is only for comparing: nothing on disk changes", async (t) => {
  const api = await project(t, ["Über die Brücke"]);

  await callJson(api, "book_chapter_update", { chapterId: "Ueber die Bruecke", synopsis: "neu" });

  const [meta] = (await callJson(api, "book_chapter_list", {})).chapters;
  assert.equal(meta.title, "Über die Brücke");
  assert.equal(meta.synopsis, "neu");
});

test("an exact title wins over one that only matches once folded", async (t) => {
  const api = await project(t, ["Maße", "Masse"]);

  assert.equal(await idOf(api, "Masse"), "ch-002");
  assert.equal(await idOf(api, "Maße"), "ch-001");
});

test("a folded title matching several chapters is refused with the candidates", async (t) => {
  const api = await project(t, ["Grüße", "Gruesse"]);

  // Neither title exactly, but both once folded.
  await assert.rejects(
    () => idOf(api, "Grüsse"),
    (err) => {
      assert.match(err.message, /could be any of several chapters/);
      assert.match(err.message, /ch-001 \("Grüße", #1\)/);
      assert.match(err.message, /ch-002 \("Gruesse", #2\)/);
      assert.match(err.message, /Use the chapter id or "#N"/);
      return true;
    }
  );
});

test("an unknown chapter names every chapter with its id, title and position", async (t) => {
  const api = await project(t, ["Eins", "Zwei"]);

  await assert.rejects(
    () => idOf(api, "Drei"),
    /Chapter "Drei" not found\. Known chapters: ch-001 \("Eins", #1\), ch-002 \("Zwei", #2\)/
  );
});

test("the chapterId description mentions positions", () => {
  const api = tools();
  assert.match(api.book_chapter_append.schema.chapterId.description, /"#N"/);
  assert.match(api.book_chapter_read.schema.chapterId.description, /"#N"/);
});
