import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readChapterFile, updateRegistry } from "../storage/filestore";
import { saveChapterContent } from "../storage/writing-log";
import { snapshotIfChanged } from "../storage/history";
import { ChapterMeta } from "../storage/schema";
import { BookMCPError } from "../utils/errors";
import { toNFC } from "../utils/text";
import { condense, MAX_SNIPPET_MATCH, Snippet, snippetAt } from "../utils/match";
import { countWords } from "../utils/wordcount";
import { requireProject, resolveChapter } from "./manuscript";

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

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
      chapterId: z
        .string()
        .describe('Chapter ID (e.g. "ch-001") or chapter title'),
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
    "Replace one passage inside a chapter, leaving the rest untouched. Use this instead of book_chapter_update for a small edit: that tool replaces the whole chapter, so a partial text passed to it deletes everything else. The previous version is filed in the chapter history first, so book_chapter_revert can undo it.",
    {
      chapterId: z
        .string()
        .describe('Chapter ID (e.g. "ch-001") or chapter title'),
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
      dryRun: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Report what would change and write nothing (default: false)"
        ),
    },
    async ({ chapterId, oldText, newText, replaceAll, dryRun }) => {
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

        return jsonResult({
          dryRun: true,
          chapterId: chapter.id,
          matches: offsets.length,
          wouldReplace: replaceAll ? offsets.length : offsets.length === 1 ? 1 : 0,
          wouldSucceed: replaceAll ? offsets.length > 0 : offsets.length === 1,
          ...describeOutcome(offsets.length, replaceAll, chapter),
          replacement: condense(replacement, MAX_SNIPPET_MATCH),
          ...snippetsFor(content, offsets, needle.length),
        });
      }

      let chapter!: ChapterMeta;
      let snapshotTimestamp: string | null = null;
      let matches = 0;
      let wordCountBefore = 0;
      let wordCountAfter = 0;
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
        if (!replaceAll && offsets.length !== 1) {
          throw new BookMCPError(refusal(offsets.length, chapter));
        }
        if (replaceAll && offsets.length === 0) {
          throw new BookMCPError(refusal(0, chapter));
        }

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
        snippets = snippetsFor(next, newOffsets, replacement.length);
      });

      return jsonResult({
        message: `Replaced ${matches === 1 ? "1 occurrence" : `${matches} occurrences`} in "${chapter.title}".`,
        chapterId: chapter.id,
        matches,
        replaced: replaceAll ? matches : 1,
        wordCountBefore,
        wordCountAfter,
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
}

/** Why a replacement was refused, always naming the number of matches. */
function refusal(matches: number, chapter: ChapterMeta): string {
  if (matches === 0) {
    return `Found 0 occurrences of that text in chapter "${chapter.id}" ("${chapter.title}"). Nothing was written. The match is exact, so check punctuation, capitalisation and line breaks — book_chapter_find will show you what is actually there.`;
  }
  return `Found ${matches} occurrences of that text in chapter "${chapter.id}" ("${chapter.title}"), but without replaceAll it has to occur exactly once. Nothing was written. Pass a longer oldText that appears only once, or set replaceAll=true to replace all ${matches}.`;
}

function describeOutcome(
  matches: number,
  replaceAll: boolean,
  chapter: ChapterMeta
): Record<string, string> {
  const wouldFail = replaceAll ? matches === 0 : matches !== 1;
  return wouldFail ? { wouldFailWith: refusal(matches, chapter) } : {};
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
