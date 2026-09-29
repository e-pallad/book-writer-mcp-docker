// The Normseite: the unit German publishing measures a manuscript in. Thirty
// lines of at most sixty characters, set in a fixed-width face so that every
// page holds the same amount of text. A page count in Normseiten is what an
// agency, a publisher or a translator quotes and pays by.

import { Block, parseBlocks, plainText } from "../utils/markdown";
import { AssembledBook } from "./assemble";

// Courier New is 0.6 em wide: at 12 pt a character is 7.2 pt, 144 twips.
const CHAR_TWIPS = 144;
const CHARS_PER_LINE = 60;
const LINES_PER_PAGE = 30;
const INDENT_CHARS = 3;

// A4, 2.5 cm top, bottom and left; the right margin is whatever leaves exactly
// sixty characters. The line pitch fits thirty lines and not a thirty-first.
const A4_WIDTH = 11906;
const A4_HEIGHT = 16838;
const MARGIN = 1418; // 2.5 cm
const TEXT_HEIGHT = A4_HEIGHT - 2 * MARGIN;

export const NORMSEITE = {
  charsPerLine: CHARS_PER_LINE,
  linesPerPage: LINES_PER_PAGE,
  marginLeft: MARGIN,
  marginRight: A4_WIDTH - MARGIN - CHARS_PER_LINE * CHAR_TWIPS,
  marginTop: MARGIN,
  marginBottom: MARGIN,
  lineTwips: Math.floor(TEXT_HEIGHT / LINES_PER_PAGE),
  indentTwips: INDENT_CHARS * CHAR_TWIPS,
  // Where a chapter's first line sits: four lines down.
  chapterSinkLines: 4,
};

/** Lines a paragraph takes when words are wrapped at `width` characters. */
export function wrappedLines(text: string, width: number, firstLineWidth = width): number {
  let lines = 0;
  for (const hardLine of text.split("\n")) {
    let capacity = lines === 0 ? firstLineWidth : width;
    let used = 0;
    let count = 1;
    for (const word of hardLine.split(/\s+/).filter(Boolean)) {
      const needed = used === 0 ? word.length : used + 1 + word.length;
      if (needed <= capacity) {
        used = needed;
        continue;
      }
      // Too long for the rest of this line: a new line — or several, for a
      // word longer than a whole line.
      count += used === 0 ? 0 : 1;
      capacity = width;
      used = word.length;
      while (used > capacity) {
        count++;
        used -= capacity;
      }
    }
    lines += count;
  }
  return Math.max(1, lines);
}

function blockLines(blocks: Block[]): number {
  let lines = 0;
  for (const block of blocks) {
    switch (block.type) {
      case "paragraph":
        lines += wrappedLines(plainText(block.text), CHARS_PER_LINE, CHARS_PER_LINE - INDENT_CHARS);
        break;
      case "heading":
        lines += 2; // the heading and the line before it
        break;
      case "sceneBreak":
        lines += 3; // blank, the mark, blank
        break;
      case "blockquote":
        // Set in by five characters on either side.
        for (const inner of block.blocks) {
          if (inner.type === "paragraph" || inner.type === "heading") {
            lines += wrappedLines(plainText(inner.text), CHARS_PER_LINE - 10);
          }
        }
        break;
    }
  }
  return lines;
}

export interface Extent {
  normPages: number;
  words: number;
  /** Characters including spaces — the other measure publishers quote. */
  characters: number;
}

/**
 * How many Normseiten the body of the book fills, laid out the way the
 * Normseite export sets it: every chapter and part page on a new page, a
 * chapter opening four lines down, paragraphs indented by three characters,
 * words wrapped at sixty characters. Front and back matter are not counted,
 * as they are not in a quoted extent.
 */
export function measureExtent(book: AssembledBook): Extent {
  let normPages = 0;
  let words = 0;
  let characters = 0;

  for (const item of book.body) {
    if (item.kind === "part") {
      normPages += 1;
      continue;
    }
    const blocks = parseBlocks(item.body);
    const lines =
      NORMSEITE.chapterSinkLines +
      (item.label ? 1 : 0) +
      2 + // the chapter title and the line after it
      blockLines(blocks);
    normPages += Math.ceil(lines / LINES_PER_PAGE);

    const text = [item.heading, ...blocks.map((b) => ("text" in b ? plainText(b.text) : ""))].join(" ");
    words += text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
    characters += text.replace(/\s+/g, " ").trim().length;
  }

  return { normPages, words, characters };
}
