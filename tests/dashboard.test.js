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
    m("timeline").registerTimelineTools,
    m("styleguide").registerStyleGuideTools,
    m("ai-disclosure").registerAiDisclosureTools,
    m("dashboard").registerDashboardTools
  );
}

const tick = () => new Promise((r) => setTimeout(r, 6));

async function seed(t, options = {}) {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const api = tools();

  await callJson(api, "book_init", {
    title: "The Harbour Light",
    author: "E. Pallad",
    genre: "Literary Crime",
    targetWordCount: 1000,
  });

  await callJson(api, "book_character_add", {
    name: "Mara",
    aliases: ["Inspector Vance-Reed"],
    role: "protagonist",
    description: "Dock inspector.",
  });
  await callJson(api, "book_character_add", {
    name: "Kell",
    role: "supporting",
    description: "Dockhand.",
  });
  await callJson(api, "book_character_add", {
    name: "Silas",
    role: "minor",
    description: "Never written in.",
  });

  const chapters = options.chapters ?? [
    ["One", "Mara walked the quay. Kell was there.", "final"],
    ["Two", "Mara read the ledger alone.", "final"],
    ["Three", "Nothing but gulls.", "draft"],
    ["Four", "Nothing much here either.", "draft"],
    ["Five", "Nobody at all.", "draft"],
    ["Six", "Mara returned. Kell waited.", "draft"],
  ];
  for (const [title, body, status] of chapters) {
    const created = await callJson(api, "book_chapter_create", {
      title,
      synopsis: title,
      content: `# ${title}\n\n${body}\n`,
    });
    await callJson(api, "book_chapter_update", { chapterId: created.chapterId, status });
  }

  return { dir, api };
}

test("the overview totals match the registry", async (t) => {
  const { api } = await seed(t);
  const data = await callJson(api, "book_dashboard", {});

  assert.equal(data.overview.title, "The Harbour Light");
  assert.equal(data.overview.chapterCount, 6);
  assert.equal(data.overview.byStatus.final, 2);
  assert.equal(data.overview.byStatus.draft, 4);
  assert.equal(data.overview.targetWords, 1000);
  assert.ok(data.overview.totalWords > 0);
  assert.equal(
    data.overview.percentComplete,
    Math.round((data.overview.totalWords / 1000) * 100)
  );
  assert.equal(data.overview.daysSinceLastActivity, 0);
});

