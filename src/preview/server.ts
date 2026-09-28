// The live preview server.
//
// This used to be ~120 lines of JavaScript assembled as an array of strings,
// which meant a second copy of markdownToHtml, a second copy of escapeHtml and
// a second copy of the reader stylesheet — none of them type-checked, and all
// free to drift from the originals. It is now ordinary TypeScript that imports
// the real modules, bundled by esbuild into a single self-contained file that
// book_preview_server copies into the project. The file it writes is still
// standalone, so `node preview/server.js` works with nothing installed.
//
// Routes:
//   /                the manuscript, typeset for reading
//   /dashboard       the dashboard, rebuilt on every request
//   /dashboard.json  the same data, for anything that wants to consume it

import * as http from "http";
import * as path from "path";
import { getRegistry } from "../storage/filestore";
import { markdownToHtml } from "../utils/markdown";
import { collectDashboard } from "../dashboard/collect";
import { renderDashboard } from "../dashboard/render";
import { buildReaderPage } from "./page";
import { compileManuscript } from "./manuscript";

const DEFAULT_PORT = 3456;
const DEFAULT_REFRESH_SECONDS = 10;

/**
 * Where the book lives.
 *
 * The bundle is written to <project>/preview/server.js, so the project is its
 * parent directory. An explicit BOOK_PROJECT_DIR still wins, which is what the
 * container sets.
 */
function resolveProjectDir(): string {
  if (process.env.BOOK_PROJECT_DIR) return process.env.BOOK_PROJECT_DIR;
  return path.resolve(__dirname, "..");
}

function errorPage(title: string, message: string): string {
  return buildReaderPage(
    title,
    "",
    markdownToHtml(`# ${title}\n\n${message}\n`),
    0,
    { refreshSeconds: DEFAULT_REFRESH_SECONDS }
  );
}

function renderReader(refreshSeconds: number): string {
  const registry = getRegistry();
  if (!registry) {
    return errorPage(
      "No book project here",
      "This directory has no `.book-mcp/registry.json`. Run `book_init` first, then restart the preview server.",
    );
  }

  // Compiled from the chapter files on every request, and deliberately
  // including every chapter whatever its status: someone watching this page
  // while they write wants to see the draft they are writing, not only what
  // has been marked ready. The old server read a manuscript.md that went stale
  // until book_export_markdown was run again.
  const { markdown, wordCount } = compileManuscript(registry, undefined, {
    includeAll: true,
  });

  return buildReaderPage(
    registry.title,
    registry.author,
    markdownToHtml(markdown),
    wordCount,
    { refreshSeconds }
  );
}

function send(
  res: http.ServerResponse,
  status: number,
  contentType: string,
  body: string
): void {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

export function createPreviewServer(refreshSeconds = DEFAULT_REFRESH_SECONDS) {
  return http.createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];

    try {
      if (url === "/" || url === "/index.html") {
        send(res, 200, "text/html; charset=utf-8", renderReader(refreshSeconds));
        return;
      }

      if (url === "/dashboard" || url === "/dashboard.html") {
        const html = renderDashboard(collectDashboard(), { refreshSeconds });
        send(res, 200, "text/html; charset=utf-8", html);
        return;
      }

      if (url === "/dashboard.json") {
        send(
          res,
          200,
          "application/json; charset=utf-8",
          JSON.stringify(collectDashboard(), null, 2)
        );
        return;
      }

      send(res, 404, "text/plain; charset=utf-8", "Not found");
    } catch (error) {
      // A half-written project should show what is wrong in the browser
      // rather than killing the server the author is watching.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error serving ${url}:`, message);
      if (url === "/dashboard.json") {
        send(res, 500, "application/json; charset=utf-8", JSON.stringify({ error: message }));
      } else {
        send(res, 500, "text/html; charset=utf-8", errorPage("Something went wrong", message));
      }
    }
  });
}

export function startPreviewServer(): void {
  const port = Number(process.env.PREVIEW_PORT || process.env.PORT) || DEFAULT_PORT;
  const refresh =
    Number(process.env.PREVIEW_REFRESH_SECONDS) || DEFAULT_REFRESH_SECONDS;

  process.env.BOOK_PROJECT_DIR = resolveProjectDir();

  createPreviewServer(refresh).listen(port, () => {
    console.log(`Book preview running at http://localhost:${port}`);
    console.log(`  manuscript  http://localhost:${port}/`);
    console.log(`  dashboard   http://localhost:${port}/dashboard`);
    console.log(`  data        http://localhost:${port}/dashboard.json`);
    console.log(`Reading from ${process.env.BOOK_PROJECT_DIR}`);
  });
}

// Only when run as a program, so the module can be imported by the tests.
if (require.main === module) {
  startPreviewServer();
}
