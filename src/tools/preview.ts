import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as fs from "fs";
import * as path from "path";
import { getRegistry, readChapterFile } from "../storage/filestore";
import { BookMCPError } from "../utils/errors";
import { countWords } from "../utils/wordcount";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function markdownToHtml(md: string): string {
  let html = escapeHtml(md);

  // Process headers in descending specificity to avoid partial matches
  html = html.replace(/^---$/gm, "<hr>");
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");

  html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

  const blocks = html.split(/\n\n+/);
  html = blocks
    .map((block) => {
      block = block.trim();
      if (!block) return "";
      if (/^<(h[1-3]|hr)/.test(block)) return block;
      return `<p>${block.replace(/\n/g, "<br>")}</p>`;
    })
    .join("\n");

  return html;
}

function buildHtmlPage(title: string, author: string, content: string, wordCount: number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} — Preview</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=Source+Serif+4:ital,wght@0,300;0,400;0,600;1,300;1,400&display=swap');

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      background: #f5f1eb;
      color: #2c2c2c;
      font-family: 'Source Serif 4', 'Georgia', serif;
      font-size: 18px;
      line-height: 1.8;
      -webkit-font-smoothing: antialiased;
    }

    .book {
      max-width: 640px;
      margin: 0 auto;
      padding: 60px 40px 120px;
      background: #fffdf8;
      min-height: 100vh;
      box-shadow: 0 0 60px rgba(0,0,0,0.08);
    }

    h1 {
      font-family: 'Playfair Display', 'Georgia', serif;
      font-size: 2em;
      font-weight: 700;
      margin: 2em 0 0.6em;
      line-height: 1.25;
      color: #1a1a1a;
      letter-spacing: -0.01em;
    }

    h1:first-child {
      font-size: 2.4em;
      margin-top: 1em;
      text-align: center;
      border-bottom: 2px solid #c9b99a;
      padding-bottom: 0.5em;
      margin-bottom: 1em;
    }

    h2 {
      font-family: 'Playfair Display', 'Georgia', serif;
      font-size: 1.4em;
      font-weight: 700;
      margin: 2.5em 0 0.8em;
      color: #1a1a1a;
      letter-spacing: 0.02em;
    }

    h3 {
      font-family: 'Playfair Display', 'Georgia', serif;
      font-size: 1.15em;
      font-weight: 700;
      margin: 2em 0 0.6em;
      color: #333;
    }

    p {
      margin-bottom: 1.2em;
      text-align: justify;
      hyphens: auto;
    }

    /* Drop cap on the first paragraph after each chapter heading */
    h1 + p::first-letter,
    h2 + p::first-letter {
      font-family: 'Playfair Display', serif;
      font-size: 3.2em;
      float: left;
      line-height: 0.8;
      margin: 0.05em 0.1em 0 0;
      color: #6b4c2a;
    }

    em { font-style: italic; }
    strong { font-weight: 600; }

    hr {
      border: none;
      text-align: center;
      margin: 2.5em 0;
    }
    hr::after {
      content: '\\2022  \\2022  \\2022';
      color: #c9b99a;
      font-size: 1.2em;
      letter-spacing: 0.5em;
    }

    .timestamp {
      text-align: center;
      color: #999;
      font-size: 0.75em;
      font-family: system-ui, sans-serif;
      padding: 20px 0;
      border-top: 1px solid #e8e2d8;
      margin-top: 60px;
    }

    .word-count {
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: #2c2c2c;
      color: #f5f1eb;
      font-family: system-ui, sans-serif;
      font-size: 12px;
      padding: 8px 14px;
      border-radius: 20px;
      opacity: 0.7;
    }

    @media (max-width: 700px) {
      .book { padding: 40px 24px 100px; }
      body { font-size: 16px; }
      h1:first-child { font-size: 1.8em; }
    }
  </style>
</head>
<body>
  <div class="book">
    ${content}
    <div class="timestamp">Generated: ${new Date().toLocaleString()}</div>
  </div>
  <div class="word-count">${wordCount.toLocaleString()} words</div>
