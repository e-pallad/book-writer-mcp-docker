// Line diffing, shared by the chapter history tools (book_chapter_history_list,
// book_chapter_diff) so a summary and a full unified diff can never disagree
// about what changed.

export type EditType = "equal" | "add" | "remove";

export interface Edit {
  type: EditType;
  line: string;
}

export interface DiffStats {
  added: number;
  removed: number;
}

// A chapter revision is normally a handful of edits in a few thousand lines,
// which Myers handles in a blink. A pathological pair (two unrelated texts of
// several thousand lines each) would not, so the search is bounded and falls
// back to "replaced wholesale" rather than stalling a tool call.
const MAX_EDIT_DISTANCE = 4000;

// Chapter files are authored on three platforms; a CRLF file compared against
// an LF one would otherwise read as "every line changed".
export function splitLines(text: string): string[] {
  if (text === "") return [];
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

/**
 * Myers' greedy O(ND) diff. `trace` keeps the furthest-reaching path after
 * each edit so the edit script can be recovered by walking back through it.
 */
export function diffLines(before: string[], after: string[]): Edit[] {
  const n = before.length;
  const m = after.length;

  // Cheap outs that also keep the trace small for the common cases.
  if (n === 0 && m === 0) return [];
  if (n === 0) return after.map((line) => ({ type: "add" as const, line }));
  if (m === 0) return before.map((line) => ({ type: "remove" as const, line }));

  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const v = new Map<number, number>([[1, 0]]);
  const trace: Map<number, number>[] = [];

  for (let d = 0; d <= max; d++) {
    trace.push(new Map(v));

    for (let k = -d; k <= d; k += 2) {
      // Extend downward (an insertion) when that reaches further, otherwise
      // rightward (a deletion).
      const down =
        k === -d || (k !== d && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0));
      let x = down ? v.get(k + 1) ?? 0 : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;

      // Follow the diagonal for as long as the lines match: those are free.
      while (x < n && y < m && before[x] === after[y]) {
        x++;
        y++;
      }
      v.set(k, x);

      if (x >= n && y >= m) return backtrack(trace, before, after);
    }
  }

  // Past the bound: report it as a full replacement rather than guessing.
  return [
    ...before.map((line) => ({ type: "remove" as const, line })),
    ...after.map((line) => ({ type: "add" as const, line })),
  ];
}

function backtrack(
  trace: Map<number, number>[],
  before: string[],
  after: string[]
): Edit[] {
  const edits: Edit[] = [];
  let x = before.length;
  let y = after.length;

  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d];
    const k = x - y;

    const down =
      k === -d || (k !== d && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0));
    const prevK = down ? k + 1 : k - 1;
    const prevX = v.get(prevK) ?? 0;
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      edits.push({ type: "equal", line: before[x - 1] });
      x--;
      y--;
    }

    if (d > 0) {
      if (x === prevX) {
        edits.push({ type: "add", line: after[y - 1] });
        y--;
      } else {
        edits.push({ type: "remove", line: before[x - 1] });
        x--;
      }
    }
  }

  return edits.reverse();
}

export function diffStats(before: string, after: string): DiffStats {
  const stats = { added: 0, removed: 0 };
  for (const edit of diffLines(splitLines(before), splitLines(after))) {
    if (edit.type === "add") stats.added++;
    else if (edit.type === "remove") stats.removed++;
  }
  return stats;
}

interface Hunk {
  beforeStart: number;
  beforeLines: number;
  afterStart: number;
  afterLines: number;
  edits: Edit[];
}

// Groups the edit script into hunks, each padded with up to `context`
// unchanged lines. Runs of more than 2*context unchanged lines split one hunk
// from the next, which is what keeps a unified diff readable.
function buildHunks(edits: Edit[], context: number): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let beforeLine = 1;
  let afterLine = 1;
  let pendingEqual: Edit[] = [];

  for (const edit of edits) {
    if (edit.type === "equal") {
      if (current) {
        pendingEqual.push(edit);
        // Enough unchanged lines have gone by to close this hunk.
        if (pendingEqual.length > context * 2) {
          const trailing = pendingEqual.slice(0, context);
          current.edits.push(...trailing);
          current.beforeLines += trailing.length;
          current.afterLines += trailing.length;
          hunks.push(current);
          current = null;
          // What is left over is leading context for the next hunk: dropping
          // it would leave a later change with no context in front of it.
          pendingEqual = pendingEqual.slice(context);
          if (pendingEqual.length > context) {
            pendingEqual = pendingEqual.slice(-context);
          }
        }
      } else {
        pendingEqual.push(edit);
        if (pendingEqual.length > context) pendingEqual.shift();
      }
      beforeLine++;
      afterLine++;
      continue;
    }

    if (!current) {
      // Open a hunk, backdated over the context lines already buffered.
      current = {
        beforeStart: beforeLine - pendingEqual.length,
        beforeLines: pendingEqual.length,
        afterStart: afterLine - pendingEqual.length,
        afterLines: pendingEqual.length,
        edits: [...pendingEqual],
      };
    } else if (pendingEqual.length) {
      current.edits.push(...pendingEqual);
      current.beforeLines += pendingEqual.length;
      current.afterLines += pendingEqual.length;
    }
    pendingEqual = [];

    current.edits.push(edit);
    if (edit.type === "remove") {
      current.beforeLines++;
      beforeLine++;
    } else {
      current.afterLines++;
      afterLine++;
    }
  }

  if (current) {
    const trailing = pendingEqual.slice(0, context);
    current.edits.push(...trailing);
    current.beforeLines += trailing.length;
    current.afterLines += trailing.length;
    hunks.push(current);
  }

  return hunks;
}

export interface UnifiedDiffOptions {
  fromLabel?: string;
  toLabel?: string;
  context?: number;
}

/** A standard unified diff, readable by eye and by `patch`. */
export function unifiedDiff(
  before: string,
  after: string,
  options: UnifiedDiffOptions = {}
): string {
  const context = options.context ?? 3;
  const edits = diffLines(splitLines(before), splitLines(after));
  const hunks = buildHunks(edits, context);
  if (hunks.length === 0) return "";

  const lines = [
    `--- ${options.fromLabel ?? "before"}`,
    `+++ ${options.toLabel ?? "after"}`,
  ];

  for (const hunk of hunks) {
    // A zero-length side is numbered from the line before it, per the format.
    const beforeStart = hunk.beforeLines === 0 ? hunk.beforeStart - 1 : hunk.beforeStart;
    const afterStart = hunk.afterLines === 0 ? hunk.afterStart - 1 : hunk.afterStart;
    lines.push(
      `@@ -${beforeStart},${hunk.beforeLines} +${afterStart},${hunk.afterLines} @@`
    );
    for (const edit of hunk.edits) {
      const marker = edit.type === "add" ? "+" : edit.type === "remove" ? "-" : " ";
      lines.push(`${marker}${edit.line}`);
    }
  }

  return lines.join("\n");
}
