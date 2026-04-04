import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as fs from "fs";
import * as path from "path";
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Footer, PageNumber } from "docx";
import { getRegistry, readChapterFile } from "../storage/filestore";
import { BookMCPError } from "../utils/errors";
import { countWords } from "../utils/wordcount";

export function registerExportTools(server: McpServer): void {
  server.tool(
    "book_export_markdown",
    "Compile all chapters in order into a single markdown file",
    {
      outputPath: z.string().optional().describe("Output file path (default: ./manuscript.md)"),
      includeChapters: z
        .array(z.string())
        .optional()
        .describe("Chapter IDs to include (default: all final + review chapters)"),
      includeFrontMatter: z.boolean().optional().default(true).describe("Include front matter"),
    },
    async ({ outputPath, includeChapters, includeFrontMatter }) => {
      const registry = getRegistry();
      if (!registry)
        throw new BookMCPError("No book project found. Run book_init first.");

      const outPath = outputPath || path.join(process.env.BOOK_PROJECT_DIR || process.cwd(), "manuscript.md");

      let chapters = registry.chapters.sort((a, b) => a.order - b.order);
      if (includeChapters) {
        chapters = chapters.filter((c) => includeChapters.includes(c.id));
      } else {
        chapters = chapters.filter(
          (c) => c.status === "final" || c.status === "review"
        );
        // If no final/review chapters, include all
        if (chapters.length === 0) {
          chapters = registry.chapters.sort((a, b) => a.order - b.order);
        }
      }

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
    "Compile the full manuscript into a formatted .docx file",
    {
      outputPath: z.string().optional().describe("Output file path (default: ./manuscript.docx)"),
      includeTableOfContents: z.boolean().optional().default(true).describe("Include table of contents"),
      fontFamily: z.string().optional().default("Times New Roman").describe("Font family"),
      fontSize: z.number().optional().default(12).describe("Font size in points"),
      lineSpacing: z.enum(["single", "double"]).optional().default("double").describe("Line spacing"),
      includePageNumbers: z.boolean().optional().default(true).describe("Include page numbers"),
    },
    async ({ outputPath, includeTableOfContents, fontFamily, fontSize, lineSpacing, includePageNumbers }) => {
      const registry = getRegistry();
      if (!registry)
        throw new BookMCPError("No book project found. Run book_init first.");

      const outPath = outputPath || path.join(process.env.BOOK_PROJECT_DIR || process.cwd(), "manuscript.docx");
      const chapters = registry.chapters
        .filter((c) => c.status === "final" || c.status === "review" || c.status === "draft")
        .sort((a, b) => a.order - b.order);

      if (chapters.length === 0) {
        throw new BookMCPError("No chapters to export.");
      }

      const spacingLine = lineSpacing === "double" ? 480 : 240;
      const halfPoints = fontSize * 2;

      const children: Paragraph[] = [];

      // Title page
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 4000 },
          children: [
            new TextRun({
              text: registry.title,
              bold: true,
              size: halfPoints + 16,
              font: fontFamily,
            }),
          ],
        })
      );
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 400 },
          children: [
            new TextRun({
              text: `by ${registry.author}`,
              size: halfPoints + 4,
              font: fontFamily,
            }),
          ],
        })
      );
      children.push(
        new Paragraph({ children: [], spacing: { before: 2000 } })
      );

      // Table of contents (simple)
      if (includeTableOfContents) {
        children.push(
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [
              new TextRun({
                text: "Table of Contents",
                bold: true,
                size: halfPoints + 8,
                font: fontFamily,
              }),
            ],
          })
        );
        for (const ch of chapters) {
          children.push(
            new Paragraph({
              spacing: { line: spacingLine },
              children: [
                new TextRun({
                  text: `${ch.order}. ${ch.title}`,
                  size: halfPoints,
                  font: fontFamily,
                }),
              ],
            })
          );
        }
        children.push(new Paragraph({ children: [] }));
      }

      // Chapters
      let totalWords = 0;
      for (const chapter of chapters) {
        const content = readChapterFile(chapter.filename);
        totalWords += countWords(content);

        // Chapter heading
        children.push(
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 2000, after: 400 },
            children: [
              new TextRun({
                text: chapter.title,
                bold: true,
                size: halfPoints + 8,
                font: fontFamily,
              }),
            ],
          })
        );

        // Chapter content — split by paragraphs
        const paragraphs = content
          .replace(/^#.*\n*/m, "") // Remove markdown heading
          .split(/\n\n+/);

        for (const para of paragraphs) {
          const trimmed = para.trim();
          if (!trimmed) continue;

          children.push(
            new Paragraph({
              spacing: { line: spacingLine, after: 120 },
              children: [
                new TextRun({
                  text: trimmed,
                  size: halfPoints,
                  font: fontFamily,
                }),
              ],
            })
          );
        }
      }

      const footerChildren = includePageNumbers
        ? [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                new TextRun({ children: [PageNumber.CURRENT] }),
              ],
            }),
          ]
        : [];

      const doc = new Document({
        sections: [
          {
            properties: {
              ...(includePageNumbers
                ? {}
                : {}),
            },
            headers: {},
            footers: includePageNumbers
              ? {
                  default: new Footer({ children: footerChildren }),
                }
              : {},
            children,
          },
        ],
      });

      const buffer = await Packer.toBuffer(doc);
      fs.writeFileSync(outPath, buffer);

      const estimatedPages = Math.ceil(totalWords / 250);

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
                estimatedPages,
                settings: { fontFamily, fontSize, lineSpacing },
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
