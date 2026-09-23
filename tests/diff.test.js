const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { diffStats, diffLines, splitLines, unifiedDiff } = require("../dist-tsc/utils/diff");

test("diffStats counts added and removed lines", () => {
  assert.deepEqual(diffStats("a\nb\nc", "a\nb\nc"), { added: 0, removed: 0 });
  assert.deepEqual(diffStats("a\nb\nc", "a\nB\nc"), { added: 1, removed: 1 });
  assert.deepEqual(diffStats("a\nb", "a\nb\nc\nd"), { added: 2, removed: 0 });
  assert.deepEqual(diffStats("a\nb\nc", "a"), { added: 0, removed: 2 });
  assert.deepEqual(diffStats("", "a\nb"), { added: 2, removed: 0 });
  assert.deepEqual(diffStats("a\nb", ""), { added: 0, removed: 2 });
  assert.deepEqual(diffStats("", ""), { added: 0, removed: 0 });
});

test("line endings do not count as changes", () => {
  // A chapter edited on Windows and one edited on Linux differ in every line
  // byte-wise, but nothing about the prose changed.
  assert.deepEqual(diffStats("a\r\nb\r\nc", "a\nb\nc"), { added: 0, removed: 0 });
  assert.deepEqual(diffStats("a\rb\rc", "a\nb\nc"), { added: 0, removed: 0 });
});

test("non-ASCII prose diffs by line, not by byte", () => {
  const before = "Er trank Kaffee.\nSie ging fort.";
  const after = "Er trank Tee.\nSie ging fort.";
  assert.deepEqual(diffStats(before, after), { added: 1, removed: 1 });
});

test("the edit script preserves the new text in order", () => {
  const before = splitLines("one\ntwo\nthree");
  const after = splitLines("one\ntwo point five\nthree\nfour");
  const edits = diffLines(before, after);

  const rebuilt = edits
    .filter((e) => e.type !== "remove")
    .map((e) => e.line)
    .join("\n");
  assert.equal(rebuilt, "one\ntwo point five\nthree\nfour");

  const original = edits
    .filter((e) => e.type !== "add")
    .map((e) => e.line)
    .join("\n");
  assert.equal(original, "one\ntwo\nthree");
});

test("identical input produces an empty diff", () => {
  assert.equal(unifiedDiff("same\ntext", "same\ntext"), "");
});

test("the unified diff matches GNU diff and applies with patch", (t) => {
  const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
  const afterLines = before.split("\n");
  afterLines[3] = "line 3 rewritten";
  afterLines.splice(12, 0, "an inserted line");
  afterLines.splice(22, 1);
  const after = afterLines.join("\n");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "book-mcp-diff-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const beforePath = path.join(dir, "before.txt");
  const afterPath = path.join(dir, "after.txt");
  fs.writeFileSync(beforePath, before);
  fs.writeFileSync(afterPath, after);

  // GNU diff, minus its own file header, is the reference rendering.
  let reference = "";
  try {
    execFileSync("diff", ["-u", beforePath, afterPath], { encoding: "utf-8" });
  } catch (error) {
    reference = error.stdout;
  }
  const referenceBody = reference.split("\n").slice(2).join("\n").trimEnd();
  const ours = unifiedDiff(before, after, { fromLabel: "b", toLabel: "a" })
    .split("\n")
    .slice(2)
    .join("\n")
    .trimEnd();
  assert.equal(ours, referenceBody, "our hunks should match GNU diff -u");

  // And it is a real patch, not just something that looks like one.
  const patchPath = path.join(dir, "ours.patch");
  const target = path.join(dir, "patched.txt");
  fs.writeFileSync(
    patchPath,
    unifiedDiff(before, after, { fromLabel: "before.txt", toLabel: "after.txt" }) + "\n"
  );
  fs.copyFileSync(beforePath, target);
  execFileSync("patch", ["-s", target], { input: fs.readFileSync(patchPath) });
  assert.equal(fs.readFileSync(target, "utf-8"), after);
});

test("a wholly different text still produces a usable diff", () => {
  const before = Array.from({ length: 200 }, (_, i) => `old ${i}`).join("\n");
  const after = Array.from({ length: 200 }, (_, i) => `new ${i}`).join("\n");
  const stats = diffStats(before, after);
  assert.equal(stats.added, 200);
  assert.equal(stats.removed, 200);
});

