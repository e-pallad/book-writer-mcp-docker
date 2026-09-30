import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readChapterFile, updateRegistry } from "../storage/filestore";
import { saveChapterContent } from "../storage/writing-log";
import { saveSnapshot, snapshotIfChanged } from "../storage/history";
import { ChapterMeta } from "../storage/schema";
import { BookMCPError } from "../utils/errors";
import { paragraphNumbersAt, splitParagraphs, toNFC } from "../utils/text";
import { condense, MAX_SNIPPET_MATCH, Snippet, snippetAt } from "../utils/match";
import {
  appendParagraphs,
  insertParagraphs,
  InsertPosition,
  SpliceResult,
} from "../utils/splice-paragraphs";
import { countWords } from "../utils/wordcount";
import { requireProject, resolveChapter } from "./manuscript";

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

const chapterIdSchema = z
  .string()
  .describe(
    'Chapter ID (e.g. "ch-001"), chapter title, or "#N" for the Nth chapter in reading order'
  );

const dryRunSchema = z
  .boolean()
  .optional()
  .default(false)
  .describe("Report what would change and write nothing (default: false)");

const MAX_REPORTED_SNIPPETS = 3;

/**
 * Every position where `needle` occurs in `haystack`, exactly and
 * character-for-character.
 *
 * Non-overlapping, the way a replace behaves: "aa" occurs once in "aaa", not
 * twice. Counting overlaps would report a number that no replacement could
 * then act on.
 */
function findOccurrences(haystack: string, needle: string): number[] {
  const offsets: number[] = [];
  let from = 0;

  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    offsets.push(at);
    from = at + needle.length;
  }

  return offsets;
}

/**
 * Splices `replacement` in at each offset.
 *
 * Built by hand rather than with String.replace, which reads "$&", "$1" and
 * friends in the replacement as patterns — prose containing a stray "$&" would
 * otherwise come back mangled.
 */
function spliceAll(
  content: string,
  offsets: number[],
  matchLength: number,
  replacement: string
): string {
  let result = "";
  let cursor = 0;

  for (const at of offsets) {
    result += content.slice(cursor, at) + replacement;
    cursor = at + matchLength;
  }

  return result + content.slice(cursor);
}

