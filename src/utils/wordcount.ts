import { isSceneBreakLine } from "./markdown";

/**
 * Words of prose, not of markup. A heading's "#", a scene break's "* * *", a
 * quote's ">" and a free-standing dash are not words, and counting them used
 * to credit every new chapter with two words before anything was written.
 * A word is a run of non-space characters with at least one letter or digit.
 */
export function countWords(text: string): number {
  let count = 0;
  for (const line of text.split("\n")) {
    if (isSceneBreakLine(line)) continue;
    const prose = line
      .replace(/^[ \t]{0,3}#{1,6}(?=[ \t]|$)/, "")
      .replace(/^[ \t]{0,3}(?:>[ \t]?)+/, "");
    for (const token of prose.split(/\s+/)) {
      if (/[\p{L}\p{N}]/u.test(token)) count++;
    }
  }
  return count;
}

/** Which revision of countWords produced a stored count. */
export const WORD_COUNT_VERSION = 2;

export function estimateReadingTime(wordCount: number): number {
  return Math.ceil(wordCount / 250);
}
