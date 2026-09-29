// Placeholders a writer leaves while drafting. The rule of a first draft is to
// keep going — "[TK]" (to come) where a name or a fact is missing, "[TODO:
// check the tide tables]" for research — and to fill them in later. Later is
// only safe if nothing leaves the building with one still in it.

import { paragraphNumberAt, toNFC } from "./text";
import { condense } from "./match";

export interface Placeholder {
  /** The marker as written: "[TK]", "[TODO: Name des Hafens]". */
  marker: string;
  /** TK, TODO, FIXME, RECHERCHE, PRÜFEN, CHECK, XXX. */
  kind: string;
  /** What the marker says needs doing, when it says anything. */
  note: string;
  paragraph: number;
  context: string;
}

// Bracketed markers, in either language, with an optional note after a colon
// or a space: [TK], [TK: Name], [TODO Hafen], [RECHERCHE: Gezeiten 1997].
// Only these words open a marker, so an ordinary bracket in prose — "[sic]",
// a stage direction — is left alone.
const BRACKETED =
  /\[(TK|TODO|FIXME|RECHERCHE|PRÜFEN|PRUEFEN|CHECK|XXX)(?:[:\s]\s*([^\]]*))?\]/giu;

// A bare TK, the journalist's "to come": capitals, a word of its own. "TK" in
// the middle of a German compound or a lowercase "tk" is not one.
const BARE_TK = /(?<![\p{L}\p{N}_])TK(?![\p{L}\p{N}_])/gu;

const CONTEXT = 40;

export function findPlaceholders(content: string): Placeholder[] {
  const text = toNFC(content);
  const found: { index: number; length: number; kind: string; note: string }[] = [];

  for (const match of text.matchAll(BRACKETED)) {
    found.push({
      index: match.index ?? 0,
      length: match[0].length,
      kind: match[1].toUpperCase().replace("PRUEFEN", "PRÜFEN"),
      note: (match[2] ?? "").trim(),
    });
  }
  for (const match of text.matchAll(BARE_TK)) {
    const at = match.index ?? 0;
    // Already counted as part of "[TK…]".
    if (found.some((f) => at >= f.index && at < f.index + f.length)) continue;
    found.push({ index: at, length: 2, kind: "TK", note: "" });
  }

  return found
    .sort((a, b) => a.index - b.index)
    .map((f) => ({
      marker: text.slice(f.index, f.index + f.length),
      kind: f.kind,
      note: f.note,
      paragraph: paragraphNumberAt(text, f.index),
      context: condense(
        text.slice(Math.max(0, f.index - CONTEXT), f.index + f.length + CONTEXT),
        f.length + 2 * CONTEXT + 2
      ),
    }));
}

/** "3 placeholder(s) left: ch-002 (2), ch-005 (1)" — for an export's warnings. */
export function placeholderWarning(counts: { chapter: string; count: number }[]): string | null {
  const total = counts.reduce((sum, c) => sum + c.count, 0);
  if (!total) return null;
  return `${total} placeholder(s) like [TK] or [TODO] are still in the text: ${counts
    .map((c) => `${c.chapter} (${c.count})`)
    .join(", ")}. book_todo_list shows each one.`;
}
