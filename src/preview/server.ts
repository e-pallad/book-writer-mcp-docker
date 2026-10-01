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
//   /version         a fingerprint of the manuscript text; the reader polls it
//                    and only updates when it changes
//   POST /api/notes  records a passage marked for revision as an open note

import * as crypto from "crypto";
import * as http from "http";
import * as path from "path";
import { getNotes, getRegistry } from "../storage/filestore";
import { markdownToHtml } from "../utils/markdown";
import { collectDashboard } from "../dashboard/collect";
import { renderDashboard } from "../dashboard/render";
import { buildReaderPage } from "./page";
import { compileManuscript } from "./manuscript";
import { MarkError, markPassage } from "./mark";

const DEFAULT_PORT = 3456;
const DEFAULT_REFRESH_SECONDS = 10;
const MAX_BODY_BYTES = 64 * 1024;

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

function openNoteCount(): number {
  return (getNotes()?.notes ?? []).filter((n) => n.status === "open").length;
}

// Compiled from the chapter files on every request, and deliberately
// including every chapter whatever its status: someone watching this page
// while they write wants to see the draft they are writing, not only what
// has been marked ready. The old server read a manuscript.md that went stale
// until book_export_markdown was run again.
function compileLive(registry: NonNullable<ReturnType<typeof getRegistry>>) {
  const compiled = compileManuscript(registry, undefined, { includeAll: true });
  // Only what the reader sees goes into the fingerprint, so a change to
  // anything else (the dashboard's data, notes) never reloads the page.
  const version = crypto
    .createHash("sha1")
    .update(`${registry.title}\n${registry.author}\n${compiled.markdown}`)
    .digest("hex")
    .slice(0, 16);
  return { ...compiled, version };
}

function renderReader(pollSeconds: number): string {
  const registry = getRegistry();
  if (!registry) {
    return errorPage(
      "No book project here",
      "This directory has no `.book-mcp/registry.json`. Run `book_init` first, then restart the preview server.",
    );
  }

  const { markdown, wordCount, version } = compileLive(registry);

  return buildReaderPage(
    registry.title,
    registry.author,
    markdownToHtml(markdown),
    wordCount,
    {
      language: registry.language,
      live: { pollSeconds, version, openNotes: openNoteCount() },
    }
  );
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new MarkError("Request too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } catch {
        reject(new MarkError("Request body is not valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Writing endpoints accept only same-origin JSON. A page on another site can
 * make a browser POST to localhost, but not with this content type without a
 * preflight this server never answers, and not with a foreign Origin.
 */
function isSameOriginJson(req: http.IncomingMessage): boolean {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

async function handleNotePost(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!isSameOriginJson(req)) {
    send(res, 403, "application/json; charset=utf-8", JSON.stringify({ error: "Forbidden." }));
    return;
  }
  try {
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const note = await markPassage({
      selection: String(body.selection ?? ""),
      container: typeof body.container === "string" ? body.container : undefined,
      text: typeof body.text === "string" ? body.text : undefined,
      kind: body.kind as never,
    });
    send(res, 200, "application/json; charset=utf-8", JSON.stringify({ id: note.id, chapterId: note.chapterId, openNotes: openNoteCount() }));
  } catch (error) {
    const known = error instanceof MarkError;
    const message = error instanceof Error ? error.message : String(error);
    if (!known) console.error("Error saving note:", message);
    send(res, known ? 400 : 500, "application/json; charset=utf-8", JSON.stringify({ error: message }));
  }
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

    if (req.method === "POST" && url === "/api/notes") {
      void handleNotePost(req, res);
      return;
    }

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

      if (url === "/version") {
        const registry = getRegistry();
        const version = registry ? compileLive(registry).version : "none";
        send(
          res,
          200,
          "application/json; charset=utf-8",
          JSON.stringify({ version, openNotes: openNoteCount() })
        );
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
    console.log(`  Select text in the manuscript to mark it for revision.`);
    console.log(`Reading from ${process.env.BOOK_PROJECT_DIR}`);
  });
}

// Only when run as a program, so the module can be imported by the tests.
if (require.main === module) {
  startPreviewServer();
}
