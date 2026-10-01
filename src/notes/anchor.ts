// Finding a note's passage again. A note is anchored to the words it is about,
// not to a position, so it follows its passage when the text around it is
// revised — and says so plainly when a revision has removed it.

import { Note } from "../storage/schema";
import { paragraphNumberAt, toNFC } from "../utils/text";
import { condense } from "../utils/match";

export interface NoteLocation {
  /** Whether the anchored passage is still in the chapter. */
  found: boolean;
  /** The paragraph it is in now; for a note on the whole chapter, null. */
  paragraph: number | null;
  /** How many times the passage occurs, when more than once. */
  occurrences?: number;
  /** The passage with a little context, to recognise it by. */
  context?: string;
}

/** A fresh id that is not among `existing`. */
export function newNoteId(existing: Pick<Note, "id">[]): string {
  const taken = new Set(existing.map((n) => n.id));
  const base = `note-${Date.now().toString(36)}`;
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}

const CONTEXT = 40;

export function locateNote(note: Pick<Note, "anchorText" | "paragraphHint">, content: string): NoteLocation {
  if (!note.anchorText) return { found: true, paragraph: null };

  const text = toNFC(content);
  const needle = toNFC(note.anchorText);
  const offsets: number[] = [];
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) {
    offsets.push(at);
  }
  if (!offsets.length) return { found: false, paragraph: note.paragraphHint ?? null };

  // Of several, the one nearest to where the passage was.
  const hint = note.paragraphHint;
  const best = offsets
    .map((at) => ({ at, paragraph: paragraphNumberAt(text, at) }))
    .sort((a, b) =>
      hint === undefined ? a.at - b.at : Math.abs(a.paragraph - hint) - Math.abs(b.paragraph - hint)
    )[0];

  return {
    found: true,
    paragraph: best.paragraph,
    ...(offsets.length > 1 ? { occurrences: offsets.length } : {}),
    context: condense(
      text.slice(Math.max(0, best.at - CONTEXT), best.at + needle.length + CONTEXT),
      needle.length + 2 * CONTEXT + 2
    ),
  };
}
