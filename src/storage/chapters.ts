// Looking chapters up. Shared by every tool that takes a chapter, and by the
// exporters, so "which chapter did you mean" has one answer everywhere.

import { getRegistry } from "./filestore";
import { ChapterMeta, Registry } from "./schema";
import { BookMCPError } from "../utils/errors";
import { normalizeForCompare } from "../utils/text";

// Chapters are addressed by id ("ch-002") everywhere, but an author thinks in
// titles. Every chapter tool accepts either, so "rename 'Der Anfang'" works
// without looking the id up first.
export function resolveChapter(registry: Registry, ref: string): ChapterMeta {
  const byId = registry.chapters.find((c) => c.id === ref);
  if (byId) return byId;

  const matches = registry.chapters.filter(
    (c) => normalizeForCompare(c.title) === normalizeForCompare(ref)
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new BookMCPError(
      `Several chapters are titled "${ref}": ${matches
        .map((c) => c.id)
        .join(", ")}. Use the chapter id instead.`
    );
  }

  throw new BookMCPError(
    `Chapter "${ref}" not found. Known chapters: ${
      registry.chapters.map((c) => `${c.id} ("${c.title}")`).join(", ") || "none"
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
