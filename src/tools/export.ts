import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as fs from "fs";
import * as path from "path";
import { getRegistry } from "../storage/filestore";
import { BookMCPError } from "../utils/errors";
import { countWords } from "../utils/wordcount";
import { describeSelection, selectChapters } from "../export/select";
import { buildDocx, layoutFor } from "../export/docx";
import { measureExtent } from "../export/normseite";
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
    "Compile the book into a .docx. preset='book' (default) is a book to read: title page, front matter, table of contents, part pages, every chapter on a new page, back matter, with the chapter markdown turned into real Word formatting. preset='normseite' is the German submission manuscript: A4, Courier New 12 pt, 30 lines of 60 characters, a running head, a cover sheet with the extent in Normseiten. preset='standard_manuscript' is the English-language Standard Manuscript Format: US Letter, 12 pt, double-spaced, 1-inch margins, 'Surname / TITLE / page' header, chapters a third of the way down, '#' scene breaks, END.",
    {
      outputPath: z.string().optional().describe("Output file path (default: ./manuscript.docx)"),
      preset: z
        .enum(["book", "normseite", "standard_manuscript"])
        .optional()
        .default("book")
        .describe("book (default), normseite, or standard_manuscript"),
      includeChapters: includeChaptersSchema,
      includeTableOfContents: z
        .boolean()
        .optional()
        .describe("Include a table of contents (book preset; default: true)"),
      fontFamily: z
        .string()
        .optional()
        .describe("Font family (book preset; default Times New Roman). standard_manuscript takes 'Courier New' or 'Times New Roman'"),
      fontSize: z.number().optional().describe("Font size in points (book preset; default 12)"),
      lineSpacing: z.enum(["single", "double"]).optional().describe("Line spacing (book preset; default double)"),
      includePageNumbers: z.boolean().optional().describe("Page numbers in the footer (book preset; default true)"),
      contact: z
        .array(z.string())
        .optional()
        .describe("Contact lines for a manuscript's cover sheet: name, address, email, phone, agent (default: the author's name)"),
    },
    async ({
      outputPath,
      preset,
      includeChapters,
      includeTableOfContents,
      fontFamily,
      fontSize,
      lineSpacing,
      includePageNumbers,
      contact,
    }) => {
      const registry = getRegistry();
      if (!registry)
        throw new BookMCPError("No book project found. Run book_init first.");

      const outPath = outputPath || path.join(projectDir(), "manuscript.docx");
      const selected = selectChapters(registry, includeChapters);
      const manuscript = preset !== "book";
      const notes: string[] = [];

      // A submission manuscript is the text: no copyright page, no dedication,
      // no acknowledgements — those are the publisher's to set.
      const book = assembleBook(registry, selected, { includeMatter: !manuscript });
      if (book.chapterCount === 0) {
        throw new BookMCPError("No chapters to export.");
      }
      const extent = measureExtent(book);

      if (manuscript) {
        const ignored = Object.entries({ includeTableOfContents, fontSize, lineSpacing, includePageNumbers })
          .filter(([, value]) => value !== undefined)
          .map(([key]) => key);
        if (preset === "normseite" && fontFamily !== undefined) ignored.push("fontFamily");
        if (ignored.length) {
          notes.push(`The ${preset} format fixes these, so they were not applied: ${ignored.join(", ")}.`);
        }
        notes.push("Front and back matter are left out of a submission manuscript.");
      }
      if (preset === "standard_manuscript" && fontFamily && !/^(courier new|courier|times new roman)$/i.test(fontFamily)) {
        throw new BookMCPError('The Standard Manuscript Format is set in "Courier New" or "Times New Roman".');
      }

      const surname = book.author.trim().split(/\s+/).pop() ?? book.author;
      const layout = layoutFor({
        preset,
        fontFamily,
        fontSize,
        lineSpacing,
        includeTableOfContents,
        includePageNumbers,
        contact,
        runningHead:
          preset === "normseite"
            ? `${book.author} · ${book.title}`
            : preset === "standard_manuscript"
            ? `${surname} / ${shortTitle(book.title).toUpperCase()}`
            : undefined,
        extent:
          preset === "normseite"
            ? `ca. ${extent.normPages} ${extent.normPages === 1 ? "Normseite" : "Normseiten"}`
            : preset === "standard_manuscript"
            ? `about ${roundedWords(extent.words).toLocaleString("en-US")} words`
            : undefined,
      });

      const buffer = await buildDocx(book, layout);
      fs.writeFileSync(outPath, buffer);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                message: `Manuscript exported to .docx (${preset}).`,
                outputPath: outPath,
                preset,
                wordCount: extent.words,
                chaptersIncluded: book.chapterCount,
                selection: describeSelection(registry, includeChapters, selected),
                ...(book.front.length || book.back.length
                  ? { matter: [...book.front, ...book.back].map((m) => m.navTitle) }
                  : {}),
                extent: {
                  normPages: extent.normPages,
                  charactersWithSpaces: extent.characters,
                },
                settings: {
                  fontFamily: layout.fontFamily,
                  fontSize: layout.fontSize,
                  page: preset === "standard_manuscript" ? "US Letter" : "A4",
                },
                ...(notes.length ? { notes } : {}),
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
}

// The Standard Manuscript Format's running head carries a keyword from the
// title, not all of it: "Surname / HARBOUR / 12".
function shortTitle(title: string): string {
  const words = title.replace(/[^\p{L}\p{N}\s'-]/gu, "").split(/\s+/).filter(Boolean);
  const skip = new Set(["the", "a", "an", "der", "die", "das", "ein", "eine"]);
  const meaningful = words.filter((w) => !skip.has(w.toLowerCase()));
  return (meaningful.length ? meaningful : words).slice(0, 2).join(" ") || title;
}

// Word counts on a cover sheet are approximate by convention: to the nearest
// thousand for a book, the nearest hundred for something shorter.
function roundedWords(words: number): number {
  return words >= 1000 ? Math.round(words / 1000) * 1000 : Math.max(100, Math.round(words / 100) * 100);
}
