// Adding paragraphs to a chapter without touching the ones already there.
// Shared by book_chapter_append and book_chapter_insert, so text added at the
// end and text added in the middle is joined to its neighbours the same way:
// one blank line, as the paragraph splitter and the renderers expect.

import { isSceneBreakLine } from "./markdown";
import { paragraphNumberAt, splitParagraphs, toNFC } from "./text";
import { BookMCPError } from "./errors";
import { countWords } from "./wordcount";

/** What a manuscript uses when it has no scene break of its own yet. */
export const DEFAULT_SCENE_BREAK = "* * *";

export interface SpliceResult {
  /** The whole chapter after the change. Never returned to the caller. */
  next: string;
  /** 1-based paragraph number of the first paragraph of the new text. */
  firstNewParagraph: number;
  /** Paragraphs the new text consists of, scene break not included. */
  paragraphsAdded: number;
  /** 1-based paragraph number of the scene break put in front, if any. */
  sceneBreakParagraph?: number;
  wordCountBefore: number;
  wordCountAfter: number;
}

/**
 * The text to add, without the blank lines around it. The seam to the
 * existing text is always exactly one blank line, whatever the caller sent.
 */
export function normaliseAddition(content: string): string {
  const block = toNFC(content)
    .replace(/^\s*\n/, "") // leading blank lines, but not the first line's indent
    .replace(/\s+$/, "");
  if (!block.trim()) {
    throw new BookMCPError("content cannot be empty — there would be nothing to add.");
  }
  return block;
}

/**
 * Puts `block` in at `pos` as paragraphs of its own. The whitespace on either
 * side of the seam is replaced by a single blank line; every other character
 * of the chapter stays as it was.
 */
function spliceAt(
  content: string,
  pos: number,
  block: string
): { next: string; blockStart: number } {
  const head = content.slice(0, pos).replace(/\s+$/, "");
  // Up to and including the last newline of the break, so an indented first
  // line of the following paragraph keeps its indent.
  const tail = content.slice(pos).replace(/^\s*\n/, "");
  const lead = head ? "\n\n" : "";
  const next = head + lead + block + (tail.trim() ? `\n\n${tail}` : "\n");
  return { next, blockStart: head.length + lead.length };
}

/** The scene break line a chapter already uses, so an added one matches it. */
export function sceneBreakMarker(content: string): string {
  const existing = content.split("\n").find((line) => isSceneBreakLine(line));
  return existing ? existing.trim() : DEFAULT_SCENE_BREAK;
}

/** Whether a chapter holds anything besides headings and blank lines. */
function hasProse(content: string): boolean {
  return content
    .split("\n")
    .some((line) => line.trim() !== "" && !/^[ \t]{0,3}#{1,6}[ \t]/.test(line));
}

function finish(
  content: string,
  next: string,
  blockStart: number,
  block: string,
  sceneBreakAt?: number
): SpliceResult {
  return {
    next,
    firstNewParagraph: paragraphNumberAt(next, blockStart),
    paragraphsAdded: splitParagraphs(block).length,
    ...(sceneBreakAt !== undefined
      ? { sceneBreakParagraph: paragraphNumberAt(next, sceneBreakAt) }
      : {}),
    wordCountBefore: countWords(content),
    wordCountAfter: countWords(next),
  };
}

/**
 * `addition` at the end of `content`, after a blank line — or after a scene
 * break when `sceneBreak` is set and there is prose for it to separate from.
 */
export function appendParagraphs(
  content: string,
  addition: string,
  options: { sceneBreak?: boolean } = {}
): SpliceResult & { sceneBreakSkipped?: string } {
  const current = toNFC(content);
  const block = normaliseAddition(addition);

  if (options.sceneBreak && hasProse(current)) {
    const marker = sceneBreakMarker(current);
    const { next, blockStart } = spliceAt(current, current.length, `${marker}\n\n${block}`);
    return finish(current, next, blockStart + marker.length + 2, block, blockStart);
  }

  const { next, blockStart } = spliceAt(current, current.length, block);
  return {
    ...finish(current, next, blockStart, block),
    ...(options.sceneBreak
      ? {
          sceneBreakSkipped:
            "The chapter has no prose yet, so there was no scene to separate from; the text was added without a scene break.",
        }
      : {}),
  };
}

export type InsertPosition = { afterParagraph: number } | { beforeParagraph: number };

/**
 * `addition` as new paragraphs next to an existing one, numbered 1-based the
 * way book_chapter_find and book_chapter_read number them.
 */
export function insertParagraphs(
  content: string,
  addition: string,
  where: InsertPosition
): SpliceResult & { anchorParagraph: number; totalParagraphsBefore: number } {
  const current = toNFC(content);
  const block = normaliseAddition(addition);
  const paragraphs = splitParagraphs(current);
  const total = paragraphs.length;

  const after = "afterParagraph" in where;
  const anchor = after
    ? (where as { afterParagraph: number }).afterParagraph
    : (where as { beforeParagraph: number }).beforeParagraph;
  const name = after ? "afterParagraph" : "beforeParagraph";

  if (!Number.isInteger(anchor)) {
    throw new BookMCPError(`${name} must be a whole number.`);
  }
  if (anchor < 1) {
    throw new BookMCPError(`Paragraph numbers start at 1, so ${name}=${anchor} does not exist.`);
  }
  if (anchor > total) {
    throw new BookMCPError(
      `The chapter has ${total} paragraph(s), so paragraph ${anchor} does not exist. Nothing was written. To add at the end, use book_chapter_append.`
    );
  }

  const paragraph = paragraphs[anchor - 1];
  const pos = after ? paragraph.end : paragraph.start;
  const { next, blockStart } = spliceAt(current, pos, block);

  return {
    ...finish(current, next, blockStart, block),
    anchorParagraph: anchor,
    totalParagraphsBefore: total,
  };
}