</body>
</html>`;
}

function buildServerScript(title: string): string {
  const escapedTitle = title.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/`/g, "\\`");

  const lines = [
    "const http = require('http');",
    "const fs = require('fs');",
    "const path = require('path');",
    "",
    "const PORT = process.env.PREVIEW_PORT || 3456;",
    "const MANUSCRIPT = path.join(__dirname, '..', 'manuscript.md');",
    "const TITLE = '" + escapedTitle + "';",
    "",
    "function escapeHtml(text) {",
    "  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');",
    "}",
    "",
    "function markdownToHtml(md) {",
    "  let html = escapeHtml(md);",
    "  html = html.replace(/^---$/gm, '<hr>');",
    "  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');",
    "  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');",
    "  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');",
    "  html = html.replace(/\\*\\*\\*(.+?)\\*\\*\\*/g, '<strong><em>$1</em></strong>');",
    "  html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');",
    "  html = html.replace(/\\*(.+?)\\*/g, '<em>$1</em>');",
    "  var blocks = html.split(/\\n\\n+/);",
    "  html = blocks.map(function(block) {",
    "    block = block.trim();",
    "    if (!block) return '';",
    "    if (/^<(h[1-3]|hr)/.test(block)) return block;",
    "    return '<p>' + block.replace(/\\n/g, '<br>') + '</p>';",
    "  }).join('\\n');",
    "  return html;",
    "}",
    "",
    "function buildPage(manuscriptMd) {",
    "  var content = markdownToHtml(manuscriptMd);",
    "  var wordCount = manuscriptMd.split(/\\s+/).filter(Boolean).length;",
    "  return '<!DOCTYPE html>' +",
    "    '<html lang=\"en\"><head>' +",
    "    '<meta charset=\"UTF-8\">' +",
    "    '<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">' +",
    "    '<title>' + escapeHtml(TITLE) + ' \\u2014 Live Preview</title>' +",
    "    '<style>' +",
    "    \"@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=Source+Serif+4:ital,wght@0,300;0,400;0,600;1,300;1,400&display=swap');\" +",
    "    '* { margin: 0; padding: 0; box-sizing: border-box; }' +",
    "    'body { background: #f5f1eb; color: #2c2c2c; font-family: Source Serif 4, Georgia, serif; font-size: 18px; line-height: 1.8; -webkit-font-smoothing: antialiased; }' +",
    "    '.book { max-width: 640px; margin: 0 auto; padding: 60px 40px 120px; background: #fffdf8; min-height: 100vh; box-shadow: 0 0 60px rgba(0,0,0,0.08); }' +",
    "    'h1 { font-family: Playfair Display, Georgia, serif; font-size: 2em; font-weight: 700; margin: 2em 0 0.6em; line-height: 1.25; color: #1a1a1a; letter-spacing: -0.01em; }' +",
    "    'h1:first-child { font-size: 2.4em; margin-top: 1em; text-align: center; border-bottom: 2px solid #c9b99a; padding-bottom: 0.5em; margin-bottom: 1em; }' +",
    "    'h2 { font-family: Playfair Display, Georgia, serif; font-size: 1.4em; font-weight: 700; margin: 2.5em 0 0.8em; color: #1a1a1a; letter-spacing: 0.02em; }' +",
    "    'h3 { font-family: Playfair Display, Georgia, serif; font-size: 1.15em; font-weight: 700; margin: 2em 0 0.6em; color: #333; }' +",
    "    'p { margin-bottom: 1.2em; text-align: justify; hyphens: auto; }' +",
    "    'h1 + p::first-letter, h2 + p::first-letter { font-family: Playfair Display, serif; font-size: 3.2em; float: left; line-height: 0.8; margin: 0.05em 0.1em 0 0; color: #6b4c2a; }' +",
    "    'em { font-style: italic; } strong { font-weight: 600; }' +",
    "    'hr { border: none; text-align: center; margin: 2.5em 0; }' +",
    "    'hr::after { content: \"\\\\2022  \\\\2022  \\\\2022\"; color: #c9b99a; font-size: 1.2em; letter-spacing: 0.5em; }' +",
    "    '.timestamp { text-align: center; color: #999; font-size: 0.75em; font-family: system-ui, sans-serif; padding: 20px 0; border-top: 1px solid #e8e2d8; margin-top: 60px; }' +",
    "    '.word-count { position: fixed; bottom: 20px; right: 20px; background: #2c2c2c; color: #f5f1eb; font-family: system-ui, sans-serif; font-size: 12px; padding: 8px 14px; border-radius: 20px; opacity: 0.7; }' +",
    "    '@media (max-width: 700px) { .book { padding: 40px 24px 100px; } body { font-size: 16px; } h1:first-child { font-size: 1.8em; } }' +",
    "    '</style>' +",
    "    '<script>setTimeout(function() { location.reload(); }, 10000);</script>' +",
    "    '</head><body>' +",
    "    '<div class=\"book\">' +",
    "    content +",
    "    '<div class=\"timestamp\">Last updated: ' + new Date().toLocaleString() + '</div>' +",
    "    '</div>' +",
    "    '<div class=\"word-count\">' + wordCount.toLocaleString() + ' words</div>' +",
    "    '</body></html>';",
    "}",
    "",
    "var server = http.createServer(function(req, res) {",
    "  if (req.url === '/' || req.url === '/index.html') {",
    "    var md = '';",
    "    try {",
    "      md = fs.readFileSync(MANUSCRIPT, 'utf-8');",
    "    } catch (e) {",
    "      if (e.code === 'ENOENT') {",
    "        md = '# Manuscript not yet exported\\n\\nRun `book_export_markdown` to generate.';",
    "      } else {",
    "        md = '# Error reading manuscript\\n\\n' + String(e);",
    "        console.error('Failed to read manuscript:', e);",
    "      }",
    "    }",
    "    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });",
    "    res.end(buildPage(md));",
    "  } else {",
    "    res.writeHead(404);",
    "    res.end('Not found');",
    "  }",
    "});",
    "",
    "server.listen(PORT, function() {",
    "  console.log('Book preview running at http://localhost:' + PORT);",
    "});",
  ];

  return lines.join("\n") + "\n";
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

