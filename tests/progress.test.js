const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { collectTools, callJson } = require("./helpers/tools");
const { useTempProject, cleanup } = require("./helpers/project");
const { countWords } = require("../dist-tsc/utils/wordcount");
const { dayKey } = require("../dist-tsc/storage/writing-log");
const { computeProgress, totalsByDay } = require("../dist-tsc/storage/progress");

function tools() {
  const m = (n) => require(`../dist-tsc/tools/${n}`);
  return collectTools(
    m("manuscript").registerManuscriptTools,
    m("project").registerProjectTools,
    m("history").registerHistoryTools,
    m("chapter-edit").registerChapterEditTools,
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

const readLog = (dir) =>
  JSON.parse(fs.readFileSync(path.join(dir, ".book-mcp", "writing-log.json"), "utf-8"));
const today = () => dayKey(new Date(), "UTC");

// ---------------------------------------------------------------------------
// Counting

test("markup is not counted as words", () => {
  const text = "# Titel\n\nHallo Welt.\n\n* * *\n\n> Ein Zitat\n\n— Ende —\n\n***fett kursiv***";
  // Titel, Hallo, Welt., Ein, Zitat, Ende, fett, kursiv
  assert.equal(countWords(text), 8);
  assert.equal(countWords("# Leer\n\n"), 1, "a new chapter is not credited with a '#'");
  assert.equal(countWords(""), 0);
});

// ---------------------------------------------------------------------------
// The log

test("every way of changing chapter text is logged", async (t) => {
  const { dir, api } = await newProject(t);

  const { chapterId } = await callJson(api, "book_chapter_create", {
    title: "Eins",
    synopsis: "s",
    content: "# Eins\n\neins zwei drei vier",
  });
  let day = readLog(dir).days[today()];
  assert.deepEqual([day.added, day.removed], [5, 0], "Eins + four words");

  await callJson(api, "book_chapter_update", {
    chapterId,
    content: "# Eins\n\neins zwei drei vier fünf sechs",
  });
  await callJson(api, "book_chapter_replace_text", {
    chapterId,
    oldText: "fünf sechs",
    newText: "fünf",
  });
  day = readLog(dir).days[today()];
  assert.deepEqual([day.added, day.removed], [7, 1]);

  const { snapshots } = await callJson(api, "book_chapter_history_list", { chapterId });
  await callJson(api, "book_chapter_revert", { chapterId, timestamp: snapshots.at(-1).timestamp });
  day = readLog(dir).days[today()];
  assert.equal(day.added - day.removed, 5, "back to the first version");

  await callJson(api, "book_chapter_delete", { chapterId, confirm: true });
  day = readLog(dir).days[today()];
  assert.equal(day.added - day.removed, 0, "deleting takes the words out of the book");
  assert.equal(day.chapters[chapterId], 0);
  assert.equal(day.changes, 5);
});

test("a title-only update or unchanged text logs nothing", async (t) => {
  const { dir, api } = await newProject(t);
  const { chapterId } = await callJson(api, "book_chapter_create", {
    title: "Eins",
    synopsis: "s",
    content: "Text ohne Überschrift.",
  });
  const before = readLog(dir).days[today()].changes;
  await callJson(api, "book_chapter_update", { chapterId, status: "review" });
  await callJson(api, "book_chapter_update", { chapterId, content: "Text ohne Überschrift." });
  assert.equal(readLog(dir).days[today()].changes, before);
});

test("the day boundary follows the project's time zone", () => {
  const lateEvening = new Date("2026-09-29T22:30:00Z");
  assert.equal(dayKey(lateEvening, "UTC"), "2026-09-29");
  assert.equal(dayKey(lateEvening, "Europe/Berlin"), "2026-09-30");
  assert.equal(dayKey(lateEvening, "America/New_York"), "2026-09-29");
  assert.equal(dayKey(lateEvening, "Not/AZone"), "2026-09-29", "an invalid zone falls back to UTC");
});

// ---------------------------------------------------------------------------
// Progress

function logOf(days, startedAt = "2026-09-01T08:00:00.000Z") {
  const entries = {};
  for (const [date, added, removed = 0] of days) {
    entries[date] = { added, removed, chapters: {}, changes: 1 };
  }
  return { startedAt, days: entries };
}

const REGISTRY = {
  title: "T",
  author: "A",
  genre: "G",
  targetWordCount: 10000,
  chapters: [],
  dailyWordGoal: 500,
  deadline: "2026-10-10",
  timezone: "Europe/Berlin",
};
const NOW = new Date("2026-09-29T10:00:00Z");

test("today, the goal and the streak", () => {
  const log = logOf([
    ["2026-09-25", 800],
    ["2026-09-26", 300],
    ["2026-09-27", 600],
    ["2026-09-28", 550, 100],
    ["2026-09-29", 200],
  ]);
  const progress = computeProgress(REGISTRY, log, 6000, NOW);

  assert.equal(progress.today.date, "2026-09-29");
  assert.equal(progress.today.added, 200);
  assert.equal(progress.today.remainingToGoal, 300);
  assert.equal(progress.today.goalMet, false);
  assert.equal(progress.streak.writingDays, 5);
  // Today is not done yet, so the goal streak counts back from yesterday.
  assert.equal(progress.streak.goalDays, 2);
  assert.equal(progress.recent.length, 14);
  assert.deepEqual(progress.recent.at(-2), { date: "2026-09-28", added: 550, removed: 100, net: 450 });
});

test("the deadline: days left, words a day needed, and whether the pace is enough", () => {
  const log = logOf(
    [
      ["2026-09-27", 400],
      ["2026-09-28", 400],
      ["2026-09-29", 400],
    ],
    "2026-09-27T08:00:00.000Z"
  );
  const progress = computeProgress(REGISTRY, log, 6000, NOW);

  // 2026-09-29 .. 2026-10-10 inclusive is 12 days; 4000 words to go.
  assert.equal(progress.deadline.daysLeft, 12);
  assert.equal(progress.deadline.wordsPerDayNeeded, 334);
  // The average covers only the three logged days, not a fortnight of
  // "zeros" from before the log existed.
  assert.equal(progress.averages.daysCovered, 3);
  assert.equal(progress.averages.netPerDay, 400);
  assert.equal(progress.deadline.onTrack, true);
  assert.equal(progress.projectedFinish, "2026-10-09");
});

test("too little history says so instead of guessing", () => {
  const log = logOf([["2026-09-29", 100]], "2026-09-29T08:00:00.000Z");
  const progress = computeProgress(REGISTRY, log, 6000, NOW);
  assert.equal(progress.deadline.onTrack, null);
  assert.match(progress.notes.join(" "), /too early/);
});

test("totals by day walk back from today's total", () => {
  const log = logOf([
    ["2026-09-27", 400],
    ["2026-09-28", 300, 100],
    ["2026-09-29", 50],
  ]);
  assert.deepEqual(totalsByDay(log, 1000), [
    { date: "2026-09-27", totalWords: 750 },
    { date: "2026-09-28", totalWords: 950 },
    { date: "2026-09-29", totalWords: 1000 },
  ]);
});

test("book_project_update sets and clears the schedule, and rejects bad values", async (t) => {
  const { dir, api } = await newProject(t);
  const set = await callJson(api, "book_project_update", {
    dailyWordGoal: 750,
    deadline: "2027-03-31",
    timezone: "Europe/Berlin",
  });
  assert.deepEqual(
    [set.project.dailyWordGoal, set.project.deadline, set.project.timezone],
    [750, "2027-03-31", "Europe/Berlin"]
  );

  await callJson(api, "book_project_update", { dailyWordGoal: 0, deadline: "" });
  const stored = JSON.parse(fs.readFileSync(path.join(dir, ".book-mcp", "registry.json"), "utf-8"));
  assert.equal("dailyWordGoal" in stored, false);
  assert.equal("deadline" in stored, false);

  await assert.rejects(callJson(api, "book_project_update", { deadline: "2027-02-30" }), /not a date/);
  await assert.rejects(callJson(api, "book_project_update", { timezone: "Berlin" }), /not a time zone/);
  await assert.rejects(callJson(api, "book_project_update", { dailyWordGoal: -1 }), /dailyWordGoal/);
});

test("book_progress reports today's words from the log", async (t) => {
  const { api } = await newProject(t);
  await callJson(api, "book_project_update", { dailyWordGoal: 5 });
  await callJson(api, "book_chapter_create", {
    title: "Eins",
    synopsis: "s",
    content: "# Eins\n\neins zwei drei vier",
  });

  const progress = await callJson(api, "book_progress", {});
  assert.equal(progress.today.added, 5);
  assert.equal(progress.today.goalMet, true);
  assert.equal(progress.streak.writingDays, 1);
  assert.equal(progress.manuscript.totalWords, 5);
});

// ---------------------------------------------------------------------------
// Migration and the dashboard

test("a registry counted by the old counter is recounted on its next write", async (t) => {
  const { dir, api } = await newProject(t);
  await callJson(api, "book_chapter_create", { title: "Eins", synopsis: "s", content: "# Eins\n\nzwei Wörter" });

  const file = path.join(dir, ".book-mcp", "registry.json");
  const legacy = JSON.parse(fs.readFileSync(file, "utf-8"));
  delete legacy.countVersion;
  legacy.chapters[0].wordCount = 4; // what the old counter said: "#", "Eins", "zwei", "Wörter"
  fs.writeFileSync(file, JSON.stringify(legacy));

  // Before any write, the dashboard does not blame the difference on edits.
  const before = await callJson(api, "book_dashboard", {});
  assert.ok(!before.notes.some((n) => /differ in length/.test(n)), JSON.stringify(before.notes));

  await callJson(api, "book_chapter_create", { title: "Zwei", synopsis: "s" });
  const after = JSON.parse(fs.readFileSync(file, "utf-8"));
  assert.equal(after.countVersion, 2);
  assert.equal(after.chapters[0].wordCount, 3);
});

test("with two or more logged days the dashboard charts the log", async (t) => {
  const { dir, api } = await newProject(t);
  await callJson(api, "book_chapter_create", { title: "Eins", synopsis: "s", content: "# Eins\n\nzwei drei" });

  const logFile = path.join(dir, ".book-mcp", "writing-log.json");
  const log = readLog(dir);
  log.days["2026-01-10"] = { added: 100, removed: 0, chapters: {}, changes: 1 };
  log.startedAt = "2026-01-10T08:00:00.000Z";
  fs.writeFileSync(logFile, JSON.stringify(log));

  const { velocity } = await callJson(api, "book_dashboard", {});
  assert.match(velocity.coverage, /From the writing log/);
  assert.ok(velocity.series.length >= 2);
  assert.equal(velocity.series.at(-1).totalWords, 3);
});
