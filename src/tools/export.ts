import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as fs from "fs";
import * as path from "path";
import { getRegistry } from "../storage/filestore";
import { BookMCPError } from "../utils/errors";
import { countWords } from "../utils/wordcount";
import { describeSelection, selectChapters } from "../export/select";
import { buildDocx } from "../export/docx";
import { assembleBook, bookToMarkdown } from "../export/assemble";

function projectDir(): string {
  return process.env.BOOK_PROJECT_DIR || process.cwd();
}

const includeChaptersSchema = z
  .array(z.string())
  .optional()
  .describe(
    "Chapter IDs or titles to include (default: all review + final chapters, or every chapter when none is marked ready)"
  );

export function registerExportTools(server: McpServer): void {
  server.tool(
    "book_export_markdown",
    "Compile the book into a single markdown file: title block, front matter, chapters in order (with part headings and chapter numbers when set), back matter.",
    {
      outputPath: z.string().optional().describe("Output file path (default: ./manuscript.md)"),
      includeChapters: includeChaptersSchema,
      includeFrontMatter: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include the title block and the front and back matter (default: true)"),
    },
    async ({ outputPath, includeChapters, includeFrontMatter }) => {
      const registry = getRegistry();
      if (!registry)
        throw new BookMCPError("No book project found. Run book_init first.");

      const outPath = outputPath || path.join(projectDir(), "manuscript.md");
      const chapters = selectChapters(registry, includeChapters);
      const book = assembleBook(registry, chapters, { includeMatter: includeFrontMatter });
      const markdown = bookToMarkdown(book, { titleBlock: includeFrontMatter });

      fs.writeFileSync(outPath, markdown, "utf-8");

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                message: "Manuscript exported to markdown.",
                outputPath: outPath,
                wordCount: countWords(markdown),
                chaptersIncluded: book.chapterCount,
                selection: describeSelection(registry, includeChapters, chapters),
                ...(book.front.length || book.back.length
                  ? { matter: [...book.front, ...book.back].map((m) => m.navTitle) }
                  : {}),
                ...(book.warnings.length ? { warnings: book.warnings } : {}),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "book_export_docx",
    "Compile the manuscript into a formatted .docx file: title page, front matter, table of contents, part pages, every chapter on a new page (numbered when set), back matter — and the chapter markdown turned into real Word formatting (italic, bold, headings, scene breaks, block quotes).",
    {
      outputPath: z.string().optional().describe("Output file path (default: ./manuscript.docx)"),
      includeChapters: includeChaptersSchema,
      includeTableOfContents: z.boolean().optional().default(true).describe("Include table of contents"),
      fontFamily: z.string().optional().default("Times New Roman").describe("Font family"),
      fontSize: z.number().optional().default(12).describe("Font size in points"),
      lineSpacing: z.enum(["single", "double"]).optional().default("double").describe("Line spacing"),
      includePageNumbers: z.boolean().optional().default(true).describe("Include page numbers"),
    },
    async ({
      outputPath,
      includeChapters,
      includeTableOfContents,
      fontFamily,
      fontSize,
      lineSpacing,
      includePageNumbers,
    }) => {
      const registry = getRegistry();
      if (!registry)
        throw new BookMCPError("No book project found. Run book_init first.");

      const outPath = outputPath || path.join(projectDir(), "manuscript.docx");
      const selected = selectChapters(registry, includeChapters);

      const book = assembleBook(registry, selected);
      if (book.chapterCount === 0) {
        throw new BookMCPError("No chapters to export.");
      }

      const buffer = await buildDocx(book, {
        fontFamily,
        fontSize,
        lineSpacing,
        includeTableOfContents,
        includePageNumbers,
      });
      fs.writeFileSync(outPath, buffer);

      const totalWords = book.body.reduce(
        (sum, item) => sum + (item.kind === "chapter" ? countWords(item.body) + countWords(item.heading) : 0),
        0
      );
      const warnings = book.warnings;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                message: "Manuscript exported to .docx.",
                outputPath: outPath,
                wordCount: totalWords,
                chaptersIncluded: book.chapterCount,
                selection: describeSelection(registry, includeChapters, selected),
                ...(book.front.length || book.back.length
                  ? { matter: [...book.front, ...book.back].map((m) => m.navTitle) }
                  : {}),
                estimatedPages: Math.ceil(totalWords / 250),
                settings: { fontFamily, fontSize, lineSpacing },
                ...(warnings.length ? { warnings } : {}),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
