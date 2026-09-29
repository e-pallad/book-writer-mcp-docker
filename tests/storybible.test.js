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
    m("storybible").registerStoryBibleTools,
    m("continuity").registerContinuityTools,
    m("dashboard").registerDashboardTools
  );
}

async function newProject(t) {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const api = tools();
  await callJson(api, "book_init", { title: "T", author: "A", genre: "G", language: "de" });
  return { dir, api };
}

const bible = (dir) =>
  JSON.parse(fs.readFileSync(path.join(dir, ".book-mcp", "story-bible.json"), "utf-8"));

async function chapters(api, count, textFor = () => "Nichts geschieht.") {
  const ids = [];
  for (let i = 1; i <= count; i++) {
    const { chapterId } = await callJson(api, "book_chapter_create", {
      title: `Kapitel ${i}`,
      synopsis: "s",
      content: `# Kapitel ${i}\n\n${textFor(i)}\n`,
    });
    ids.push(chapterId);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Settings

test("a setting can be changed after it was added, by id or by name", async (t) => {
  const { dir, api } = await newProject(t);
  const { setting } = await callJson(api, "book_setting_add", {
    name: "Der Kai",
    description: "Nass.",
    type: "location",
  });

  const renamed = await callJson(api, "book_setting_update", {
    settingId: "Der Kai",
    name: "Die Mole",
    description: "Nass und windig.",
  });
  assert.match(renamed.message, /"Der Kai" renamed to "Die Mole"/);

  await callJson(api, "book_setting_update", { settingId: setting.id, notes: "Nachts beleuchtet." });
  const stored = bible(dir).settings[0];
  assert.equal(stored.name, "Die Mole");
  assert.equal(stored.description, "Nass und windig.");
  assert.equal(stored.notes, "Nachts beleuchtet.");
  assert.equal(stored.type, "location", "untouched fields stay");

  await assert.rejects(callJson(api, "book_setting_update", { settingId: "Die Mole" }), /Nothing to update/);
  await assert.rejects(
    callJson(api, "book_setting_update", { settingId: "Atlantis", notes: "x" }),
    /Setting "Atlantis" not found. Known settings: Die Mole/
  );
});

// ---------------------------------------------------------------------------
// Characters by name

test("book_character_update finds a character by name or alias, not only by id", async (t) => {
  const { dir, api } = await newProject(t);
  await callJson(api, "book_character_add", {
    name: "Mara Vance",
    aliases: ["die Inspektorin"],
    role: "protagonist",
    description: "d",
  });

  await callJson(api, "book_character_update", { characterId: "Mara Vance", updates: { notes: "a" } });
  await callJson(api, "book_character_update", {
    characterId: "die Inspektorin",
    updates: { backstory: "b" },
  });
  const [mara] = bible(dir).characters;
  assert.equal(mara.notes, "a");
  assert.equal(mara.backstory, "b");

  const renamed = await callJson(api, "book_character_update", {
    characterId: "Mara Vance",
    updates: { name: "Mara Reed" },
  });
  assert.match(renamed.warnings.join(" "), /book_character_rename/);
});

test("a chapter reference given by title is stored as the chapter's id", async (t) => {
  const { dir, api } = await newProject(t);
  await chapters(api, 2);

  const added = await callJson(api, "book_character_add", {
    name: "Kell",
    role: "supporting",
    description: "d",
    firstAppearance: "Kapitel 2",
  });
  assert.equal(added.character.firstAppearance, "ch-002");

  const thread = await callJson(api, "book_plot_thread_add", {
    title: "Kells Schulden",
    openedIn: "Kapitel 1",
    summary: "s",
  });
  assert.equal(thread.thread.openedIn, "ch-001");

  // A thread planned before its chapter exists is kept, with a warning.
  const planned = await callJson(api, "book_plot_thread_add", {
    title: "Der Verrat",
    openedIn: "ch-009",
    summary: "s",
  });
  assert.equal(planned.thread.openedIn, "ch-009");
  assert.match(planned.warnings[0], /No chapter "ch-009" exists yet/);
});

// ---------------------------------------------------------------------------
// Plot threads

test("a plot thread can be edited, resolved by title and abandoned with a reason", async (t) => {
  const { dir, api } = await newProject(t);
  await chapters(api, 3);
  await callJson(api, "book_plot_thread_add", { title: "Die Schuld", openedIn: "ch-001", summary: "s" });
  await callJson(api, "book_plot_thread_add", { title: "Der Brief", openedIn: "ch-001", summary: "s" });

  const updated = await callJson(api, "book_plot_thread_update", {
    threadId: "Die Schuld",
    title: "Kells Schuld",
    keywords: ["Schuldschein"],
  });
  assert.equal(updated.thread.title, "Kells Schuld");
  assert.deepEqual(updated.thread.keywords, ["Schuldschein"]);

  await callJson(api, "book_plot_thread_resolve", { threadId: "Kells Schuld", resolvedIn: "Kapitel 3" });

  await callJson(api, "book_plot_thread_update", {
    threadId: "Der Brief",
    status: "abandoned",
    reason: "Doppelt mit der Schuld-Handlung.",
  });

  const threads = bible(dir).plotThreads;
  assert.equal(threads[0].status, "resolved");
  assert.equal(threads[0].resolvedIn, "ch-003");
  assert.equal(threads[1].status, "abandoned");
  assert.equal(threads[1].abandonedReason, "Doppelt mit der Schuld-Handlung.");

  const abandoned = await callJson(api, "book_plot_threads_list", { status: "abandoned" });
  assert.deepEqual(abandoned.threads.map((t) => t.title), ["Der Brief"]);

  // Reopening clears what no longer applies.
  await callJson(api, "book_plot_thread_update", { threadId: "Der Brief", status: "open" });
  assert.equal(bible(dir).plotThreads[1].abandonedReason, undefined);

  await assert.rejects(
    callJson(api, "book_plot_thread_update", { threadId: "Der Brief", status: "resolved" }),
    /Say where "Der Brief" resolves/
  );
});

test("a thread is not nagged about while the prose or a touch keeps it alive", async (t) => {
  const { api } = await newProject(t);
  // Chapter 4 names the thread's keyword; nothing else does.
  await chapters(api, 12, (i) =>
    i === 4 ? "Der Schuldschein lag auf dem Tisch." : "Nichts geschieht."
  );
  await callJson(api, "book_plot_thread_add", {
    title: "Kells Schulden",
    openedIn: "ch-001",
    summary: "s",
    keywords: ["Schuldschein"],
  });

  // Chapter 9 is five chapters after the mention in 4: still at rest.
  const nine = await callJson(api, "book_continuity_check", { chapterId: "ch-009" });
  assert.equal(nine.flags.filter((f) => f.type === "plot_thread").length, 0);

  // Chapter 10 is six after: worth a reminder, naming where it was last seen.
  const ten = await callJson(api, "book_continuity_check", { chapterId: "ch-010" });
  const flag = ten.flags.find((f) => f.type === "plot_thread");
  assert.ok(flag, JSON.stringify(ten.flags));
  assert.match(flag.description, /last carried in ch-004/);
  assert.match(flag.suggestion, /book_plot_thread_touch/);

  // A touch in chapter 8 carries it without the prose naming it.
  await callJson(api, "book_plot_thread_touch", {
    threadId: "Kells Schulden",
    chapterId: "Kapitel 8",
    note: "Kell weicht dem Wirt aus.",
  });
  const after = await callJson(api, "book_continuity_check", { chapterId: "ch-010" });
  assert.equal(after.flags.filter((f) => f.type === "plot_thread").length, 0);

  // Abandoned threads are never nagged about.
  await callJson(api, "book_plot_thread_update", { threadId: "Kells Schulden", status: "abandoned" });
  const twelve = await callJson(api, "book_continuity_check", { chapterId: "ch-012" });
  assert.equal(twelve.flags.filter((f) => f.type === "plot_thread").length, 0);
});

test("the dashboard measures an open thread from where it was last carried", async (t) => {
  const { api } = await newProject(t);
  await chapters(api, 10, (i) => (i === 7 ? "Der Schuldschein brannte." : "Nichts."));
  await callJson(api, "book_plot_thread_add", {
    title: "Kells Schulden",
    openedIn: "ch-001",
    summary: "s",
    keywords: ["Schuldschein"],
  });

  const { health } = await callJson(api, "book_dashboard", {});
  const finding = health.find((f) => f.area === "plot");
  assert.equal(finding.severity, "warning", "3 chapters since ch-007, not 9 since ch-001");
  assert.match(finding.detail, /last carried in ch-007/);
});

test("touching a thread in a chapter that does not exist is refused", async (t) => {
  const { api } = await newProject(t);
  await chapters(api, 1);
  await callJson(api, "book_plot_thread_add", { title: "X", openedIn: "ch-001", summary: "s" });
  await assert.rejects(
    callJson(api, "book_plot_thread_touch", { threadId: "X", chapterId: "ch-404" }),
    /Chapter "ch-404" not found/
  );
});

// ---------------------------------------------------------------------------
// Themes

test("themes can be added, described, listed and removed", async (t) => {
  const { dir, api } = await newProject(t);
  await callJson(api, "book_theme_add", { name: "Schuld und Vergebung", description: "Wer vergibt wem?" });
  await callJson(api, "book_theme_add", { name: "Loyalität" });
  // Adding an existing theme again updates its description.
  const again = await callJson(api, "book_theme_add", {
    name: "loyalität",
    description: "Was kostet sie?",
  });
  assert.match(again.message, /updated/);

  const { themes } = await callJson(api, "book_theme_list", {});
  assert.deepEqual(themes, [
    { name: "Schuld und Vergebung", description: "Wer vergibt wem?" },
    { name: "Loyalität", description: "Was kostet sie?" },
  ]);

  await callJson(api, "book_theme_remove", { name: "Schuld und Vergebung" });
  assert.deepEqual(bible(dir).themes, [{ name: "Loyalität", description: "Was kostet sie?" }]);
  await assert.rejects(callJson(api, "book_theme_remove", { name: "Nichts" }), /not found/);
});

test("themes stored as bare strings by hand are read as themes", async (t) => {
  const { dir, api } = await newProject(t);
  const file = path.join(dir, ".book-mcp", "story-bible.json");
  const data = bible(dir);
  data.themes = ["Heimat"];
  fs.writeFileSync(file, JSON.stringify(data));

  const { themes } = await callJson(api, "book_theme_list", {});
  assert.deepEqual(themes, [{ name: "Heimat", description: "" }]);
});

test("a character is found by a unique part of their name, never by a shared one", async (t) => {
  const { api } = await newProject(t);
  await callJson(api, "book_character_add", { name: "Mara Vance", role: "protagonist", description: "d" });
  await callJson(api, "book_character_add", { name: "Tom Vance", role: "minor", description: "d" });

  const mara = await callJson(api, "book_character_get", { nameOrId: "Mara" });
  assert.equal(mara.name, "Mara Vance");
  await assert.rejects(callJson(api, "book_character_get", { nameOrId: "Vance" }), /not found/);
});