export function registerChapterEditTools(server: McpServer): void {
  // book_chapter_find
  server.tool(
    "book_chapter_find",
    "Find every occurrence of a piece of text in a chapter, with its paragraph number and surrounding context, without loading the whole chapter. Use it to locate a passage before changing it with book_chapter_replace_text.",
    {
      chapterId: chapterIdSchema,
      query: z
        .string()
        .describe(
          "Text to look for. Matched exactly and character-for-character — no wildcards, no regular expressions."
        ),
      contextChars: z
        .number()
        .optional()
        .default(80)
        .describe("Characters of context to show either side of a match (default: 80)"),
    },
    async ({ chapterId, query, contextChars }) => {
      const registry = requireProject();
      const chapter = resolveChapter(registry, chapterId);

      if (query === "") {
        throw new BookMCPError("A search query cannot be empty.");
      }

      // Both sides folded to NFC: an "ö" typed on macOS is two code points and
      // would otherwise never match the single code point stored on disk.
      const content = toNFC(readChapterFile(chapter.filename));
      const needle = toNFC(query);
      const offsets = findOccurrences(content, needle);

      return jsonResult({
        chapterId: chapter.id,
        title: chapter.title,
        matches: offsets.length,
        occurrences: offsets.map((at) =>
          snippetAt(content, at, needle.length, contextChars)
        ),
        ...(offsets.length === 0
          ? {
              hint: "Nothing matched. The search is exact, so check punctuation, capitalisation and line breaks.",
            }
          : {}),
      });
    }
  );

  // book_chapter_replace_text
  server.tool(
    "book_chapter_replace_text",
    "Replace one passage inside a chapter, leaving the rest untouched. Use this instead of book_chapter_update for a small edit: that tool replaces the whole chapter, so a partial text passed to it deletes everything else. The previous version is filed in the chapter history first, so book_chapter_revert can undo it. Replies with counts and paragraph numbers, never the chapter text.",
    {
      chapterId: chapterIdSchema,
      oldText: z
        .string()
        .describe(
          "The exact text to replace, character-for-character including punctuation and line breaks. Unless replaceAll is set it must occur exactly once."
        ),
      newText: z
        .string()
        .describe("What to put in its place. Pass an empty string to delete the passage."),
      replaceAll: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Replace every occurrence instead of requiring exactly one (default: false)"
        ),
      expectedCount: z
        .number()
        .optional()
        .describe(
          "The number of occurrences you expect — from a dry run or book_chapter_find. If the chapter no longer has exactly that many, nothing is written."
        ),
      dryRun: dryRunSchema,
    },
    async ({ chapterId, oldText, newText, replaceAll, expectedCount, dryRun }) => {
      if (oldText === "") {
        throw new BookMCPError(
          "oldText cannot be empty — there would be nothing to find."
        );
      }

      const needle = toNFC(oldText);
      const replacement = toNFC(newText);

      // A dry run only reads, and reads need no lock.
      if (dryRun) {
        const registry = requireProject();
        const chapter = resolveChapter(registry, chapterId);
        const content = toNFC(readChapterFile(chapter.filename));
        const offsets = findOccurrences(content, needle);
        const refused = refusal(offsets.length, replaceAll, expectedCount, chapter);

        return jsonResult({
          dryRun: true,
          chapterId: chapter.id,
          matches: offsets.length,
          wouldReplace: refused ? 0 : replaceAll ? offsets.length : 1,
          wouldSucceed: !refused,
          ...(refused ? { wouldFailWith: refused } : {}),
          paragraphs: uniqueParagraphs(content, offsets),
          replacement: condense(replacement, MAX_SNIPPET_MATCH),
          ...snippetsFor(content, offsets, needle.length),
          ...(!refused && expectedCount === undefined
            ? {
                next: `Run again with dryRun=false${replaceAll ? " and replaceAll=true" : ""} and expectedCount=${offsets.length} to apply exactly this.`,
              }
            : {}),
        });
      }

      let chapter!: ChapterMeta;
      let snapshotTimestamp: string | null = null;
      let matches = 0;
      let wordCountBefore = 0;
      let wordCountAfter = 0;
      let paragraphs: number[] = [];
      let snippets: ReturnType<typeof snippetsFor> = { snippets: [] };

      // The whole read-modify-write runs under the same lock book_chapter_update
      // uses, so a concurrent call cannot read the text between our read and
      // our write and overwrite the change.
      await updateRegistry(async (registry) => {
        chapter = resolveChapter(registry, chapterId);

        const content = toNFC(readChapterFile(chapter.filename));
        const offsets = findOccurrences(content, needle);
        matches = offsets.length;

        // Throwing here aborts the transaction: the registry is not saved and
        // the chapter file has not been touched.
        const refused = refusal(offsets.length, replaceAll, expectedCount, chapter);
        if (refused) throw new BookMCPError(refused);

        const applied = replaceAll ? offsets : [offsets[0]];
        const next = spliceAll(content, applied, needle.length, replacement);

        wordCountBefore = countWords(content);
        wordCountAfter = countWords(next);

        // Snapshot before the write, exactly as book_chapter_update does, so
        // book_chapter_revert restores the text as it was.
        snapshotTimestamp = snapshotIfChanged(chapter.id, chapter.filename, next);

        saveChapterContent(registry, chapter, next);

        // Taken against the new text, so the offsets point at the replacement.
        const newOffsets: number[] = [];
        let shift = 0;
        for (const at of applied) {
          newOffsets.push(at + shift);
          shift += replacement.length - needle.length;
        }
        paragraphs = uniqueParagraphs(next, newOffsets);
        snippets = snippetsFor(next, newOffsets, replacement.length);
      });

      return jsonResult({
        message: `Replaced ${matches === 1 ? "1 occurrence" : `${matches} occurrences`} in "${chapter.title}".`,
        chapterId: chapter.id,
        matches,
        replaced: replaceAll ? matches : 1,
        wordCountBefore,
        wordCountAfter,
        // Where the changes now are, in the text as it stands after the edit.
        paragraphs,
        ...(snapshotTimestamp
          ? {
              previousVersionSaved: snapshotTimestamp,
              hint: "book_chapter_revert restores the text as it was before this edit.",
            }
          : {
              note: "The text was already identical, so no version was filed.",
            }),
        ...snippets,
      });
    }
  );

  // book_chapter_append
  server.tool(
    "book_chapter_append",
    "Add text to the end of a chapter without sending the chapter back: the existing text stays exactly as it is. Separated by a blank line, or by a scene break with sceneBreak=true. The previous version is filed in the chapter history first, so book_chapter_revert can undo it. Replies with word counts and paragraph numbers, never the chapter text.",
    {
      chapterId: chapterIdSchema,
      content: z
        .string()
        .describe(
          "The text to add — one or more paragraphs, separated by blank lines. Blank lines around it are dropped; exactly one separates it from the existing text."
        ),
      sceneBreak: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Put a scene break in front of the text instead of just a blank line — the one the chapter already uses, or "* * *" (default: false)'
        ),
      dryRun: dryRunSchema,
    },
    async ({ chapterId, content, sceneBreak, dryRun }) =>
      addParagraphs(chapterId, dryRun, (current) =>
        appendParagraphs(current, content, { sceneBreak })
      )
  );

  // book_chapter_insert
  server.tool(
    "book_chapter_insert",
    "Insert new paragraphs before or after an existing paragraph of a chapter, without sending the chapter back: the existing text stays exactly as it is. Paragraphs are numbered from 1 as book_chapter_find and book_chapter_read number them. The previous version is filed in the chapter history first, so book_chapter_revert can undo it. Replies with word counts and paragraph numbers, never the chapter text.",
    {
      chapterId: chapterIdSchema,
      content: z
        .string()
        .describe(
          "The text to insert — one or more paragraphs, separated by blank lines. It becomes paragraphs of its own; it is never merged into a neighbouring one."
        ),
      afterParagraph: z
        .number()
        .optional()
        .describe("Insert after this paragraph (1-based). Give this or beforeParagraph, not both."),
      beforeParagraph: z
        .number()
        .optional()
        .describe("Insert before this paragraph (1-based). Give this or afterParagraph, not both."),
      dryRun: dryRunSchema,
    },
    async ({ chapterId, content, afterParagraph, beforeParagraph, dryRun }) => {
      if ((afterParagraph === undefined) === (beforeParagraph === undefined)) {
        throw new BookMCPError(
          "Give exactly one of afterParagraph or beforeParagraph — book_chapter_find reports paragraph numbers."
        );
      }
      const where: InsertPosition =
        afterParagraph !== undefined
          ? { afterParagraph }
          : { beforeParagraph: beforeParagraph as number };

      return addParagraphs(chapterId, dryRun, (current) => {
        const result = insertParagraphs(current, content, where);
        return {
          ...result,
          extra: {
            [afterParagraph !== undefined ? "insertedAfterParagraph" : "insertedBeforeParagraph"]:
              result.anchorParagraph,
            // Enough of each neighbour to see the text landed where it was
            // meant to, without sending the chapter back.
            between: neighbours(
              result.next,
              result.firstNewParagraph,
              result.firstNewParagraph + result.paragraphsAdded - 1
            ),
          },
        };
      });
    }
  );
}

