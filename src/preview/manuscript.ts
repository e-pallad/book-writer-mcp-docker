// Compiling chapters into one manuscript. Lives apart from the tool module so
// the bundled preview server can use it without pulling in the MCP server and
// its zod schemas.

import { getRegistry, readChapterFile } from "../storage/filestore";
import { BookMCPError } from "../utils/errors";
import { countWords } from "../utils/wordcount";

export interface CompileOptions {
  /**
   * Include every chapter regardless of status. The live preview wants this —
   * an author watching the page while drafting wants to see the draft — while
   * an export wants only what is ready for readers.
   */
  includeAll?: boolean;
}

export function filterChapters(
  registry: NonNullable<ReturnType<typeof getRegistry>>,
  chapterIds?: string[],
  options: CompileOptions = {}
): { chapters: typeof registry.chapters; warnings: string[] } {
  const warnings: string[] = [];
  let chapters = registry.chapters.sort((a, b) => a.order - b.order);

  if (chapterIds) {
    const unknownIds = chapterIds.filter(
      (id) => !registry.chapters.some((c) => c.id === id)
    );
    if (unknownIds.length > 0) {
      throw new BookMCPError(
        `Unknown chapter IDs: ${unknownIds.join(", ")}. ` +
        `Available: ${registry.chapters.map((c) => c.id).join(", ")}`
      );
    }
    chapters = chapters.filter((c) => chapterIds.includes(c.id));
  } else if (!options.includeAll) {
    const filtered = chapters.filter(
      (c) => c.status === "final" || c.status === "review"
    );
    chapters = filtered.length > 0 ? filtered : chapters;
  }

  return { chapters, warnings };
}

export function compileManuscript(
  registry: NonNullable<ReturnType<typeof getRegistry>>,
  chapterIds?: string[],
  options: CompileOptions = {}
): { markdown: string; wordCount: number; chapterCount: number; warnings: string[] } {
  const { chapters, warnings } = filterChapters(registry, chapterIds, options);

  let markdown = `# ${registry.title}\n\n`;
  markdown += `**By ${registry.author}**\n\n`;
  markdown += `*${registry.genre}*\n\n---\n\n`;

  for (const chapter of chapters) {
    const content = readChapterFile(chapter.filename);
    if (!content) {
      warnings.push(`Chapter "${chapter.title}" (${chapter.filename}) is missing or empty on disk.`);
      continue;
    }
    markdown += content;
    markdown += "\n\n---\n\n";
  }

  return {
    markdown,
    wordCount: countWords(markdown),
    chapterCount: chapters.length,
    warnings,
  };
}