test("the presence map counts mentions per chapter", async (t) => {
  const { api } = await seed(t);
  const { presence } = await callJson(api, "book_dashboard", {});

  const row = (name) =>
    presence.counts[presence.characters.findIndex((c) => c.name === name)];

  // Mara is in chapters 1, 2 and 6; Kell in 1 and 6; Silas nowhere.
  assert.deepEqual(row("Mara"), [1, 1, 0, 0, 0, 1]);
  assert.deepEqual(row("Kell"), [1, 0, 0, 0, 0, 1]);
  assert.deepEqual(row("Silas"), [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(presence.absent, ["Silas"]);
});

test("an alias containing another character's name is not double counted", async (t) => {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const api = tools();
  await callJson(api, "book_init", { title: "T", author: "A", genre: "g" });

  await callJson(api, "book_character_add", {
    name: "Mara",
    aliases: ["Mara Vance"],
    role: "protagonist",
    description: "d",
  });
  await callJson(api, "book_chapter_create", {
    title: "One",
    synopsis: "s",
    content: "# One\n\nMara Vance arrived. Later, Mara left.\n",
  });

  const { presence } = await callJson(api, "book_dashboard", {});
  // "Mara Vance" is one mention, "Mara" a second — not three.
  assert.deepEqual(presence.counts[0], [2]);
});

test("a character who vanishes for a stretch is reported as a gap", async (t) => {
  const { api } = await seed(t);
  const { presence } = await callJson(api, "book_dashboard", {});

  const gap = presence.gaps.find((g) => g.character === "Mara");
  assert.ok(gap, `expected a gap for Mara, got ${JSON.stringify(presence.gaps)}`);
  assert.equal(gap.missedChapters, 3, "chapters three, four and five");
  assert.equal(gap.afterChapter, "Two");

  // Kell is missing across the same run.
  assert.ok(presence.gaps.some((g) => g.character === "Kell"));
});

test("story order is ranked and contradictions are found", async (t) => {
  const { api } = await seed(t);

  await callJson(api, "book_timeline_add", {
    event: "Mara walks the quay",
    inStoryTime: "Friday",
    sortKey: "1997-06-13",
    chapterId: "ch-001",
  });
  await callJson(api, "book_timeline_add", {
    event: "The inquest",
    inStoryTime: "Thursday",
    sortKey: "1997-06-19",
    chapterId: "ch-002",
  });
  // Told in chapter 3, but happens before chapter 2's event.
  await callJson(api, "book_timeline_add", {
    event: "Kell rows out",
    inStoryTime: "Wednesday",
    sortKey: "1997-06-18",
    chapterId: "ch-003",
  });

  const { timeline } = await callJson(api, "book_dashboard", {});

  assert.equal(timeline.contradictions, 1);
  const flagged = timeline.points.find((p) => p.contradiction);
  assert.equal(flagged.event, "Kell rows out");

  // Ranks follow story time, not the order they were logged.
  const ranks = Object.fromEntries(timeline.points.map((p) => [p.event, p.storyRank]));
  assert.equal(ranks["Mara walks the quay"], 1);
  assert.equal(ranks["Kell rows out"], 2);
  assert.equal(ranks["The inquest"], 3);

  assert.ok(timeline.chaptersWithoutEvents.some((c) => c.title === "Four"));
});

test("REGRESSION: the velocity series is reconstructed from saved versions", async (t) => {
  const { api } = await seed(t);

  // Two edits, so there are snapshots to reconstruct from.
  await callJson(api, "book_chapter_update", {
    chapterId: "ch-001",
    content: "# One\n\nMara walked the quay. Kell was there. The lamp was out.\n",
  });
  await tick();
  await callJson(api, "book_chapter_update", {
    chapterId: "ch-001",
    content: "# One\n\nMara walked the quay. Kell was there. The lamp was out. Again.\n",
  });
  await tick();

  const { velocity, chapters } = await callJson(api, "book_dashboard", {});

  // A snapshot's file-name timestamp and its ISO savedAt are both 24
  // characters, so a length test picked the unparseable one, every entry
  // became NaN and the chart came out empty while the chapter table plainly
  // showed revisions.
  assert.ok(
    chapters.find((c) => c.id === "ch-001").revisionCount >= 2,
    "precondition: the chapter has saved versions"
  );
  assert.ok(
    velocity.series.length >= 2,
    `expected a reconstructed series, got ${JSON.stringify(velocity)}`
  );
  for (const point of velocity.series) {
    assert.ok(
      !Number.isNaN(Date.parse(point.at)),
      `series timestamps must be parseable, got "${point.at}"`
    );
    assert.equal(typeof point.totalWords, "number");
    assert.ok(point.totalWords > 0);
  }
  // Words only grew here, so the series should end at least where it started.
  assert.ok(
    velocity.series[velocity.series.length - 1].totalWords >= velocity.series[0].totalWords
  );
  assert.match(velocity.coverage, /partial record/);
});

test("with no history at all the velocity panel says so rather than charting nothing", async (t) => {
  const { api } = await seed(t);
  const { velocity } = await callJson(api, "book_dashboard", {});
  assert.deepEqual(velocity.series, []);
  assert.equal(velocity.wordsPerDay, null);
  assert.match(velocity.coverage, /No saved versions yet/);
});

test("health findings cover threads, timeline, voice, style and absent cast", async (t) => {
  const { api } = await seed(t);

  await callJson(api, "book_style_set", {
    voice: "v", pov: "third person limited", tense: "past", tone: "t",
    targetAudience: "a", sentenceStyle: "s",
    thingsToAvoid: ["gulls"], recurringMotifs: [], samplePassage: "p",
  });
  await callJson(api, "book_plot_thread_add", {
    title: "Kell's debt",
    openedIn: "ch-001",
    summary: "...",
  });

  const { health } = await callJson(api, "book_dashboard", {});
  const areas = new Set(health.map((f) => f.area));

  assert.ok(areas.has("plot"), "open thread should be reported");
  assert.ok(areas.has("style"), '"gulls" is on the avoid list and appears');
  assert.ok(areas.has("pace"), "Silas never appears");

  const style = health.find((f) => f.area === "style");
  assert.match(style.summary, /"gulls" appears 1 time/);

  // Sorted worst-first, and every finding carries a severity that maps to an
  // icon and a word — colour is never the only channel.
  const severities = health.map((f) => f.severity);
  const rank = { critical: 0, serious: 1, warning: 2, good: 3 };
  assert.deepEqual(severities, [...severities].sort((a, b) => rank[a] - rank[b]));
  for (const f of health) assert.ok(rank[f.severity] !== undefined);
});

test("a clean project reports good rather than an empty list", async (t) => {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const api = tools();
  await callJson(api, "book_init", { title: "T", author: "A", genre: "g" });
  await callJson(api, "book_chapter_create", {
    title: "Only",
    synopsis: "s",
    content: "# Only\n\nprose\n",
  });

  const { health } = await callJson(api, "book_dashboard", {});
  assert.equal(health.length, 1);
  assert.equal(health[0].severity, "good");
});

test("readiness reflects what has actually been recorded", async (t) => {
  const { api } = await seed(t);

  const before = await callJson(api, "book_dashboard", { sections: ["readiness"] });
  const disclosureBefore = before.readiness.find((r) => r.item === "AI content disclosure");
  assert.equal(disclosureBefore.state, "needed");

  await callJson(api, "book_ai_disclosure_generate", { text: "ai_assisted" });

  const after = await callJson(api, "book_dashboard", { sections: ["readiness"] });
  const disclosureAfter = after.readiness.find((r) => r.item === "AI content disclosure");
  assert.equal(disclosureAfter.state, "ready");
  assert.match(disclosureAfter.detail, /nothing to declare/);
});

test("sections narrows the response", async (t) => {
  const { api } = await seed(t);
  const partial = await callJson(api, "book_dashboard", {
    sections: ["overview", "health"],
  });
  assert.ok(partial.overview);
  assert.ok(partial.health);
  assert.equal(partial.presence, undefined);
  assert.equal(partial.chapters, undefined);
  assert.ok(partial.generatedAt);
});

test("the exported page is self-contained and escapes its content", async (t) => {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const api = tools();
  await callJson(api, "book_init", {
    title: 'The "Good" <Son> & Co',
    author: "Émile Ø'Brien",
    genre: "g",
  });
  await callJson(api, "book_character_add", {
    name: "Mara & <b>Kell</b>",
    role: "protagonist",
    description: "d",
  });
  await callJson(api, "book_chapter_create", {
    title: "One & <Two>",
    synopsis: "s",
    content: "# One & <Two>\n\nprose\n",
  });

  const out = path.join(dir, "dashboard.html");
  const result = await callJson(api, "book_dashboard_export", { outputPath: out });
  assert.equal(result.outputPath, out);

  const html = fs.readFileSync(out, "utf-8");

  // Nothing fetched at view time: no external stylesheet, script or image.
  assert.ok(!/<script/i.test(html), "the page should ship no script");
  assert.ok(!/https?:\/\//.test(html.replace(/<title>[\s\S]*?<\/title>/, "")),
    "the page should reference no external resource");

  // Raw angle brackets from user content must not survive into the markup.
  assert.ok(!html.includes("<b>Kell</b>"), "character names must be escaped");
  assert.ok(html.includes("Mara &amp; &lt;b&gt;Kell&lt;/b&gt;"));
  assert.ok(html.includes("The &quot;Good&quot; &lt;Son&gt; &amp; Co") ||
    html.includes('The "Good" &lt;Son&gt; &amp; Co'));
  assert.ok(html.includes("Émile Ø'Brien"));

  // Both themes are declared, and dark is its own set of steps.
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /\[data-theme="dark"\]/);

  // Every chart has a table-view twin.
  assert.match(html, /Table view/);
});

test("an empty project renders without charts rather than failing", async (t) => {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const api = tools();
  await callJson(api, "book_init", { title: "Empty", author: "A", genre: "g" });

  const data = await callJson(api, "book_dashboard", {});
  assert.equal(data.overview.chapterCount, 0);
  assert.ok(data.notes.some((n) => /No characters/.test(n)));
  assert.ok(data.notes.some((n) => /No timeline events/.test(n)));

  const out = path.join(dir, "dashboard.html");
  await callJson(api, "book_dashboard_export", { outputPath: out });
  const html = fs.readFileSync(out, "utf-8");
  assert.match(html, /No characters in the story bible yet/);
});

test("book_dashboard needs a project", async (t) => {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  await assert.rejects(
    () => callJson(tools(), "book_dashboard", {}),
    /No book project found/
  );
});
