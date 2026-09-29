// Finding text in chapters and showing where it is. Shared by the chapter
// tools (one chapter, exact) and the book-wide ones (every chapter, with
// whole-word and case options), so a snippet looks the same from both.

import { escapeRegExp, paragraphNumberAt, toNFC } from "./text";

export interface TextMatch {
  index: number;
  /** The text as it appears — which may differ in case from the query. */
  text: string;
}

export interface MatchOptions {
  /** Only where the query is a whole word: "Mara" but not "Maraschino". */
  wholeWord?: boolean;
  /** Default true. Folding case is Unicode-aware, so "ÜBER" finds "über". */
  caseSensitive?: boolean;
}

const WORD_CHAR = "[\\p{L}\\p{N}_]";

/**
 * Every non-overlapping occurrence of `query`, the way a replacement would
 * see them. Both sides are folded to NFC first, so an "ö" typed on macOS
 * matches the one stored on disk.
 */
export function findText(content: string, query: string, options: MatchOptions = {}): TextMatch[] {
  const needle = toNFC(query);
  if (!needle) return [];
  const body = escapeRegExp(needle);
  const source = options.wholeWord ? `(?<!${WORD_CHAR})${body}(?!${WORD_CHAR})` : body;
  const flags = `gu${options.caseSensitive === false ? "i" : ""}`;
  return [...toNFC(content).matchAll(new RegExp(source, flags))].map((m) => ({
    index: m.index ?? 0,
    text: m[0],
  }));
}

/**
 * Splices `replacement` in at each match, literally. Not String.replace, which
 * reads "$&" and "$1" in the replacement as patterns — prose containing a
 * stray "$&" would come back mangled.
 */
export function spliceMatches(content: string, matches: TextMatch[], replacement: string): string {
  let result = "";
  let cursor = 0;
  for (const match of matches) {
    result += content.slice(cursor, match.index) + replacement;
    cursor = match.index + match.text.length;
  }
  return result + content.slice(cursor);
}

// Long enough to recognise a passage, short enough that a reply with several
// of them stays small — the whole point of these tools is to avoid moving the
// chapter through the conversation.
export const MAX_SNIPPET_MATCH = 120;

/**
 * Runs of whitespace collapse to a single space so a snippet stays on one
 * line. It is a preview for locating a passage, not a quotation.
 */
export function condense(value: string, limit = Number.POSITIVE_INFINITY): string {
  const flattened = value.replace(/\s+/g, " ");
  return flattened.length > limit ? `${flattened.slice(0, limit)}…` : flattened;
}

export interface Snippet {
  paragraph: number;
  before: string;
  match: string;
  after: string;
}

export function snippetAt(
  content: string,
  start: number,
  length: number,
  contextChars: number
): Snippet {
  const end = start + length;
  return {
    paragraph: paragraphNumberAt(content, start),
    before: condense(content.slice(Math.max(0, start - contextChars), start)),
    match: condense(content.slice(start, end), MAX_SNIPPET_MATCH),
    after: condense(content.slice(end, end + contextChars)),
  };
}
