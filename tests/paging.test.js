const test = require("node:test");
const assert = require("node:assert/strict");

const { collectTools, callJson } = require("./helpers/tools");
const { useTempProject, cleanup } = require("./helpers/project");

function tools() {
  const m = (n) => require(`../dist-tsc/tools/${n}`);
  return collectTools(m("manuscript").registerManuscriptTools, m("outline").registerOutlineTools);
}

// Three acts, six planned chapters; the third act has no chapters yet.
const PLAN = [
  {
    act: "Erster Akt",
    chapters: [
      { title: "Ankunft", synopsis: "a" },
      { title: "Der Kai", synopsis: "b" },
      { title: "Über die Brücke", synopsis: "c" },
    ],
  },
  {
    act: "Zweiter Akt",
    chapters: [
      { title: "Die Kneipe", synopsis: "d" },
      { title: "Das Boot", synopsis: "e" },
      { title: "Flucht", synopsis: "f" },
    ],
  },
  { act: "Dritter Akt", chapters: [] },
];

async function seed(t, { outline = true } = {}) {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const api = tools();
  await callJson(api, "book_init", { title: "T", author: "A", genre: "G", language: "de" });
  if (outline) await callJson(api, "book_outline_set", { outline: PLAN });
  for (const title of ["Ankunft", "Der Kai", "Über die Brücke", "Die Kneipe", "Das Boot"]) {
    await callJson(api, "book_chapter_create", { title, synopsis: "s", content: `# ${title}\n\nText.` });
  }
  return { dir, api };
}

const ids = (reply) => reply.chapters.map((c) => c.id);

// ---------------------------------------------------------------------------
// book_chapter_list

test("book_chapter_list without paging lists every chapter and no page", async (t) => {
  const { api } = await seed(t);
  const all = await callJson(api, "book_chapter_list", {});
  assert.deepEqual(ids(all), ["ch-001", "ch-002", "ch-003", "ch-004", "ch-005"]);
  assert.equal(all.page, undefined);
});

test("book_chapter_list pages with limit and continues from nextFromChapter", async (t) => {
  const { api } = await seed(t);

  const first = await callJson(api, "book_chapter_list", { limit: 2 });
  assert.deepEqual(ids(first), ["ch-001", "ch-002"]);
  assert.deepEqual(first.page, { total: 5, returned: 2, nextFromChapter: 3 });

  const seen = [...ids(first)];
  let next = first.page.nextFromChapter;
  while (next !== undefined) {
    const page = await callJson(api, "book_chapter_list", { fromChapter: next, limit: 2 });
    seen.push(...ids(page));
    next = page.page.nextFromChapter;
  }
  assert.deepEqual(seen, ["ch-001", "ch-002", "ch-003", "ch-004", "ch-005"]);
});

test("book_chapter_list numbers by reading order, not by id", async (t) => {
  const { api } = await seed(t);
  await callJson(api, "book_chapter_reorder", { chapterId: "ch-005", newOrder: 1 });

  const page = await callJson(api, "book_chapter_list", { fromChapter: 2, limit: 1 });
  assert.deepEqual(ids(page), ["ch-001"]);
  assert.equal(page.page.nextFromChapter, 3);
});

test("book_chapter_list takes fromChapter as an id, a title, \"#N\" or a number sent as text", async (t) => {
  const { api } = await seed(t);
  for (const fromChapter of ["ch-004", "Die Kneipe", "#4", "4", 4]) {
    const page = await callJson(api, "book_chapter_list", { fromChapter });
    assert.deepEqual(ids(page), ["ch-004", "ch-005"], `fromChapter=${JSON.stringify(fromChapter)}`);
    assert.equal(page.page.nextFromChapter, undefined);
  }
  // Umlauts spelled out resolve as they do everywhere else.
  const folded = await callJson(api, "book_chapter_list", { fromChapter: "Ueber die Bruecke", limit: 1 });
  assert.deepEqual(ids(folded), ["ch-003"]);
});

test("book_chapter_list filters by act, through the outline", async (t) => {
  const { api } = await seed(t);

  const second = await callJson(api, "book_chapter_list", { act: 2 });
  assert.deepEqual(ids(second), ["ch-004", "ch-005"]);
  assert.deepEqual(second.page, { total: 2, returned: 2, act: { number: 2, name: "Zweiter Akt" } });

  for (const act of ["Erster Akt", "erster akt", "1"]) {
    const first = await callJson(api, "book_chapter_list", { act });
    assert.deepEqual(ids(first), ["ch-001", "ch-002", "ch-003"], `act=${act}`);
  }

  // Paging within an act: numbers stay the book's reading order.
  const paged = await callJson(api, "book_chapter_list", { act: 1, fromChapter: 2, limit: 1 });
  assert.deepEqual(ids(paged), ["ch-002"]);
  assert.deepEqual(paged.page, {
    total: 3,
    returned: 1,
    nextFromChapter: 3,
    act: { number: 1, name: "Erster Akt" },
  });

  const empty = await callJson(api, "book_chapter_list", { act: 3 });
  assert.deepEqual(empty.chapters, []);
  assert.equal(empty.page.total, 0);
});

