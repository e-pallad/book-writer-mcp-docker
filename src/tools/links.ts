import { z } from "zod";
import { ToolServer } from "./tool-server";
import {
  chapterFileExists,
  getNotes,
  getOutline,
  getRegistry,
  getResearch,
  getScenes,
  getStoryBible,
  getTimeline,
  trashedChapterIds,
} from "../storage/filestore";
import { resolveChapter } from "../storage/chapters";
import { BookMCPError } from "../utils/errors";
import { checkLinks } from "../links/check";
import { listScenes } from "../scenes/list";

export function registerLinkTools(server: ToolServer): void {
  server.tool(
    "book_links_check",
    "Check every reference between the project's records: that each chapter, character and setting id a plot thread, character, timeline event, scene, note, outline entry, structure beat or research entry holds still points at something that exists — and that a chapter id was not reused after a deletion. Reads the whole book's records and writes nothing. Each issue names the record, what it points at, and the tool call that repairs it (`repair`; `choose` is the argument only the author can decide). Run it after deleting, splitting or reordering chapters and before a revision.",
    {
      chapterId: z
        .string()
        .optional()
        .describe('Only issues that concern this chapter (id, title or "#N"). Omit for the whole book.'),
      severity: z
        .enum(["error", "warning", "all"])
        .optional()
        .default("all")
        .describe("error: only broken references. all (default): warnings too."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .default(50)
        .describe("Most issues to return, errors first (default 50)"),
    },
    async ({ chapterId, severity, limit }) => {
      const registry = getRegistry();
      if (!registry) throw new BookMCPError("No book project found. Run book_init first.");
      const bible = getStoryBible();
      if (!bible) throw new BookMCPError("No story bible found. Run book_init first.");
      const only = chapterId ? resolveChapter(registry, chapterId).id : null;

      const report = checkLinks({
        registry,
        bible,
        timeline: getTimeline(),
        outline: getOutline(),
        notes: getNotes(),
        scenes: getScenes(),
        research: getResearch(),
        fileExists: chapterFileExists,
        trashed: trashedChapterIds(),
        lostScenes: listScenes(registry.chapters).lost,
      });

      const matching = report.issues.filter(
        (i) =>
          (severity === "all" || i.severity === severity) &&
          (!only || i.chapterId === only || i.to?.id === only || i.from.id === only)
      );
      const shown = matching.slice(0, limit);

      const text = JSON.stringify(
        {
          summary: matching.length
            ? `${matching.filter((i) => i.severity === "error").length} broken reference(s) and ${matching.filter((i) => i.severity === "warning").length} warning(s) among ${report.references} references.`
            : `All ${report.references} references resolve.`,
          referencesChecked: report.references,
          issues: shown,
          ...(matching.length > shown.length
            ? { truncated: `${matching.length - shown.length} more; raise limit or narrow with chapterId.` }
            : {}),
          ...(registry.nextChapterNumber === undefined
            ? {
                note: "This project has no chapter-id counter yet; it is set the next time a chapter is created or deleted. Ids of chapters deleted earlier are known only from the trash.",
              }
            : {}),
        },
        null,
        2
      );
      return { content: [{ type: "text" as const, text }] };
    }
  );
}
