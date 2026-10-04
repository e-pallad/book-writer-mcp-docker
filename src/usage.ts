// A record of which tools get called, so what to pin in gateway mode (see
// gateway.ts) can be decided from use rather than guessed.
//
// One JSON line per call in <project>/.book-mcp/tool-usage.jsonl:
//   {"ts":"2026-10-04T09:44:11.000Z","tool":"book_chapter_read","via":"listed","ok":true,"ms":12}
// Tool name, how it was reached, whether it succeeded and how long it took —
// never the arguments or the reply, which hold the manuscript. Turn it off with
// BOOK_MCP_USAGE_LOG=0. Summarise with `node scripts/tool-usage.js`.
//
// Logging must never break a tool, so every failure here is swallowed.

import * as fs from "fs";
import * as path from "path";

export type Via = "listed" | "gateway";

// book_call is only a carrier: the tool it runs is what gets recorded.
const NOT_LOGGED = new Set(["book_call"]);

function logPath(): string | null {
  if (process.env.BOOK_MCP_USAGE_LOG === "0") return null;
  const explicit = process.env.BOOK_PROJECT_DIR;
  const dir = path.join(explicit || process.cwd(), ".book-mcp");
  // Without BOOK_PROJECT_DIR the working directory is whatever the client
  // launched us in; don't leave a .book-mcp folder in a directory that is not a book.
  if (!explicit && !fs.existsSync(dir)) return null;
  return path.join(dir, "tool-usage.jsonl");
}

export function logToolCall(tool: string, via: Via, ok: boolean, ms: number): void {
  if (NOT_LOGGED.has(tool)) return;
  try {
    const file = logPath();
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), tool, via, ok, ms });
    fs.appendFileSync(file, line + "\n");
  } catch {
    // Not worth failing a tool call over.
  }
}

/** Wraps a handler so each call is recorded once it has finished. */
export function withUsageLog<A extends unknown[], R extends { isError?: boolean }>(
  tool: string,
  via: Via,
  handler: (...args: A) => R | Promise<R>
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    const started = Date.now();
    try {
      const result = await handler(...args);
      logToolCall(tool, via, !result.isError, Date.now() - started);
      return result;
    } catch (error) {
      logToolCall(tool, via, false, Date.now() - started);
      throw error;
    }
  };
}
