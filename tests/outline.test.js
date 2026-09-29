const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { collectTools, callJson } = require("./helpers/tools");
const { useTempProject, cleanup } = require("./helpers/project");

function tools() {
  const m = (n) => require(`../dist-tsc/tools/${n}`);
  return collectTools(m("manuscript").registerManuscriptTools, m("outline").registerOutlineTools);
}

async function newProject(t) {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const api = tools();
  await callJson(api, "book_init", { title: "T", author: "A", genre: "G", language: "de" });
  return { dir, api };
}

const outlineFile = (dir) =>
  JSON.parse(fs.readFileSync(path.join(dir, ".book-mcp", "outline.json"), "utf-8"));

const PLAN = [
  {
    act: "Erster Akt",
    chapters: [
      { title: "Ankunft", synopsis: "Mara kommt an." },
      { title: "Der Kai", synopsis: "Mara trifft Kell." },
    ],
  },
  {
    act: "Zweiter Akt",
    chapters: [
      { title: "Die Kneipe", synopsis: "Der Wirt." },
      { title: "Das Boot", synopsis: "Flucht." },
    ],
  },
];

test("a chapter created from the plan is linked to its entry", async (t) => {
  const { dir, api } = await newProject(t);
  await callJson(api, "book_outline_set", { outline: PLAN });

  const same = await callJson(api, "book_chapter_create", { title: "Ankunft", synopsis: "s" });
  assert.match(same.outline, /Linked to the outline entry "Ankunft"/);

  // A chapter written under another title than planned names its entry.
  const other = await callJson(api, "book_chapter_create", {
    title: "Am Hafen",
    synopsis: "s",
    outlineTitle: "Der Kai",
  });
  assert.match(other.outline, /"Der Kai"/);

  const entries = outlineFile(dir).acts[0].chapters;
  assert.equal(entries[0].chapterId, same.chapterId);
  assert.equal(entries[1].chapterId, other.chapterId);

  await assert.rejects(
    callJson(api, "book_chapter_create", { title: "X", synopsis: "s", outlineTitle: "Gibt es nicht" }),
    /no unlinked entry titled "Gibt es nicht"/
  );
  const registry = JSON.parse(fs.readFileSync(path.join(dir, ".book-mcp", "registry.json"), "utf-8"));
  assert.equal(registry.chapters.length, 2, "a refused create leaves nothing behind");
  assert.equal(fs.readdirSync(path.join(dir, "chapters")).length, 2);
});

test("a rename follows the link, even where titles repeat", async (t) => {
  const { dir, api } = await newProject(t);
  // Two chapters called the same, each with its own plan entry.
  const a = await callJson(api, "book_chapter_create", { title: "Nacht", synopsis: "s" });
  const b = await callJson(api, "book_chapter_create", { title: "Nacht", synopsis: "s" });
  await callJson(api, "book_outline_set", {
    outline: [
      {
        chapters: [
          { title: "Nacht", synopsis: "erste", chapterId: a.chapterId },
          { title: "Nacht", synopsis: "zweite", chapterId: b.chapterId },
        ],
      },
    ],
  });

  await callJson(api, "book_chapter_rename", { chapterId: b.chapterId, title: "Zweite Nacht" });
  const entries = outlineFile(dir).acts[0].chapters;
  assert.equal(entries[0].title, "Nacht", "the other chapter's entry is untouched");
  assert.equal(entries[1].title, "Zweite Nacht");
});

test("book_outline_link links unambiguous titles and reports the rest", async (t) => {
  const { dir, api } = await newProject(t);
  await callJson(api, "book_chapter_create", { title: "Ankunft", synopsis: "s" });
  await callJson(api, "book_chapter_create", { title: "Die Kneipe", synopsis: "s" });
  await callJson(api, "book_chapter_create", { title: "Die Kneipe", synopsis: "s" });
  // Written before the plan existed: nothing linked yet.
  fs.writeFileSync(
    path.join(dir, ".book-mcp", "outline.json"),
    JSON.stringify({ acts: PLAN })
  );

  const report = await callJson(api, "book_outline_link", {});
  assert.deepEqual(report.linked, [{ title: "Ankunft", chapterId: "ch-001" }]);
  assert.deepEqual(report.ambiguous, [{ title: "Die Kneipe", chapters: ["ch-002", "ch-003"] }]);
  assert.deepEqual(report.unmatched, ["Der Kai", "Das Boot"]);

  await callJson(api, "book_outline_update_chapter", { chapterTitle: "Die Kneipe", linkTo: "ch-003" });
  assert.equal(outlineFile(dir).acts[1].chapters[0].chapterId, "ch-003");

  await assert.rejects(
    callJson(api, "book_outline_update_chapter", { chapterTitle: "Das Boot", linkTo: "ch-003" }),
    /already linked/
  );
});

test("book_outline_compare shows what was planned, written, moved and retitled", async (t) => {
  const { api } = await newProject(t);
  await callJson(api, "book_outline_set", { outline: PLAN });
  await callJson(api, "book_chapter_create", { title: "Ankunft", synopsis: "Mara kommt an." });
  await callJson(api, "book_chapter_create", { title: "Die Kneipe", synopsis: "Der Wirt droht." });
  await callJson(api, "book_chapter_create", { title: "Der Kai", synopsis: "Mara trifft Kell." });
  await callJson(api, "book_chapter_create", { title: "Ein Umweg", synopsis: "Ungeplant." });
  await callJson(api, "book_chapter_rename", { chapterId: "Der Kai", title: "Am Kai" });

  const compared = await callJson(api, "book_outline_compare", {});
  assert.deepEqual(compared.notWritten, [{ act: "Zweiter Akt", title: "Das Boot" }]);
  assert.deepEqual(compared.notPlanned, [{ chapterId: "ch-004", title: "Ein Umweg" }]);
  assert.deepEqual(
    compared.moved.map((m) => [m.title, m.plannedPosition, m.actualPosition]),
    [
      ["Am Kai", 2, 3],
      ["Die Kneipe", 3, 2],
    ]
  );
  assert.deepEqual(compared.synopses.map((s) => s.title), ["Die Kneipe"]);
  assert.deepEqual(compared.retitled, [], "a rename renames the plan entry with it");
  assert.match(compared.summary, /1 planned chapter\(s\) not written yet; 1 chapter\(s\) not in the plan; 2 chapter\(s\) in a different place/);
});

test("book_outline_get shows which entries have been written, and in what state", async (t) => {
  const { api } = await newProject(t);
  await callJson(api, "book_outline_set", { outline: PLAN });
  await callJson(api, "book_chapter_create", { title: "Ankunft", synopsis: "s", content: "# Ankunft\n\nEins zwei." });
  const outline = await callJson(api, "book_outline_get", {});
  assert.deepEqual(outline.acts[0].chapters[0].written, { chapterId: "ch-001", status: "draft", wordCount: 3 });
  assert.equal(outline.acts[0].chapters[1].written, null);
});

test("an entry can be updated through the chapter it is linked to", async (t) => {
  const { dir, api } = await newProject(t);
  await callJson(api, "book_outline_set", { outline: PLAN });
  await callJson(api, "book_chapter_create", { title: "Am Hafen", synopsis: "s", outlineTitle: "Der Kai" });
  await callJson(api, "book_outline_update_chapter", { chapterId: "Am Hafen", synopsis: "Neu geplant." });
  assert.equal(outlineFile(dir).acts[0].chapters[1].synopsis, "Neu geplant.");
});