test("book_chapter_list refuses what it cannot page by", async (t) => {
  const { api } = await seed(t);
  await assert.rejects(callJson(api, "book_chapter_list", { limit: 0 }), /limit must be a whole number/);
  await assert.rejects(callJson(api, "book_chapter_list", { fromChapter: 9 }), /no chapter #9: the book has 5/);
  await assert.rejects(callJson(api, "book_chapter_list", { fromChapter: "Nirgendwo" }), /not found/);
  await assert.rejects(callJson(api, "book_chapter_list", { act: 7 }), /no act "7"\. Acts: 1 \("Erster Akt"\)/);
  await assert.rejects(callJson(api, "book_chapter_list", { act: 1.5 }), /no act "1.5"/);
  await assert.rejects(callJson(api, "book_chapter_list", { limit: 2.5 }), /limit must be a whole number/);
});

test("book_chapter_list with act needs an outline", async (t) => {
  const { api } = await seed(t, { outline: false });
  await assert.rejects(callJson(api, "book_chapter_list", { act: 1 }), /grouped into acts by the outline/);
});

// ---------------------------------------------------------------------------
// book_outline_get

test("book_outline_get numbers acts and chapters, and shows every act without paging", async (t) => {
  const { api } = await seed(t);
  const outline = await callJson(api, "book_outline_get", {});
  assert.deepEqual(
    outline.acts.map((a) => [a.number, a.act, a.chapters.map((c) => c.number)]),
    [
      [1, "Erster Akt", [1, 2, 3]],
      [2, "Zweiter Akt", [4, 5, 6]],
      [3, "Dritter Akt", []],
    ]
  );
  assert.equal(outline.page, undefined);
  assert.deepEqual(outline.acts[1].chapters[2].written, null);
});

test("book_outline_get pages across acts and continues from nextFromChapter", async (t) => {
  const { api } = await seed(t);

  const first = await callJson(api, "book_outline_get", { fromChapter: 2, limit: 3 });
  assert.deepEqual(
    first.acts.map((a) => [a.number, a.chapters.map((c) => c.title)]),
    [
      [1, ["Der Kai", "Über die Brücke"]],
      [2, ["Die Kneipe"]],
    ]
  );
  assert.deepEqual(first.page, { total: 6, returned: 3, nextFromChapter: 5 });

  const rest = await callJson(api, "book_outline_get", { fromChapter: first.page.nextFromChapter, limit: 3 });
  assert.deepEqual(rest.acts.flatMap((a) => a.chapters.map((c) => c.number)), [5, 6]);
  assert.equal(rest.page.nextFromChapter, undefined);
});

test("book_outline_get filters by act and keeps the book-wide numbers", async (t) => {
  const { api } = await seed(t);
  const act = await callJson(api, "book_outline_get", { act: "Zweiter Akt", limit: 2 });
  assert.deepEqual(act.acts.length, 1);
  assert.deepEqual(act.acts[0].chapters.map((c) => c.number), [4, 5]);
  assert.deepEqual(act.page, {
    total: 3,
    returned: 2,
    nextFromChapter: 6,
    act: { number: 2, name: "Zweiter Akt" },
  });
});

test("book_outline_get takes fromChapter as a number, a title or the chapter it stands for", async (t) => {
  const { api } = await seed(t);
  const firstTitle = async (fromChapter) =>
    (await callJson(api, "book_outline_get", { fromChapter, limit: 1 })).acts[0].chapters[0].title;

  assert.equal(await firstTitle(3), "Über die Brücke");
  assert.equal(await firstTitle("#3"), "Über die Brücke");
  assert.equal(await firstTitle("Über die Brücke"), "Über die Brücke");
  assert.equal(await firstTitle("ueber die bruecke"), "Über die Brücke");
  // ch-004 was written from "Die Kneipe"
  assert.equal(await firstTitle("ch-004"), "Die Kneipe");

  await assert.rejects(callJson(api, "book_outline_get", { fromChapter: 7 }), /6 chapter\(s\), so there is no chapter 7/);
  await assert.rejects(callJson(api, "book_outline_get", { fromChapter: "Nirgendwo" }), /No outline chapter is titled/);
  await assert.rejects(callJson(api, "book_outline_get", { act: "Vierter Akt" }), /no act "Vierter Akt"/);
});
