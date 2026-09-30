// Page by page through the chapter list and the outline. A novel of forty
// chapters with synopses fills a reply before anything else has been read;
// act/fromChapter/limit fetch the part that matters now, and the reply says
// where the next page starts.
//
// Chapters are numbered as "#N" numbers them: the chapter list by reading
// order, the outline by its entries from the first act on. A page continues
// with fromChapter=<nextFromChapter>, with the same act and limit.

import { z } from "zod";
import { getOutline } from "../storage/filestore";
import { chaptersInOrder, resolveChapter } from "../storage/chapters";
import { ChapterMeta, Outline, Registry } from "../storage/schema";
import { chapterFor } from "../outline/link";
import { BookMCPError } from "../utils/errors";
import { foldUmlauts, normalizeForCompare } from "../utils/text";

export const actSchema = z
  .union([z.number(), z.string()])
  .optional()
  .describe(
    "Only the chapters of this act of the outline: its number (1 for the first) or its name"
  );

export const limitSchema = z
  .number()
  .optional()
  .describe(
    "At most this many chapters; the reply's page.nextFromChapter says where the next page starts (default: all)"
  );

export interface Page {
  /** Chapters in the selection (the act, or all), before fromChapter and limit. */
  total: number;
  returned: number;
  /** Pass as fromChapter for the next page; absent on the last page. */
  nextFromChapter?: number;
  act?: { number: number; name?: string };
}

export interface PagingInput {
  act?: number | string;
  fromChapter?: number | string;
  limit?: number;
}

export function wantsPage(input: PagingInput): boolean {
  return input.act !== undefined || input.fromChapter !== undefined || input.limit !== undefined;
}

const NUMBER = /^#?\s*(\d+)$/;

function wholeNumber(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new BookMCPError(`${name} must be a whole number from 1 up; got ${value}.`);
  }
  return value;
}

/** "3", "#3" or 3 as a number; undefined for anything else. */
function asNumber(ref: number | string): number | undefined {
  if (typeof ref === "number") return ref;
  const match = NUMBER.exec(ref.trim());
  return match ? parseInt(match[1], 10) : undefined;
}

/** The index into outline.acts of an act named by number or name. */
export function resolveAct(outline: Outline, ref: number | string): number {
  const acts = outline.acts;
  const known = () =>
    acts.map((a, i) => (a.act ? `${i + 1} ("${a.act}")` : `${i + 1}`)).join(", ") || "none";

  if (typeof ref === "string") {
    const wanted = ref.trim();
    // A name first, so an act called "2" is still found by its name.
    for (const same of [normalizeForCompare, foldUmlauts]) {
      const found = acts.flatMap((a, i) =>
        a.act !== undefined && same(a.act) === same(wanted) ? [i] : []
      );
      if (found.length === 1) return found[0];
      if (found.length > 1) {
        throw new BookMCPError(
          `Several acts are called "${ref}": ${found.map((i) => i + 1).join(", ")}. Pass the act's number instead.`
        );
      }
    }
  }

  const n = asNumber(ref);
  if (n !== undefined && Number.isInteger(n) && n >= 1 && n <= acts.length) return n - 1;
  throw new BookMCPError(`The outline has no act "${ref}". Acts: ${known()}.`);
}

/**
 * The page of `numbered` that starts at the first item numbered `from` or
 * later and holds at most `limit` items.
 */
export function paginate<T>(
  numbered: { number: number; item: T }[],
  from: number | undefined,
  limit: number | undefined
): { items: { number: number; item: T }[]; page: Page } {
  if (limit !== undefined) wholeNumber(limit, "limit");
  const start = from === undefined ? 0 : numbered.findIndex((n) => n.number >= from);
  const items =
    start === -1 ? [] : numbered.slice(start, limit === undefined ? undefined : start + limit);
  const next = start === -1 ? undefined : numbered[start + items.length];
  return {
    items,
    page: {
      total: numbered.length,
      returned: items.length,
      ...(next ? { nextFromChapter: next.number } : {}),
    },
  };
}

