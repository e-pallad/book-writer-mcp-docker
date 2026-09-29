import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getNotes, readChapterFile, updateNotes } from "../storage/filestore";
import { requireProject, resolveChapter } from "../storage/chapters";
import { Note } from "../storage/schema";
import { BookMCPError } from "../utils/errors";
import { normalizeForCompare, splitParagraphs, toNFC } from "../utils/text";
import { locateNote } from "../notes/anchor";

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function newId(existing: Note[]): string {
  const taken = new Set(existing.map((n) => n.id));
  const base = `note-${Date.now().toString(36)}`;
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}

// When a note is pinned to a paragraph rather than to words, the paragraph's
// opening is what it is anchored to — enough to find it again, short enough
// to survive an edit further down the paragraph.
const PARAGRAPH_ANCHOR_CHARS = 60;

export function registerNoteTools(server: McpServer): void {
  server.tool(
    "book_note_add",
    "Record a note from a test reader, an editor or the author on a chapter — anchored to the passage it is about, so it follows the passage through revisions. Use it to collect feedback where it belongs instead of in the conversation.",
    {
      chapterId: z.string().describe('Chapter ID (e.g. "ch-001") or chapter title'),
      text: z.string().describe("The note itself"),
      source: z
        .string()
        .optional()
        .default("author")
        .describe('Who it is from: "Testleserin A", "Lektorat", "author" (default)'),
      kind: z
        .enum(["comment", "question", "suggestion", "praise"])
        .optional()
        .default("comment")
        .describe("comment (default), question, suggestion, or praise"),
      anchorText: z
        .string()
        .optional()
        .describe("The exact words the note is about, as they appear in the chapter"),
      paragraph: z
        .number()
        .optional()
        .describe("Pin the note to a paragraph instead (1-based, as book_chapter_find reports them)"),
    },
    async ({ chapterId, text, source, kind, anchorText, paragraph }) => {
      if (!text.trim()) throw new BookMCPError("A note needs text.");
      const registry = requireProject();
      const chapter = resolveChapter(registry, chapterId);
      const content = toNFC(readChapterFile(chapter.filename));

      let anchor = "";
      let paragraphHint: number | undefined;
      if (anchorText !== undefined && anchorText !== "") {
        anchor = toNFC(anchorText);
        const located = locateNote({ anchorText: anchor, paragraphHint: paragraph }, content);
        if (!located.found) {
          throw new BookMCPError(
            `"${anchorText}" is not in chapter ${chapter.id} ("${chapter.title}"). The anchor must match the text exactly; book_chapter_find shows what is there.`
          );
        }
        paragraphHint = located.paragraph ?? undefined;
      } else if (paragraph !== undefined) {
        const paragraphs = splitParagraphs(content);
        const target = paragraphs[paragraph - 1];
        if (!Number.isInteger(paragraph) || !target || !target.text.trim()) {
          throw new BookMCPError(
            `Chapter ${chapter.id} has no paragraph ${paragraph} (it has ${paragraphs.length}).`
          );
        }
        anchor = target.text.trim().slice(0, PARAGRAPH_ANCHOR_CHARS);
        paragraphHint = paragraph;
      }

      const note: Note = {
        id: "",
        chapterId: chapter.id,
        anchorText: anchor,
        ...(paragraphHint !== undefined ? { paragraphHint } : {}),
        source: source.trim() || "author",
        kind,
        text: text.trim(),
        status: "open",
        createdAt: new Date().toISOString(),
      };
      await updateNotes((notes) => {
        note.id = newId(notes.notes);
        notes.notes.push(note);
      });

      return jsonResult({
        message: `Note added to ${chapter.id} ("${chapter.title}").`,
        note,
        location: locateNote(note, content),
      });
    }
  );

  server.tool(
    "book_note_list",
    "List notes — open ones by default — with where each passage is now. A note whose passage a revision removed is reported as lost rather than shown in the wrong place.",
    {
      chapterId: z.string().optional().describe("Only this chapter (id or title)"),
      status: z
        .enum(["open", "resolved", "all"])
        .optional()
        .default("open")
        .describe("open (default), resolved, or all"),
      source: z.string().optional().describe("Only notes from this source"),
      kind: z.enum(["comment", "question", "suggestion", "praise"]).optional(),
    },
    async ({ chapterId, status, source, kind }) => {
      const registry = requireProject();
      const chapter = chapterId ? resolveChapter(registry, chapterId) : null;
      const all = getNotes()?.notes ?? [];
      const selected = all.filter(
        (n) =>
          (!chapter || n.chapterId === chapter.id) &&
          (status === "all" || n.status === status) &&
          (!source || normalizeForCompare(n.source) === normalizeForCompare(source)) &&
          (!kind || n.kind === kind)
      );

      const contents = new Map<string, string>();
      const textOf = (id: string) => {
        if (!contents.has(id)) {
          const meta = registry.chapters.find((c) => c.id === id);
          contents.set(id, meta ? readChapterFile(meta.filename) : "");
        }
        return contents.get(id)!;
      };

      const order = new Map(registry.chapters.map((c) => [c.id, c.order]));
      const listed = selected
        .map((note) => {
          const inBook = order.has(note.chapterId);
          return {
            ...note,
            location: inBook
              ? locateNote(note, textOf(note.chapterId))
              : { found: false, paragraph: null, chapterDeleted: true },
          };
        })
        .sort(
          (a, b) =>
            (order.get(a.chapterId) ?? Infinity) - (order.get(b.chapterId) ?? Infinity) ||
            (a.location.paragraph ?? 0) - (b.location.paragraph ?? 0)
        );

      const lost = listed.filter((n) => !n.location.found).length;
      const bySource: Record<string, number> = {};
      for (const note of listed) bySource[note.source] = (bySource[note.source] ?? 0) + 1;

      return jsonResult({
        count: listed.length,
        bySource,
        ...(lost
          ? {
              lostAnchors: `${lost} note(s) point at text that is no longer in their chapter — the passage was revised or cut. Their paragraph is where it used to be.`,
            }
          : {}),
        notes: listed,
      });
    }
  );

  server.tool(
    "book_note_resolve",
    "Mark a note as dealt with, optionally saying how. Pass reopen=true to open it again.",
    {
      noteId: z.string().describe("The note's id"),
      resolution: z.string().optional().describe("How it was dealt with: 'rewritten', 'kept on purpose, because …'"),
      reopen: z.boolean().optional().default(false).describe("Open a resolved note again"),
    },
    async ({ noteId, resolution, reopen }) => {
      let note!: Note;
      await updateNotes((notes) => {
        const found = notes.notes.find((n) => n.id === noteId);
        if (!found) throw new BookMCPError(`Note "${noteId}" not found.`);
        if (reopen) {
          found.status = "open";
          delete found.resolvedAt;
        } else {
          found.status = "resolved";
          found.resolvedAt = new Date().toISOString();
          if (resolution !== undefined) found.resolution = resolution;
        }
        note = found;
      });
      return jsonResult({
        message: reopen ? `Note ${noteId} reopened.` : `Note ${noteId} resolved.`,
        note,
      });
    }
  );

  server.tool(
    "book_note_delete",
    "Delete a note outright — for one recorded by mistake. A note that was dealt with is better resolved, which keeps the record.",
    { noteId: z.string().describe("The note's id") },
    async ({ noteId }) => {
      let removed = false;
      await updateNotes((notes) => {
        const before = notes.notes.length;
        notes.notes = notes.notes.filter((n) => n.id !== noteId);
        removed = notes.notes.length < before;
        if (!removed) return false;
      });
      if (!removed) throw new BookMCPError(`Note "${noteId}" not found.`);
      return jsonResult({ message: `Note ${noteId} deleted.` });
    }
  );
}