function filterChapters(
  registry: NonNullable<ReturnType<typeof getRegistry>>,
  chapterIds?: string[]
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
  } else {
    const filtered = chapters.filter(
      (c) => c.status === "final" || c.status === "review"
    );
    chapters = filtered.length > 0 ? filtered : chapters;
  }

  return { chapters, warnings };
}

function compileManuscript(
  registry: NonNullable<ReturnType<typeof getRegistry>>,
  chapterIds?: string[]
): { markdown: string; wordCount: number; chapterCount: number; warnings: string[] } {
  const { chapters, warnings } = filterChapters(registry, chapterIds);

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

export function registerPreviewTools(server: McpServer): void {
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
      const html = buildHtmlPage(registry.title, registry.author, htmlContent, wc);

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
    "Set up a live preview server that auto-refreshes as you write. Creates a preview/ directory with a Node.js server.",
    {
      port: z.number().optional().default(3456).describe("Server port (default: 3456)"),
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

      const serverScript = buildServerScript(registry.title);
      const serverPath = path.join(previewDir, "server.js");
      safeWriteFile(serverPath, serverScript, "preview server script");

      // Overwrite manuscript.md with a fresh export of all chapters
      const { markdown, wordCount, chapterCount, warnings } = compileManuscript(registry);
      const manuscriptPath = path.join(projectDir, "manuscript.md");
      safeWriteFile(manuscriptPath, markdown, "manuscript");

      const result: Record<string, unknown> = {
        message: "Live preview server created.",
        serverPath,
        wordCount,
        chaptersIncluded: chapterCount,
        instructions: [
          `Run: node ${serverPath}`,
          `Or: cd ${previewDir} && node server.js`,
          `Then open: http://localhost:${port}`,
          "The page auto-refreshes every 10 seconds.",
          "Re-run book_export_markdown to update the manuscript.",
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