/** The reading-order position of the chapter a fromChapter names. */
function chapterPosition(registry: Registry, ordered: ChapterMeta[], ref: number | string): number {
  if (typeof ref === "number") {
    wholeNumber(ref, "fromChapter");
    if (ref > ordered.length) {
      throw new BookMCPError(
        `There is no chapter #${ref}: the book has ${ordered.length} chapter(s).`
      );
    }
    return ref;
  }
  // An id, a title or "#N", exactly as every chapter tool takes them; a bare
  // number sent as text is the position, unless a chapter carries it as title.
  try {
    return ordered.indexOf(resolveChapter(registry, ref)) + 1;
  } catch (error) {
    const n = asNumber(ref);
    if (n !== undefined) return chapterPosition(registry, ordered, n);
    throw error;
  }
}

/** book_chapter_list: the chapters in reading order, an act of them, a page of them. */
export function chapterPage(
  registry: Registry,
  input: PagingInput
): { chapters: ChapterMeta[]; page?: Page } {
  const ordered = chaptersInOrder(registry);
  const numbered = ordered.map((item, i) => ({ number: i + 1, item }));
  if (!wantsPage(input)) return { chapters: ordered };

  let selection = numbered;
  let act: Page["act"];
  if (input.act !== undefined) {
    const outline = getOutline();
    if (!outline || !outline.acts.length) {
      throw new BookMCPError(
        "The chapters are grouped into acts by the outline, and there is none yet. Set one with book_outline_set, or page without act."
      );
    }
    const index = resolveAct(outline, input.act);
    const inAct = new Set(
      outline.acts[index].chapters
        .map((entry) => chapterFor(entry, registry)?.id)
        .filter((id): id is string => Boolean(id))
    );
    selection = numbered.filter(({ item }) => inAct.has(item.id));
    act = { number: index + 1, ...(outline.acts[index].act ? { name: outline.acts[index].act } : {}) };
  }

  const from =
    input.fromChapter === undefined
      ? undefined
      : chapterPosition(registry, ordered, input.fromChapter);
  const { items, page } = paginate(selection, from, input.limit);
  return { chapters: items.map((n) => n.item), page: { ...page, ...(act ? { act } : {}) } };
}

/**
 * The outline entry number a fromChapter names: a number ("#N" too), an
 * entry's title, or a manuscript chapter an entry stands for.
 */
export function outlineEntryNumber(
  outline: Outline,
  registry: Registry | null,
  ref: number | string
): number {
  const numbered = outline.acts.flatMap((a) => a.chapters);
  const total = numbered.length;

  const n = asNumber(ref);
  if (n !== undefined) {
    wholeNumber(n, "fromChapter");
    if (n > total) {
      throw new BookMCPError(`The outline has ${total} chapter(s), so there is no chapter ${n}.`);
    }
    return n;
  }

  const wanted = String(ref).trim();
  for (const same of [normalizeForCompare, foldUmlauts]) {
    const found = numbered.flatMap((entry, i) => (same(entry.title) === same(wanted) ? [i + 1] : []));
    if (found.length === 1) return found[0];
    if (found.length > 1) {
      throw new BookMCPError(
        `Several outline chapters are titled "${ref}": numbers ${found.join(", ")}. Pass the number instead.`
      );
    }
  }

  if (registry) {
    let chapter: ChapterMeta | undefined;
    try {
      chapter = resolveChapter(registry, wanted);
    } catch {
      chapter = undefined;
    }
    const at = chapter ? numbered.findIndex((entry) => chapterFor(entry, registry)?.id === chapter!.id) : -1;
    if (at !== -1) return at + 1;
  }
  throw new BookMCPError(
    `No outline chapter is titled "${ref}" or stands for that manuscript chapter. Pass its number (book_outline_get numbers them).`
  );
}
