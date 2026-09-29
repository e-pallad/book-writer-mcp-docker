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
    m("outline").registerOutlineTools,
    m("structure").registerStructureTools,
    m("storybible").registerStoryBibleTools,
    m("concept").registerConceptTools,
    m("dashboard").registerDashboardTools
  );
}

// Ten chapters of 100 words each: chapter n's middle is at (n - 0.5) × 10%.
async function tenChapters(t, targetWordCount = 1000, language = "de") {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const api = tools();
  await callJson(api, "book_init", { title: "T", author: "A", genre: "G", language, targetWordCount });
  for (let i = 1; i <= 10; i++) {
    // The heading's word counts too: 1 + 99.
    await callJson(api, "book_chapter_create", {
      title: `K${i}`,
      synopsis: "s",
      content: `# K${i}\n\n${"Wort ".repeat(99).trim()}\n`,
    });
  }
  return { dir, api };
}

test("the templates list their beats and where they fall", async (t) => {
  const { api } = await tenChapters(t);
  const { templates } = await callJson(api, "book_structure_templates", {});
  assert.deepEqual(templates.map((x) => x.id), ["three_act", "heros_journey", "save_the_cat", "freytag", "seven_point"]);
  const midpoint = templates[0].beats.find((b) => b.id === "midpoint");
  assert.equal(midpoint.name, "Mittelpunkt", "in the book's language");
  assert.equal(midpoint.at, "50%");
});

test("beats are measured in words, and one far from its place is flagged", async (t) => {
  const { api } = await tenChapters(t);
  await callJson(api, "book_structure_set", { template: "three_act" });
  await callJson(api, "book_beat_set", { beat: "plot_point_1", chapterId: "K3" }); // 25%
  await callJson(api, "book_beat_set", { beat: "midpoint", chapterId: "K4" }); // 35%: early
  await callJson(api, "book_beat_set", { beat: "climax", chapterId: "K9" }); // 85%

  const report = await callJson(api, "book_structure_check", {});
  assert.equal(report.basis, "manuscript");
  const byId = Object.fromEntries(report.beats.map((b) => [b.beat, b]));
  assert.equal(byId.plot_point_1.actual, "25%");
  assert.equal(byId.plot_point_1.verdict, "on_target");
  assert.equal(byId.midpoint.actual, "35%");
  assert.equal(byId.midpoint.verdict, "early");
  assert.equal(byId.climax.verdict, "on_target");
  assert.equal(byId.inciting_incident.verdict, "unplaced");
  assert.match(report.summary.join(" "), /Mittelpunkt sits at 35% — expected around 50% \(±7%\), so early/);
  assert.match(report.summary.join(" "), /Not placed yet: Auslösendes Ereignis/);

  const { health } = await callJson(api, "book_dashboard", {});
  const structure = health.find((f) => f.area === "structure");
  assert.match(structure.summary, /Mittelpunkt at 35%, expected ~50%/);
});

test("a beat can be placed in a scene, and beats out of order are reported", async (t) => {
  const { api } = await tenChapters(t);
  await callJson(api, "book_chapter_update", {
    chapterId: "K5",
    content: `# K5\n\n${"Eins ".repeat(49).trim()}\n\n* * *\n\n${"Zwei ".repeat(50).trim()}\n`,
  });
  await callJson(api, "book_structure_set", { template: "three_act" });
  await callJson(api, "book_beat_set", { beat: "midpoint", chapterId: "K5", scene: 2 });
  await callJson(api, "book_beat_set", { beat: "plot_point_2", chapterId: "K2" });

  const report = await callJson(api, "book_structure_check", {});
  const byId = Object.fromEntries(report.beats.map((b) => [b.beat, b]));
  assert.equal(byId.midpoint.scene, 2);
  assert.equal(byId.midpoint.actual, "48%", "400, the heading and scene 1's 49 words, plus half of its 50");
  assert.deepEqual(report.outOfOrder, ["midpoint"]);

  await assert.rejects(
    callJson(api, "book_beat_set", { beat: "midpoint", chapterId: "K5", scene: 3 }),
    /has 2 scene\(s\)/
  );
  await assert.rejects(
    callJson(api, "book_beat_set", { beat: "ordeal", chapterId: "K5" }),
    /not a beat of the Three-act structure/
  );
});

