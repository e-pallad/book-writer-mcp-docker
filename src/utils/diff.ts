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
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  // A trailing newline terminates the last line rather than opening an empty
  // one. Counting it as a line is what diff(1) does not do, and a phantom
  // extra line makes every hunk header one too long — enough for patch(1) to
  // reject the result.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// A file whose last line has no terminating newline is marked in the output,
// so applying the diff reproduces that byte-for-byte too.
function endsWithNewline(text: string): boolean {
  return text === "" || /\n$/.test(text.replace(/\r\n?/g, "\n"));
}

const NO_NEWLINE_MARKER = "\\ No newline at end of file";

/**
 * Turns context lines that are not really equal into a removal and an addition.
 *
 * Two lines with the same text still differ if one of them ends the file
 * without a newline and the other does not. That happens whenever a line is
 * the last of one side but not of the other, as well as when both sides end on
 * it with different termination. diff(1) renders those as a change carrying
 * the no-newline marker, and a diff that calls them context does not apply
 * cleanly.
 */
function splitUnterminatedContext(
  edits: Edit[],
  beforeCount: number,
  afterCount: number,
  beforeComplete: boolean,
  afterComplete: boolean
): Edit[] {
  if (beforeComplete && afterComplete) return edits;

  const result: Edit[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;

  for (const edit of edits) {
    if (edit.type !== "equal") {
      result.push(edit);
      if (edit.type === "remove") beforeIndex++;
      else afterIndex++;
      continue;
    }

    // A line is terminated unless it is the final line of a file that has no
    // trailing newline.
    const beforeTerminated = beforeIndex !== beforeCount - 1 || beforeComplete;
    const afterTerminated = afterIndex !== afterCount - 1 || afterComplete;

    if (beforeTerminated === afterTerminated) {
      result.push(edit);
    } else {
      result.push({ type: "remove", line: edit.line });
      result.push({ type: "add", line: edit.line });
    }

    beforeIndex++;
    afterIndex++;
  }

  return result;
}

// Within a run of changes, every removal is listed before every addition. The
// raw edit script interleaves them (-a +A -b +B); conventional unified diffs,
// diff(1) included, group them (-a -b +A +B). Order within each side is kept.
function groupChanges(edits: Edit[]): Edit[] {
  const grouped: Edit[] = [];
  let index = 0;

  while (index < edits.length) {
    if (edits[index].type === "equal") {
      grouped.push(edits[index++]);
      continue;
    }
    const run: Edit[] = [];
    while (index < edits.length && edits[index].type !== "equal") {
      run.push(edits[index++]);
    }
    grouped.push(...run.filter((edit) => edit.type === "remove"));
    grouped.push(...run.filter((edit) => edit.type === "add"));
  }

  return grouped;
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
          // At context 0 there is no such thing, and slice(-0) would keep the
          // whole run rather than none of it.
          pendingEqual =
            context === 0 ? [] : pendingEqual.slice(context).slice(-context);
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

// One side of a hunk header. A single-line range prints as a bare line number,
// and an empty one is numbered from the line it follows — both as diff(1)
// writes them, and both load-bearing for patch(1).
function range(start: number, count: number): string {
  if (count === 0) return `${start - 1},0`;
  if (count === 1) return `${start}`;
  return `${start},${count}`;
}

/** A standard unified diff, readable by eye and by `patch`. */
export function unifiedDiff(
  before: string,
  after: string,
  options: UnifiedDiffOptions = {}
): string {
  const context = options.context ?? 3;
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const beforeComplete = endsWithNewline(before);
  const afterComplete = endsWithNewline(after);

  const edits = splitUnterminatedContext(
    diffLines(beforeLines, afterLines),
    beforeLines.length,
    afterLines.length,
    beforeComplete,
    afterComplete
  );

  const hunks = buildHunks(groupChanges(edits), context);
  if (hunks.length === 0) return "";

  const lines = [
    `--- ${options.fromLabel ?? "before"}`,
    `+++ ${options.toLabel ?? "after"}`,
  ];

  for (const hunk of hunks) {
    lines.push(
      `@@ -${range(hunk.beforeStart, hunk.beforeLines)} +${range(
        hunk.afterStart,
        hunk.afterLines
      )} @@`
    );

    // Line numbers within the hunk, so the last line of either side can be
    // recognised and marked when it carries no terminating newline.
    let beforePos = hunk.beforeStart;
    let afterPos = hunk.afterStart;

    for (const edit of hunk.edits) {
      const marker = edit.type === "add" ? "+" : edit.type === "remove" ? "-" : " ";
      lines.push(`${marker}${edit.line}`);

      const consumesBefore = edit.type !== "add";
      const consumesAfter = edit.type !== "remove";
      const beforeIsLast = consumesBefore && beforePos === beforeLines.length;
      const afterIsLast = consumesAfter && afterPos === afterLines.length;
      if (consumesBefore) beforePos++;
      if (consumesAfter) afterPos++;

      if (edit.type === "remove" && beforeIsLast && !beforeComplete) {
        lines.push(NO_NEWLINE_MARKER);
      } else if (edit.type === "add" && afterIsLast && !afterComplete) {
        lines.push(NO_NEWLINE_MARKER);
      } else if (
        edit.type === "equal" &&
        beforeIsLast &&
        afterIsLast &&
        (!beforeComplete || !afterComplete)
      ) {
        lines.push(NO_NEWLINE_MARKER);
      }
    }
  }

  return lines.join("\n");
}