const NEIGHBOUR_CHARS = 60;

/** The end of the paragraph before `first` and the start of the one after `last`. */
function neighbours(
  content: string,
  first: number,
  last: number
): { before?: string; after?: string } {
  const paragraphs = splitParagraphs(content);
  const before = paragraphs[first - 2];
  const after = paragraphs[last];
  const tail = before ? condense(before.text).trim() : "";
  const head = after ? condense(after.text).trim() : "";
  return {
    ...(tail
      ? { before: tail.length > NEIGHBOUR_CHARS ? `…${tail.slice(-NEIGHBOUR_CHARS)}` : tail }
      : {}),
    ...(head
      ? { after: head.length > NEIGHBOUR_CHARS ? `${head.slice(0, NEIGHBOUR_CHARS)}…` : head }
      : {}),
  };
}

/**
 * The shared body of book_chapter_append and book_chapter_insert: work out
 * the new text, then either report it (dryRun) or file the old version and
 * write the new one under the registry lock.
 */
async function addParagraphs(
  chapterId: string,
  dryRun: boolean,
  compute: (current: string) => SpliceResult & {
    sceneBreakSkipped?: string;
    extra?: Record<string, unknown>;
  }
) {
  const summarise = (chapter: ChapterMeta, result: ReturnType<typeof compute>) => ({
    chapterId: chapter.id,
    wordCount: result.wordCountAfter,
    wordsAdded: result.wordCountAfter - result.wordCountBefore,
    firstNewParagraph: result.firstNewParagraph,
    paragraphsAdded: result.paragraphsAdded,
    ...(result.sceneBreakParagraph !== undefined
      ? { sceneBreakParagraph: result.sceneBreakParagraph }
      : {}),
    ...(result.extra ?? {}),
    ...(result.sceneBreakSkipped ? { note: result.sceneBreakSkipped } : {}),
  });

  // A dry run only reads, and reads need no lock.
  if (dryRun) {
    const registry = requireProject();
    const chapter = resolveChapter(registry, chapterId);
    const result = compute(readChapterFile(chapter.filename));
    return jsonResult({ dryRun: true, ...summarise(chapter, result) });
  }

  let chapter!: ChapterMeta;
  let result!: ReturnType<typeof compute>;
  let snapshotTimestamp!: string;

  // Read, splice and write under the lock book_chapter_update uses, so a
  // concurrent edit cannot land between the read and the write and be lost.
  await updateRegistry((registry) => {
    chapter = resolveChapter(registry, chapterId);
    const current = readChapterFile(chapter.filename);

    // Throws before anything is written when the input is unusable.
    result = compute(current);

    // Always filed, even for a chapter with no text yet: the added text never
    // leaves the chapter as it was, and an append or insert must always be
    // one book_chapter_revert away from undone.
    snapshotTimestamp = saveSnapshot(chapter.id, current);
    saveChapterContent(registry, chapter, result.next);
  });

  return jsonResult({
    message: `Added ${result.paragraphsAdded} paragraph(s) to "${chapter.title}", starting at paragraph ${result.firstNewParagraph}.`,
    ...summarise(chapter, result),
    previousVersionSaved: snapshotTimestamp,
    hint: "book_chapter_revert restores the text as it was before this edit.",
  });
}

