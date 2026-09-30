// The outline is the plan; the registry is what was written. Classically the
// two drift apart — chapters are split, merged, moved, dropped — and the
// question "what did I plan, what did I write, what changed" is asked at every
// revision. These helpers tie plan entries to chapters and compare the two.

import { ChapterMeta, Outline, OutlineChapter, Registry } from "../storage/schema";
import { foldUmlauts, normalizeForCompare } from "../utils/text";
import { chaptersInOrder } from "../storage/chapters";
import { BookMCPError } from "../utils/errors";

/**
 * Whether a plan entry stands for a chapter: its link when it has one, its
 * title when it has none. A linked entry never matches another chapter by
 * title — that is the point of linking.
 */
export function entryMatches(entry: OutlineChapter, chapter: ChapterMeta): boolean {
  if (entry.chapterId) return entry.chapterId === chapter.id;
  return normalizeForCompare(entry.title) === normalizeForCompare(chapter.title);
}

export function entries(outline: Outline): { act?: string; entry: OutlineChapter; position: number }[] {
  let position = 0;
  return outline.acts.flatMap((act) =>
    act.chapters.map((entry) => ({ act: act.act, entry, position: ++position }))
  );
}

/**
 * The entry an author names by its title: the title as written (case and
 * Unicode composition aside), else with umlauts and their two-letter
 * spellings treated alike ("Bruecke" for "Brücke") — as chapter titles are
 * resolved. Undefined when nothing matches; refused when the folded title
 * fits several entries.
 */
export function entryByTitle<T extends { entry: OutlineChapter }>(
  candidates: T[],
  title: string
): T | undefined {
  const wanted = title.trim();
  const exact = candidates.find(({ entry }) => normalizeForCompare(entry.title) === normalizeForCompare(wanted));
  if (exact) return exact;
  const folded = candidates.filter(({ entry }) => foldUmlauts(entry.title) === foldUmlauts(wanted));
  if (folded.length > 1) {
    throw new BookMCPError(
      `"${title}" could be any of several outline entries once umlauts and their spellings (ue/ae/oe/ss) are treated alike: ${folded
        .map(({ entry }) => `"${entry.title}"`)
        .join(", ")}. Use the exact title.`
    );
  }
  return folded[0];
}

/** The chapter a plan entry stands for, if any. */
export function chapterFor(entry: OutlineChapter, registry: Registry): ChapterMeta | undefined {
  const matches = registry.chapters.filter((c) => entryMatches(entry, c));
  return matches.length === 1 ? matches[0] : undefined;
}

export interface LinkReport {
  linked: { title: string; chapterId: string }[];
  alreadyLinked: number;
  /** Titles more than one chapter carries, left for the author to decide. */
  ambiguous: { title: string; chapters: string[] }[];
  unmatched: string[];
}

/** Links every unlinked entry whose title belongs to exactly one unclaimed chapter. */
export function autoLink(outline: Outline, registry: Registry): LinkReport {
  const report: LinkReport = { linked: [], alreadyLinked: 0, ambiguous: [], unmatched: [] };
  const all = entries(outline);
  const claimed = new Set(all.map((e) => e.entry.chapterId).filter(Boolean) as string[]);

  for (const { entry } of all) {
    if (entry.chapterId) {
      report.alreadyLinked++;
      continue;
    }
    const candidates = registry.chapters.filter(
      (c) => !claimed.has(c.id) && normalizeForCompare(c.title) === normalizeForCompare(entry.title)
    );
    if (candidates.length === 1) {
      entry.chapterId = candidates[0].id;
      claimed.add(candidates[0].id);
      report.linked.push({ title: entry.title, chapterId: candidates[0].id });
    } else if (candidates.length > 1) {
      report.ambiguous.push({ title: entry.title, chapters: candidates.map((c) => c.id) });
    } else {
      report.unmatched.push(entry.title);
    }
  }
  return report;
}

export interface Comparison {
  planned: number;
  written: number;
  /** Plan entries no chapter has been written for yet. */
  notWritten: { act?: string; title: string }[];
  /** Chapters the plan does not mention. */
  notPlanned: { chapterId: string; title: string }[];
  /** Chapters whose place in the book differs from their place in the plan. */
  moved: { chapterId: string; title: string; plannedPosition: number; actualPosition: number }[];
  /** Where plan and chapter describe the chapter differently. */
  synopses: { chapterId: string; title: string; planned: string; written: string }[];
  /** Plan entries now titled differently from their chapter. */
  retitled: { chapterId: string; planned: string; written: string }[];
}

export function compareOutline(outline: Outline, registry: Registry): Comparison {
  const all = entries(outline);
  const ordered = chaptersInOrder(registry);
  const matchedIds = new Set<string>();
  const pairs: { entry: OutlineChapter; chapter: ChapterMeta; position: number }[] = [];
  const notWritten: Comparison["notWritten"] = [];

  for (const { act, entry, position } of all) {
    const chapter = chapterFor(entry, registry);
    if (chapter && !matchedIds.has(chapter.id)) {
      matchedIds.add(chapter.id);
      pairs.push({ entry, chapter, position });
    } else {
      notWritten.push({ ...(act ? { act } : {}), title: entry.title });
    }
  }

  // Positions among the chapters both sides know, so a missing chapter does
  // not make every later one look moved.
  const planOrder = pairs.map((p) => p.chapter.id);
  const bookOrder = ordered.filter((c) => matchedIds.has(c.id)).map((c) => c.id);
  const moved = pairs
    .map((p, index) => ({
      chapterId: p.chapter.id,
      title: p.chapter.title,
      plannedPosition: index + 1,
      actualPosition: bookOrder.indexOf(p.chapter.id) + 1,
    }))
    .filter((m) => m.plannedPosition !== m.actualPosition);

  const synopses = pairs
    .filter(
      (p) =>
        p.entry.synopsis.trim() &&
        p.chapter.synopsis.trim() &&
        normalizeForCompare(p.entry.synopsis.trim()) !== normalizeForCompare(p.chapter.synopsis.trim())
    )
    .map((p) => ({
      chapterId: p.chapter.id,
      title: p.chapter.title,
      planned: p.entry.synopsis,
      written: p.chapter.synopsis,
    }));

  const retitled = pairs
    .filter((p) => normalizeForCompare(p.entry.title) !== normalizeForCompare(p.chapter.title))
    .map((p) => ({ chapterId: p.chapter.id, planned: p.entry.title, written: p.chapter.title }));

  return {
    planned: all.length,
    written: ordered.length,
    notWritten,
    notPlanned: ordered
      .filter((c) => !matchedIds.has(c.id))
      .map((c) => ({ chapterId: c.id, title: c.title })),
    moved: planOrder.length > 1 ? moved : [],
    synopses,
    retitled,
  };
}
