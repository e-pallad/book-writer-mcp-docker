// Which chapters an export contains. Markdown, DOCX, EPUB and the preview all
// ask the same question, and used to answer it three different ways: the DOCX
// export took drafts that the others left out, and only the EPUB export
// rejected an unknown chapter id instead of silently dropping it.

import { ChapterMeta, Registry } from "../storage/schema";
import { chaptersInOrder, resolveChapter } from "../storage/chapters";
import { BookMCPError } from "../utils/errors";

export interface SelectOptions {
  /**
   * Every chapter regardless of status. The live preview wants this — someone
   * watching the page while drafting wants to see the draft — while an export
   * wants only what is ready for readers.
   */
  includeAll?: boolean;
}

/**
 * An explicit list (ids or titles) when one is given, otherwise every chapter
 * marked review or final, otherwise — when nothing is marked ready yet —
 * every chapter there is. Always in reading order.
 */
export function selectChapters(
  registry: Registry,
  refs?: string[],
  options: SelectOptions = {}
): ChapterMeta[] {
  const ordered = chaptersInOrder(registry);

  if (refs && refs.length > 0) {
    const unknown: string[] = [];
    const wanted = new Set<string>();
    for (const ref of refs) {
      try {
        wanted.add(resolveChapter(registry, ref).id);
      } catch {
        unknown.push(ref);
      }
    }
    if (unknown.length > 0) {
      throw new BookMCPError(
        `Unknown chapter IDs or titles: ${unknown.join(", ")}. Available: ${
          ordered.map((c) => `${c.id} ("${c.title}")`).join(", ") || "none"
        }`
      );
    }
    return ordered.filter((c) => wanted.has(c.id));
  }

  if (options.includeAll) return ordered;

  const ready = ordered.filter((c) => c.status === "final" || c.status === "review");
  return ready.length > 0 ? ready : ordered;
}

/** How the default selection was made, for the export's reply. */
export function describeSelection(
  registry: Registry,
  refs: string[] | undefined,
  selected: ChapterMeta[]
): string {
  if (refs && refs.length > 0) return "the chapters you listed";
  const ready = registry.chapters.filter(
    (c) => c.status === "final" || c.status === "review"
  ).length;
  if (ready === 0) {
    return "every chapter, because none is marked review or final yet";
  }
  const left = registry.chapters.length - selected.length;
  return left > 0
    ? `chapters marked review or final (${left} outline/draft chapter(s) left out)`
    : "chapters marked review or final";
}
