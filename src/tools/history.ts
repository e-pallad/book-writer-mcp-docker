import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  readChapterFile,
  writeChapterFile,
  updateRegistry,
} from "../storage/filestore";
import {
  MAX_SNAPSHOTS_PER_CHAPTER,
  listSnapshots,
  readSnapshot,
  readableTimestamp,
  saveSnapshot,
} from "../storage/history";
import { diffStats } from "../utils/diff";
import { countWords } from "../utils/wordcount";
import { requireProject, resolveChapter } from "./manuscript";

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

export function registerHistoryTools(server: McpServer): void {
  // book_chapter_history_list
  server.tool(
    "book_chapter_history_list",
    "List the saved versions of a chapter. Every book_chapter_update that changes the prose files the previous text away first, so this is the revision trail. Each entry shows how many lines that version differs from the chapter as it stands now.",
    {
      chapterId: z
        .string()
        .describe('Chapter ID (e.g. "ch-001") or chapter title'),
    },
    async ({ chapterId }) => {
      const registry = requireProject();
      const chapter = resolveChapter(registry, chapterId);
      const current = readChapterFile(chapter.filename);

      const snapshots = listSnapshots(chapter.id).map((snapshot) => {
        const content = readSnapshot(chapter.id, snapshot.timestamp);
        // Stated as "what it would take to get from that version to this one",
        // which is the direction a revert would travel.
        const { added, removed } = diffStats(content, current);
        return {
          timestamp: snapshot.timestamp,
          savedAt: snapshot.savedAt,
          wordCount: countWords(content),
          bytes: snapshot.bytes,
          versusCurrent: {
            linesAdded: added,
            linesRemoved: removed,
            summary:
              added === 0 && removed === 0
                ? "identical to the current version"
                : `+${added} / -${removed} lines to reach the current version`,
          },
        };
      });

      return jsonResult({
        chapterId: chapter.id,
        title: chapter.title,
        currentWordCount: countWords(current),
        snapshotCount: snapshots.length,
        maxSnapshotsKept: MAX_SNAPSHOTS_PER_CHAPTER,
        snapshots,
        ...(snapshots.length
          ? {
              hint: "Restore one with book_chapter_revert, or read the full changes with book_chapter_diff.",
            }
          : {
              hint: "No saved versions yet. One is filed on the next book_chapter_update that changes the prose.",
            }),
      });
    }
  );

  // book_chapter_revert
  server.tool(
    "book_chapter_revert",
    "Restore a saved version of a chapter as its current content. The text being replaced is filed as a new version first, so a revert can itself be reverted.",
    {
      chapterId: z
        .string()
        .describe('Chapter ID (e.g. "ch-001") or chapter title'),
      timestamp: z
        .string()
        .describe(
          'Snapshot timestamp to restore, exactly as book_chapter_history_list reports it (e.g. "2026-09-22T14-30-00-000Z")'
        ),
    },
    async ({ chapterId, timestamp }) => {
      let chapter!: ReturnType<typeof resolveChapter>;
      let undoTimestamp!: string;
      let restored!: string;
      let current!: string;

      await updateRegistry((registry) => {
        chapter = resolveChapter(registry, chapterId);

        restored = readSnapshot(chapter.id, timestamp);
        current = readChapterFile(chapter.filename);

        // Unconditionally, even when the texts match: an author who asks for a
        // revert should find an undo point waiting afterwards either way.
        undoTimestamp = saveSnapshot(chapter.id, current);

        writeChapterFile(chapter.filename, restored);
        chapter.wordCount = countWords(restored);
        chapter.updatedAt = new Date().toISOString();
      });

      const { added, removed } = diffStats(current, restored);

      return jsonResult({
        message: `Chapter "${chapter.title}" reverted to the version saved at ${readableTimestamp(
          timestamp
        )}.`,
        chapterId: chapter.id,
        restoredFrom: timestamp,
        undoSnapshot: undoTimestamp,
        undoHint: `The text this replaced was saved as "${undoTimestamp}". Revert to that timestamp to undo this revert.`,
        wordCount: chapter.wordCount,
        changes: { linesAdded: added, linesRemoved: removed },
        meta: chapter,
      });
    }
  );
}
