// Compiling chapters into one manuscript. Lives apart from the tool module so
// the bundled preview server can use it without pulling in the MCP server and
// its zod schemas.

import { getRegistry } from "../storage/filestore";
import { SelectOptions, selectChapters } from "../export/select";
import { assembleBook, bookToMarkdown } from "../export/assemble";
import { countWords } from "../utils/wordcount";

export type CompileOptions = SelectOptions;

/**
 * The book as the preview shows it: the same assembly the exports use, so the
 * page a writer watches has the front matter, part pages and chapter numbers
 * the finished file will have.
 */
export function compileManuscript(
  registry: NonNullable<ReturnType<typeof getRegistry>>,
  chapterIds?: string[],
  options: CompileOptions = {}
): { markdown: string; wordCount: number; chapterCount: number; warnings: string[] } {
  const chapters = selectChapters(registry, chapterIds, options);
  const book = assembleBook(registry, chapters);
  const markdown = bookToMarkdown(book);

  return {
    markdown,
    wordCount: countWords(markdown),
    chapterCount: book.chapterCount,
    warnings: book.warnings,
  };
}
