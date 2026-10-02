const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const { collectTools, callJson } = require("./helpers/tools");
const { useTempProject, cleanup } = require("./helpers/project");

function tools() {
  const m = (n) => require(`../dist-tsc/tools/${n}`);
  return collectTools(
    m("manuscript").registerManuscriptTools,
    m("storybible").registerStoryBibleTools,
    m("preview").registerPreviewTools,
    m("notes").registerNoteTools
  );
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function seed(t) {
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
    role: "protagonist",
    description: "Dock inspector.",
  });
  await callJson(api, "book_chapter_create", {
    title: "One",
    synopsis: "s",
    content: "# One\n\nMara walked the quay.\n",
  });
  const draft = await callJson(api, "book_chapter_create", {
    title: "Two",
    synopsis: "s",
    content: "# Two\n\nA sentence still being drafted.\n",
  });
  await callJson(api, "book_chapter_update", { chapterId: "ch-001", status: "final" });
  await callJson(api, "book_chapter_update", { chapterId: draft.chapterId, status: "draft" });
  return { dir, api };
}

/** Boots the generated preview/server.js exactly as an author would. */
async function boot(t, dir) {
  const port = await freePort();
  const serverPath = path.join(dir, "preview", "server.js");
  const child = spawn(process.execPath, [serverPath], {
    // No BOOK_PROJECT_DIR: the server has to work out the project from its own
    // location, which is how it runs on an author's machine.
    env: { ...process.env, BOOK_PROJECT_DIR: "", PREVIEW_PORT: String(port) },
    cwd: path.join(dir, "preview"),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  t.after(
    () =>
      new Promise((resolve) => {
        child.once("exit", resolve);
        child.kill("SIGKILL");
      })
  );

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited:\n${log}`);
    try {
      const res = await fetch(`${base}/`);
      if (res.ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) throw new Error(`server never came up:\n${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return { base, getLog: () => log };
}

test("book_preview_server writes a standalone server and reports its routes", async (t) => {
  const { dir, api } = await seed(t);
  const result = await callJson(api, "book_preview_server", { port: 3456 });

  const serverPath = path.join(dir, "preview", "server.js");
  assert.equal(result.serverPath, serverPath);
  assert.ok(fs.existsSync(serverPath));

  assert.match(result.urls.dashboard, /\/dashboard$/);
  assert.match(result.urls.data, /\/dashboard\.json$/);

  // It is the bundle, not a hand-assembled string, and it stands alone.
  const source = fs.readFileSync(serverPath, "utf-8");
  assert.ok(source.length > 10000, "expected a bundled server");
  assert.ok(!fs.existsSync(path.join(dir, "preview", "node_modules")));

  assert.ok(result.wordCount > 0);
  assert.equal(result.chaptersIncluded, 2, "the live reader shows drafts too");
});

test("the server serves the manuscript, the dashboard and the data", async (t) => {
  const { dir, api } = await seed(t);
  await callJson(api, "book_preview_server", {});
  const { base } = await boot(t, dir);

  const reader = await fetch(`${base}/`);
  assert.equal(reader.status, 200);
  assert.match(reader.headers.get("content-type"), /text\/html/);
  const readerHtml = await reader.text();
  assert.match(readerHtml, /Mara walked the quay/);
  // Drafts included: someone watching while writing wants to see the draft.
  assert.match(readerHtml, /still being drafted/);

  const dashboard = await fetch(`${base}/dashboard`);
  assert.equal(dashboard.status, 200);
  const dashboardHtml = await dashboard.text();
  assert.match(dashboardHtml, /Who appears where/);
  assert.match(dashboardHtml, /The Harbour Light/);

  const data = await fetch(`${base}/dashboard.json`);
  assert.equal(data.status, 200);
  assert.match(data.headers.get("content-type"), /application\/json/);
  const json = await data.json();
  assert.equal(json.overview.title, "The Harbour Light");
  assert.equal(json.overview.chapterCount, 2);

  const missing = await fetch(`${base}/nope`);
  assert.equal(missing.status, 404);
});

test("both pages are rebuilt from the chapter files on every request", async (t) => {
  const { dir, api } = await seed(t);
  await callJson(api, "book_preview_server", {});
  const { base } = await boot(t, dir);

  const before = await (await fetch(`${base}/dashboard.json`)).json();

  // Edit a chapter behind the server's back — no tool call, no restart.
  const registry = JSON.parse(
    fs.readFileSync(path.join(dir, ".book-mcp", "registry.json"), "utf-8")
  );
  const first = registry.chapters.find((c) => c.id === "ch-001");
  fs.appendFileSync(
    path.join(dir, "chapters", first.filename),
    "\nA sentence added while the server was running.\n"
  );

  const readerHtml = await (await fetch(`${base}/`)).text();
  assert.match(readerHtml, /added while the server was running/);

  const after = await (await fetch(`${base}/dashboard.json`)).json();
  assert.ok(
    after.overview.totalWords > before.overview.totalWords,
    `word count should track the files: ${before.overview.totalWords} -> ${after.overview.totalWords}`
  );
  // And it says plainly that the registry is now behind.
  assert.ok(
    after.notes.some((n) => /differ in length from what the registry records/.test(n)),
    JSON.stringify(after.notes)
  );
});

test("neither page reloads on a timer; both update only when their content changed", async (t) => {
  const { dir, api } = await seed(t);
  await callJson(api, "book_preview_server", {});
  const { base } = await boot(t, dir);

  const dashboard = await (await fetch(`${base}/dashboard`)).text();
  assert.ok(!/http-equiv="refresh"/.test(dashboard), "the dashboard must not reload on a timer");
  assert.match(dashboard, /fetch\('\/dashboard\/version'/);

  const d1 = await (await fetch(`${base}/dashboard/version`)).json();
  await new Promise((r) => setTimeout(r, 1100));
  const d2 = await (await fetch(`${base}/dashboard/version`)).json();
  assert.equal(d1.version, d2.version, "the passing of time alone is not a change");
  assert.ok(dashboard.includes(`data-version="${d1.version}"`));

  const reader = await (await fetch(`${base}/`)).text();
  assert.ok(!/http-equiv="refresh"/.test(reader), "the reader must not reload on a timer");
  assert.match(reader, /fetch\('\/version'/);

  const v1 = await (await fetch(`${base}/version`)).json();
  const v2 = await (await fetch(`${base}/version`)).json();
  assert.equal(v1.version, v2.version, "unchanged text keeps its version");
  assert.ok(reader.includes(v1.version), "the page carries the version it shows");

  const registry = JSON.parse(
    fs.readFileSync(path.join(dir, ".book-mcp", "registry.json"), "utf-8")
  );
  const first = registry.chapters.find((c) => c.id === "ch-001");
  fs.appendFileSync(path.join(dir, "chapters", first.filename), "\nMore text.\n");
  const v3 = await (await fetch(`${base}/version`)).json();
  assert.notEqual(v3.version, v1.version, "a change to the text changes the version");
  const d3 = await (await fetch(`${base}/dashboard/version`)).json();
  assert.notEqual(d3.version, d1.version, "a change to the book changes the dashboard version");
});

test("a passage marked in the preview becomes an open note on its chapter", async (t) => {
  const { dir, api } = await seed(t);
  await callJson(api, "book_preview_server", {});
  const { base } = await boot(t, dir);

  const post = (body, headers = {}) =>
    fetch(`${base}/api/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  const ok = await post({
    selection: "walked the quay",
    container: "Mara walked the quay.",
    text: "Zu glatt.",
    kind: "suggestion",
  });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).openNotes, 1);

  const listed = await callJson(api, "book_note_list", {});
  assert.equal(listed.count, 1);
  assert.equal(listed.notes[0].chapterId, "ch-001");
  assert.equal(listed.notes[0].anchorText, "walked the quay");
  assert.equal(listed.notes[0].location.found, true);
  assert.match(listed.notes[0].text, /Zu glatt/);

  const version = await (await fetch(`${base}/version`)).json();
  assert.equal(version.openNotes, 1);
  assert.ok(version.notesVersion);

  // The reader can draw the note on its passage.
  const highlights = await (await fetch(`${base}/api/notes`)).json();
  assert.equal(highlights.version, version.notesVersion);
  assert.equal(highlights.notes.length, 1);
  assert.equal(highlights.notes[0].quote, "walked the quay");
  assert.equal(highlights.notes[0].container, "Mara walked the quay.");
  assert.match(highlights.notes[0].text, /Zu glatt/);

  const nowhere = await post({ selection: "text that is in no chapter" });
  assert.equal(nowhere.status, 400);

  const foreign = await post({ selection: "walked the quay" }, { Origin: "http://evil.example" });
  assert.equal(foreign.status, 403);
  const plain = await fetch(`${base}/api/notes`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ selection: "walked the quay" }),
  });
  assert.equal(plain.status, 403);
});

test("the exported dashboard still has no refresh and no script", async (t) => {
  const { dir } = await seed(t);
  const dash = collectTools(
    require("../dist-tsc/tools/dashboard").registerDashboardTools
  );
  const out = path.join(dir, "dashboard.html");
  await callJson(dash, "book_dashboard_export", { outputPath: out });

  const html = fs.readFileSync(out, "utf-8");
  assert.ok(!/<script/i.test(html));
  assert.ok(
    !/http-equiv="refresh"/.test(html),
    "a saved file should not try to reload itself"
  );
});

test("a directory with no project explains itself instead of crashing", async (t) => {
  const { dir, api } = await seed(t);
  await callJson(api, "book_preview_server", {});

  // Move the project data away, leaving the server pointing at nothing.
  fs.renameSync(path.join(dir, ".book-mcp"), path.join(dir, ".book-mcp-moved"));
  const { base } = await boot(t, dir);

  const reader = await fetch(`${base}/`);
  assert.equal(reader.status, 200, "it should answer, not fall over");
  assert.match(await reader.text(), /No book project here/);

  const data = await fetch(`${base}/dashboard.json`);
  assert.equal(data.status, 500);
  assert.match((await data.json()).error, /No book project found/);
});
