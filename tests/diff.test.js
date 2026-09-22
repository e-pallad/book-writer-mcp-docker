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
