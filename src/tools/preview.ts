import { z } from "zod";
import { ToolServer } from "./tool-server";
import * as fs from "fs";
import * as path from "path";
import { getRegistry } from "../storage/filestore";
import { BookMCPError } from "../utils/errors";
import { markdownToHtml } from "../utils/markdown";
import { buildReaderPage } from "../preview/page";
import { compileManuscript } from "../preview/manuscript";

// The live server is real TypeScript bundled by esbuild rather than a string
// built at run time, so book_preview_server copies that bundle into the
// project. The copy is self-contained: `node preview/server.js` needs nothing
// installed alongside it.
function locatePreviewBundle(): string {
  const candidates = [
    // Running from the bundled dist/ entry point.
    path.join(__dirname, "preview-server.js"),
    // Running from dist-tsc/tools or src/tools (tests, ts-node).
    path.join(__dirname, "..", "..", "dist", "preview-server.js"),
    path.join(__dirname, "..", "dist", "preview-server.js"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new BookMCPError(
    "The preview server bundle is missing. Run `npm run build` in the book-writer-mcp installation, then try again."
  );
}



function safeWriteFile(filePath: string, content: string, description: string): void {
  const parentDir = path.dirname(filePath);
  if (!fs.existsSync(parentDir)) {
    throw new BookMCPError(
      `Cannot write ${description}: directory "${parentDir}" does not exist.`
    );
  }
  try {
    fs.writeFileSync(filePath, content, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new BookMCPError(`Failed to write ${description} to "${filePath}": ${msg}`);
  }
}

export function registerPreviewTools(server: ToolServer): void {
  server.tool(
    "book_preview",
    "Generate a beautiful HTML preview of the manuscript for reading in a browser",
    {
      outputPath: z.string().optional().describe("Output HTML file path (default: ./preview.html)"),
      chapters: z
        .array(z.string())
        .optional()
        .describe("Specific chapter IDs to preview (default: all final/review chapters)"),
    },
    async ({ outputPath, chapters }) => {
      const registry = getRegistry();
      if (!registry)
        throw new BookMCPError("No book project found. Run book_init first.");

      const projectDir = process.env.BOOK_PROJECT_DIR || process.cwd();
      const outPath = outputPath || path.join(projectDir, "preview.html");

      const { markdown, wordCount: wc, chapterCount, warnings } = compileManuscript(registry, chapters);
      const htmlContent = markdownToHtml(markdown);
      const html = buildReaderPage(registry.title, registry.author, htmlContent, wc, {
        language: registry.language,
      });

      safeWriteFile(outPath, html, "preview HTML");

      const result: Record<string, unknown> = {
        message: "HTML preview generated. Open in a browser to read.",
        outputPath: outPath,
        wordCount: wc,
        chaptersIncluded: chapterCount,
        hint: `Open file://${outPath} in your browser`,
      };
      if (warnings.length > 0) {
        result.warnings = warnings;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "book_preview_server",
    "Set up a live preview server that updates the reader page as you write — only when the text has actually changed — and lets you select passages to mark them for revision (they become open notes, see book_note_list). Creates a preview/ directory with a standalone Node.js server serving the manuscript at / and the dashboard at /dashboard, both rebuilt from the chapter files on every request.",
    {
      port: z
        .number()
        .optional()
        .default(3456)
        .describe(
          "Port to report in the instructions (default: 3456). The server itself reads PREVIEW_PORT at run time."
        ),
    },
    async ({ port }) => {
      const registry = getRegistry();
      if (!registry)
        throw new BookMCPError("No book project found. Run book_init first.");

      const projectDir = process.env.BOOK_PROJECT_DIR || process.cwd();
      const previewDir = path.join(projectDir, "preview");

      try {
        if (!fs.existsSync(previewDir)) {
          fs.mkdirSync(previewDir, { recursive: true });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new BookMCPError(`Failed to create preview directory "${previewDir}": ${msg}`);
      }

      const serverPath = path.join(previewDir, "server.js");
      try {
        fs.copyFileSync(locatePreviewBundle(), serverPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new BookMCPError(
          `Failed to write the preview server to "${serverPath}": ${msg}`
        );
      }

      // Reported so the response can say what the server will show. It is not
      // written to disk any more: the server compiles the manuscript from the
      // chapter files on each request, so the page can no longer go stale.
      const { wordCount, chapterCount, warnings } = compileManuscript(
        registry,
        undefined,
        { includeAll: true }
      );

      const result: Record<string, unknown> = {
        message: "Live preview server created.",
        serverPath,
        wordCount,
        chaptersIncluded: chapterCount,
        urls: {
          manuscript: `http://localhost:${port}/`,
          dashboard: `http://localhost:${port}/dashboard`,
          data: `http://localhost:${port}/dashboard.json`,
        },
        instructions: [
          `Run: node ${serverPath}`,
          `Or: cd ${previewDir} && node server.js`,
          `Then open: http://localhost:${port}`,
          `The dashboard is at http://localhost:${port}/dashboard`,
          "Both pages are rebuilt from the chapter files on each request, so no export step is needed. Both pages check every 10 seconds whether their content changed and only then update, keeping the scroll position. Selecting text in the manuscript offers a mark-for-revision button, which records an open note on that passage.",
          `Set PREVIEW_PORT to use another port, PREVIEW_REFRESH_SECONDS to change how often the pages check for changes.`,
        ],
      };
      if (warnings.length > 0) {
        result.warnings = warnings;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );
}
