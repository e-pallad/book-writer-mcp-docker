// brief=true on every tool that writes. The full reply of a write echoes what
// was written — a chapter's whole record, a character, a plot thread — which
// is worth reading once and costs as much again on every later call. A brief
// reply is the id, the status and, for a chapter, the word count: enough to
// carry on with.
//
// Warnings are kept: they say something went differently than asked, and
// dropping them to save space would hide exactly what the caller must know.
// Dry runs ignore brief — the report is what a dry run is for.

import { z } from "zod";
import { ChapterMeta } from "../storage/schema";

export const briefSchema = z
  .boolean()
  .optional()
  .default(false)
  .describe(
    "Reply with only the id, status and word count of what was written instead of the whole object; warnings are still reported (default: false)"
  );

/** What a brief reply says about one thing that was written. */
export interface Brief {
  id: string;
  /**
   * Its own status where it has one (a chapter's, a plot thread's, a note's),
   * otherwise what happened to it: "created", "updated", "unchanged" or
   * "deleted".
   */
  status: string;
  /** A chapter's word count after the write. */
  wordCount?: number;
  /** book_chapter_append and book_chapter_insert: where the new text starts. */
  firstNewParagraph?: number;
}

/** A write that touches several chapters reports each of them. */
export type BriefSummary = Brief | { chapters: Brief[] } | (Brief & { chapters: Brief[] });

export function chapterBrief(chapter: ChapterMeta): Brief {
  return { id: chapter.id, status: chapter.status, wordCount: chapter.wordCount };
}

/**
 * The reply of a write tool: `full` as it has always been, or with brief=true
 * only `summary` plus the warnings — those `full` carries under `warnings`,
 * and any passed in `warnings` for replies that report them under another
 * name.
 */
export function writeReply(
  brief: boolean,
  full: Record<string, unknown>,
  summary: BriefSummary,
  warnings: string[] = []
) {
  const payload = brief ? withWarnings(summary, full, warnings) : full;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function withWarnings(
  summary: BriefSummary,
  full: Record<string, unknown>,
  extra: string[]
): Record<string, unknown> {
  const carried = Array.isArray(full.warnings)
    ? full.warnings.filter((w): w is string => typeof w === "string")
    : [];
  const warnings = [...carried, ...extra];
  return warnings.length ? { ...summary, warnings } : { ...summary };
}