test("an unfinished book is measured against its target length", async (t) => {
  const { api } = await tenChapters(t, 2000);
  await callJson(api, "book_structure_set", { template: "three_act" });
  await callJson(api, "book_beat_set", { beat: "midpoint", chapterId: "K10" });
  const report = await callJson(api, "book_structure_check", {});
  assert.equal(report.basis, "target");
  assert.equal(report.beats.find((b) => b.beat === "midpoint").actual, "48%");
});

test("switching structure carries over beats both share", async (t) => {
  const { dir, api } = await tenChapters(t);
  await callJson(api, "book_structure_set", { template: "three_act" });
  await callJson(api, "book_beat_set", { beat: "midpoint", chapterId: "K5" });
  await callJson(api, "book_beat_set", { beat: "plot_point_1", chapterId: "K3" });

  const switched = await callJson(api, "book_structure_set", { template: "save_the_cat" });
  assert.deepEqual(switched.carriedOver, ["midpoint"]);
  assert.deepEqual(switched.dropped, ["plot_point_1"]);
  const outline = JSON.parse(fs.readFileSync(path.join(dir, ".book-mcp", "outline.json"), "utf-8"));
  assert.equal(outline.structure.template, "save_the_cat");

  // Removing a placement.
  await callJson(api, "book_beat_set", { beat: "midpoint", chapterId: "" });
  const after = JSON.parse(fs.readFileSync(path.join(dir, ".book-mcp", "outline.json"), "utf-8"));
  assert.deepEqual(after.structure.beats, []);
});

test("a character's arc is kept, merged, checked and shown in the exposé", async (t) => {
  const { api } = await tenChapters(t);
  await callJson(api, "book_character_add", {
    name: "Mara",
    role: "protagonist",
    description: "Inspektorin.",
    arc: { want: "Den Mörder finden", arcType: "positive" },
  });
  await callJson(api, "book_character_add", { name: "Kell", role: "protagonist", description: "Hafenarbeiter." });
  await callJson(api, "book_structure_set", { template: "three_act" });

  let report = await callJson(api, "book_structure_check", {});
  assert.match(report.arcs.join(" "), /Mara's positive arc has no need, lie yet/);
  assert.match(report.arcs.join(" "), /Kell is a protagonist without an arc/);

  // Merged: the want stays when need and milestones are added.
  const updated = await callJson(api, "book_character_update", {
    characterId: "Mara",
    updates: {
      arc: {
        need: "Sich selbst vergeben",
        lie: "Schuld ist Schwäche",
        milestones: [{ chapterId: "K5", note: "Sie gesteht ihren Fehler." }],
      },
    },
  });
  assert.equal(updated.character.arc.want, "Den Mörder finden");
  assert.deepEqual(updated.character.arc.milestones, [{ chapterId: "ch-005", note: "Sie gesteht ihren Fehler." }]);

  report = await callJson(api, "book_structure_check", {});
  assert.ok(!report.arcs.some((a) => /Mara/.test(a)));

  const expose = await callJson(api, "book_expose_generate", { includeSample: false });
  const md = fs.readFileSync(expose.outputPath, "utf-8");
  assert.match(md, /\*\*Mara\*\* \(Hauptfigur\) — Inspektorin\. \*will: Den Mörder finden; braucht: Sich selbst vergeben\.\*/);
});

test("checking without a chosen structure says what to do", async (t) => {
  const { api } = await tenChapters(t);
  await assert.rejects(callJson(api, "book_structure_check", {}), /Choose a structure first/);
  await assert.rejects(callJson(api, "book_beat_set", { beat: "midpoint", chapterId: "K1" }), /Choose a structure first/);
});
