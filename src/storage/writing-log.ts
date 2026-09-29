// The writing log: how many words went in and came out, per day. Classic
// drafting runs on a daily quota and a deadline; this is what lets the tools
// answer "how much did I write today" and "will I make it" from a record
// rather than from reconstructed guesses.

import { getWritingLog, readChapterFile, saveWritingLog, writeChapterFile } from "./filestore";
import { ChapterMeta, Registry, WritingDay, WritingLog } from "./schema";
import { countWords } from "../utils/wordcount";

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The calendar day an instant falls on in a time zone, as YYYY-MM-DD. */
export function dayKey(date: Date, timeZone = "UTC"): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: isValidTimeZone(timeZone) ? timeZone : "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** The time zone a project's days are counted in. */
export function projectTimeZone(registry: Registry): string {
  const configured = registry.timezone ?? process.env.BOOK_TIMEZONE ?? "UTC";
  return isValidTimeZone(configured) ? configured : "UTC";
}

/**
 * Adds one change to the log. Must run with registry.json held — see
 * getWritingLog in filestore.ts for why that is the log's lock.
 */
export function recordWords(
  registry: Registry,
  chapterId: string,
  before: number,
  after: number,
  now = new Date()
): void {
  const delta = after - before;
  if (delta === 0) return;

  const log: WritingLog = getWritingLog() ?? { startedAt: now.toISOString(), days: {} };
  const key = dayKey(now, projectTimeZone(registry));
  const day: WritingDay = (log.days[key] ??= { added: 0, removed: 0, chapters: {}, changes: 0 });

  if (delta > 0) day.added += delta;
  else day.removed += -delta;
  day.chapters[chapterId] = (day.chapters[chapterId] ?? 0) + delta;
  day.changes += 1;

  saveWritingLog(log);
}

/**
 * The one way chapter text is written. Writes the file, keeps the registry's
 * word count and timestamp in step, and logs the change — so no tool can
 * change prose without it showing up in the day's tally. Call it inside a
 * registry transaction.
 */
export function saveChapterContent(
  registry: Registry,
  chapter: ChapterMeta,
  content: string,
  now = new Date()
): { before: number; after: number } {
  const before = countWords(readChapterFile(chapter.filename));
  writeChapterFile(chapter.filename, content);
  const after = countWords(content);
  chapter.wordCount = after;
  chapter.updatedAt = now.toISOString();
  recordWords(registry, chapter.id, before, after, now);
  return { before, after };
}