/**
 * Why a replacement is refused, always naming the number of matches — or null
 * when it may go ahead. An expectedCount is checked first: it is the caller
 * saying what they looked at, and a chapter that no longer matches it has
 * changed since.
 */
function refusal(
  matches: number,
  replaceAll: boolean,
  expectedCount: number | undefined,
  chapter: ChapterMeta
): string | null {
  if (expectedCount !== undefined && expectedCount !== matches) {
    return `Expected ${expectedCount} occurrence(s) but found ${matches} in chapter "${chapter.id}" ("${chapter.title}"). Nothing was written. Look again with book_chapter_find or a dry run.`;
  }
  if (matches === 0) {
    return `Found 0 occurrences of that text in chapter "${chapter.id}" ("${chapter.title}"). Nothing was written. The match is exact, so check punctuation, capitalisation and line breaks — book_chapter_find will show you what is actually there.`;
  }
  if (!replaceAll && matches !== 1) {
    return `Found ${matches} occurrences of that text in chapter "${chapter.id}" ("${chapter.title}"), but without replaceAll it has to occur exactly once. Nothing was written. Pass a longer oldText that appears only once, or set replaceAll=true to replace all ${matches}.`;
  }
  return null;
}

/** Paragraph numbers of the given offsets, each listed once. */
function uniqueParagraphs(content: string, offsets: number[]): number[] {
  return [...new Set(paragraphNumbersAt(content, offsets))];
}

/**
 * Up to a few snippets, with a count of the rest.
 *
 * A replaceAll across forty occurrences would otherwise return forty excerpts
 * and cost more than reading the chapter would have.
 */
function snippetsFor(
  content: string,
  offsets: number[],
  length: number,
  contextChars = 80
): { snippets: Snippet[]; snippetsOmitted?: number } {
  const shown = offsets.slice(0, MAX_REPORTED_SNIPPETS);
  const omitted = offsets.length - shown.length;

  return {
    snippets: shown.map((at) => snippetAt(content, at, length, contextChars)),
    ...(omitted > 0 ? { snippetsOmitted: omitted } : {}),
  };
}
