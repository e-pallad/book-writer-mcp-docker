// Looking chapters up. Shared by every tool that takes a chapter, and by the
// exporters, so "which chapter did you mean" has one answer everywhere.

import { getRegistry } from "./filestore";
import { ChapterMeta, Registry } from "./schema";
import { BookMCPError } from "../utils/errors";
import { foldUmlauts, normalizeForCompare } from "../utils/text";

// "#8", "# 8": the eighth chapter in reading order. Ids are handed out in
// creation order and never renumbered, so after a reorder "ch-011" can be the
// eighth chapter — and "the eighth chapter" is how an author refers to it.
const POSITION = /^#\s*(\d+)$/;

/** How a chapter is named in an error: id, title and position. */
function describe(chapter: ChapterMeta, ordered: ChapterMeta[]): string {
  return `${chapter.id} ("${chapter.title}", #${ordered.indexOf(chapter) + 1})`;
}

// Chapters are addressed by id ("ch-002") everywhere, but an author thinks in
// titles or positions. Every chapter tool accepts any of them, so "rename 'Der
// Anfang'" or "append to #8" works without looking the id up first.
//
// In order: the id; the title exactly (case and Unicode composition aside);
// the position; the title with umlauts and their two-letter spellings treated
// alike ("Ueber" for "Über", "Strasse" for "Straße"). An exact title always
// wins over a folded one, so a chapter that answered to a name before still
// does.
export function resolveChapter(registry: Registry, ref: string): ChapterMeta {
  const byId = registry.chapters.find((c) => c.id === ref);
  if (byId) return byId;

  const ordered = chaptersInOrder(registry);
  const wanted = ref.trim();

  const exact = registry.chapters.filter(
    (c) => normalizeForCompare(c.title) === normalizeForCompare(wanted)
  );
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new BookMCPError(
      `Several chapters are titled "${ref}": ${exact
        .map((c) => describe(c, ordered))
        .join(", ")}. Use the chapter id or "#N" instead.`
    );
  }

  const position = POSITION.exec(wanted);
  if (position) {
    const n = parseInt(position[1], 10);
    if (n >= 1 && n <= ordered.length) return ordered[n - 1];
    throw new BookMCPError(
      ordered.length
        ? `There is no chapter #${n}: the book has ${ordered.length} chapter(s), #1 to #${ordered.length}.`
        : `There is no chapter #${n}: the book has no chapters yet.`
    );
  }

  const folded = registry.chapters.filter(
    (c) => foldUmlauts(c.title) === foldUmlauts(wanted)
  );
  if (folded.length === 1) return folded[0];
  if (folded.length > 1) {
    throw new BookMCPError(
      `"${ref}" could be any of several chapters once umlauts and their spellings (ue/ae/oe/ss) are treated alike: ${folded
        .map((c) => describe(c, ordered))
        .join(", ")}. Use the chapter id or "#N" instead.`
    );
  }

  throw new BookMCPError(
    `Chapter "${ref}" not found. Known chapters: ${
      ordered.map((c) => describe(c, ordered)).join(", ") || "none"
    }`
  );
}

export function requireProject(): Registry {
  const registry = getRegistry();
  if (!registry)
    throw new BookMCPError("No book project found. Run book_init first.");
  return registry;
}

/** Chapters in reading order, as a copy — sorting the registry's own array in
 * place used to reorder it under any caller that still held it. */
export function chaptersInOrder(registry: Registry): ChapterMeta[] {
  return [...registry.chapters].sort((a, b) => a.order - b.order);
}
