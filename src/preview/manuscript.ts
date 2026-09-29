// Compiling chapters into one manuscript. Lives apart from the tool module so
// the bundled preview server can use it without pulling in the MCP server and
// its zod schemas.

import { getRegistry, readChapterFile } from "../storage/filestore";
import { SelectOptions, selectChapters } from "../export/select";
import { countWords } from "../utils/wordcount";

export type CompileOptions = SelectOptions;

export function compileManuscript(
  registry: NonNullable<ReturnType<typeof getRegistry>>,
  chapterIds?: string[],
  options: CompileOptions = {}
): { markdown: string; wordCount: number; chapterCount: number; warnings: string[] } {
  const chapters = selectChapters(registry, chapterIds, options);
  const warnings: string[] = [];

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