// GNU diff is the reference for all three trailing-newline combinations. A
// file ending in a newline has that newline as a terminator, not as an extra
// empty line — counting it as a line made every hunk header one too long and
// patch(1) rejected the result.
function gnuDiff(before, after, dir) {
  const a = path.join(dir, "a.txt");
  const b = path.join(dir, "b.txt");
  fs.writeFileSync(a, before);
  fs.writeFileSync(b, after);
  try {
    execFileSync("diff", ["-u", a, b], { encoding: "utf-8" });
    return "";
  } catch (error) {
    return error.stdout.split("\n").slice(2).join("\n").trimEnd();
  }
}

const body = (lines, trailing) => lines.join("\n") + (trailing ? "\n" : "");

for (const [name, beforeNl, afterNl] of [
  ["both files end with a newline", true, true],
  ["neither file ends with a newline", false, false],
  ["only the original ends with a newline", true, false],
  ["only the revision ends with a newline", false, true],
]) {
  test(`trailing newlines: ${name}`, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "book-mcp-nl-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const before = body(["alpha", "beta", "gamma"], beforeNl);
    const after = body(["alpha", "BETA", "gamma"], afterNl);

    const ours = unifiedDiff(before, after, { fromLabel: "a", toLabel: "b" })
      .split("\n")
      .slice(2)
      .join("\n")
      .trimEnd();

    assert.equal(ours, gnuDiff(before, after, dir));
  });
}

test("a chapter that only gains a trailing newline is not a one-line change", () => {
  assert.deepEqual(diffStats("alpha\nbeta", "alpha\nbeta\n"), {
    added: 0,
    removed: 0,
  });
});

// Hand-picked cases only cover what I thought to try. This throws a few hundred
// random edit patterns at the same two oracles: byte-equality with diff(1), and
// the patch actually reconstructing the revision.
test("randomised edits match diff(1) and round-trip through patch(1)", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "book-mcp-fuzz-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Deterministic PRNG, so a failure is reproducible from the seed alone.
  let seed = 0x2f6e2b1;
  const rand = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return Math.abs(seed) / 0x7fffffff;
  };
  const pick = (n) => Math.floor(rand() * n);

  for (let round = 0; round < 250; round++) {
    const length = 1 + pick(40);
    const original = Array.from({ length }, (_, i) => `line ${i} ${pick(5)}`);
    const revised = [...original];

    const edits = 1 + pick(6);
    for (let e = 0; e < edits; e++) {
      if (revised.length === 0) {
        revised.push(`inserted ${pick(100)}`);
        continue;
      }
      const at = pick(revised.length);
      const kind = pick(3);
      if (kind === 0) revised.splice(at, 1);
      else if (kind === 1) revised.splice(at, 0, `inserted ${pick(100)}`);
      else revised[at] = `changed ${pick(100)}`;
    }

    const beforeNl = pick(2) === 0;
    const afterNl = pick(2) === 0;
    const before = original.join("\n") + (beforeNl ? "\n" : "");
    const after = revised.join("\n") + (afterNl ? "\n" : "");
    if (before === after) continue;

    const context = pick(4);
    const a = path.join(dir, "a.txt");
    const b = path.join(dir, "b.txt");
    fs.writeFileSync(a, before);
    fs.writeFileSync(b, after);

    let reference = "";
    try {
      execFileSync("diff", [`-U${context}`, a, b], { encoding: "utf-8" });
    } catch (error) {
      reference = error.stdout.split("\n").slice(2).join("\n").trimEnd();
    }

    const ours = unifiedDiff(before, after, {
      fromLabel: "a",
      toLabel: "b",
      context,
    });
    const oursBody = ours.split("\n").slice(2).join("\n").trimEnd();

    assert.equal(
      oursBody,
      reference,
      `round ${round} (context ${context}) diverged from diff(1)\nbefore:\n${before}\nafter:\n${after}`
    );

    // And it reconstructs the revision.
    const target = path.join(dir, "target.txt");
    fs.writeFileSync(target, before);
    fs.writeFileSync(
      path.join(dir, "p.patch"),
      unifiedDiff(before, after, {
        fromLabel: "target.txt",
        toLabel: "target.txt",
        context,
      }) + "\n"
    );
    execFileSync("patch", ["-s", target], {
      input: fs.readFileSync(path.join(dir, "p.patch")),
      cwd: dir,
    });
    assert.equal(
      fs.readFileSync(target, "utf-8"),
      after,
      `round ${round}: patch did not reproduce the revision`
    );
  }
});
