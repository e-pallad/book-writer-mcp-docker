import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as fs from "fs";
import * as path from "path";
import { getRegistry, readChapterFile } from "../storage/filestore";
import { BookMCPError } from "../utils/errors";
import { countWords } from "../utils/wordcount";
import { describeSelection, selectChapters } from "../export/select";
import { buildDocx } from "../export/docx";
import { labelsFor, projectLanguage } from "../lang";

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
    "Compile all chapters in order into a single markdown file",
    {
      outputPath: z.string().optional().describe("Output file path (default: ./manuscript.md)"),
      includeChapters: includeChaptersSchema,
      includeFrontMatter: z.boolean().optional().default(true).describe("Include front matter"),
    },
    async ({ outputPath, includeChapters, includeFrontMatter }) => {
      const registry = getRegistry();
      if (!registry)
        throw new BookMCPError("No book project found. Run book_init first.");

      const outPath = outputPath || path.join(projectDir(), "manuscript.md");
      const chapters = selectChapters(registry, includeChapters);

      let markdown = "";

      if (includeFrontMatter) {
        markdown += `# ${registry.title}\n\n`;
        markdown += `**By ${registry.author}**\n\n`;
        markdown += `*${registry.genre}*\n\n---\n\n`;
      }

      for (const chapter of chapters) {
        const content = readChapterFile(chapter.filename);
        markdown += content;
        markdown += "\n\n---\n\n";
      }

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
                chaptersIncluded: chapters.length,
                selection: describeSelection(registry, includeChapters, chapters),
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
    "Compile the manuscript into a formatted .docx file: title page, table of contents, every chapter on a new page, and the chapter markdown turned into real Word formatting (italic, bold, headings, scene breaks, block quotes).",
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

      const warnings: string[] = [];
      const chapters = selected.flatMap((chapter) => {
        const markdown = readChapterFile(chapter.filename);
        if (!markdown.trim()) {
          warnings.push(
            `Chapter "${chapter.title}" (${chapter.filename}) is missing or empty on disk and was skipped.`
          );
          return [];
        }
        return [{ title: chapter.title, order: chapter.order, markdown }];
      });

      if (chapters.length === 0) {
        throw new BookMCPError("No chapters to export.");
      }

      const language = projectLanguage().tag;
      const labels = labelsFor(language);
      const buffer = await buildDocx({
        title: registry.title,
        author: registry.author,
        language,
        contentsLabel: labels.contents,
        byLabel: labels.by,
        chapters,
        fontFamily,
        fontSize,
        lineSpacing,
        includeTableOfContents,
        includePageNumbers,
      });
      fs.writeFileSync(outPath, buffer);

      const totalWords = chapters.reduce((sum, c) => sum + countWords(c.markdown), 0);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                message: "Manuscript exported to .docx.",
                outputPath: outPath,
                wordCount: totalWords,
                chaptersIncluded: chapters.length,
                selection: describeSelection(registry, includeChapters, selected),
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
