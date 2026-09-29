import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getRegistry,
  getStoryBible,
  getTimeline,
  readChapterFile,
} from "../storage/filestore";
import { checkTimeline } from "./timeline-continuity";
import { BookMCPError } from "../utils/errors";
import { normalizeForCompare } from "../utils/text";
import { resolveChapter } from "../storage/chapters";
import { languageNote, projectLanguage } from "../lang";
import { checkCharacters } from "./continuity-rules";

interface ContinuityFlag {
  type: "character" | "timeline" | "setting" | "plot_thread";
  severity: "error" | "warning";
  description: string;
  suggestion: string;
}

export function registerContinuityTools(server: McpServer): void {
  server.tool(
    "book_continuity_check",
    "Cross-reference a chapter draft against the story bible for continuity issues",
    {
      chapterId: z.string().describe('Chapter ID (e.g. "ch-001") or chapter title'),
    },
    async ({ chapterId }) => {
      const registry = getRegistry();
      if (!registry)
        throw new BookMCPError("No book project found. Run book_init first.");

      const bible = getStoryBible();
      if (!bible)
        throw new BookMCPError("No story bible found. Run book_init first.");

      const chapter = resolveChapter(registry, chapterId);

      const content = readChapterFile(chapter.filename);
      const contentLower = normalizeForCompare(content);
      const flags: ContinuityFlag[] = [];

      // Cross-reference the draft against the logged timeline before the
      // story-bible checks, so a contradicted date leads the report.
      const language = projectLanguage();
      const skipped: string[] = [];
      const timeline = getTimeline();
      if (timeline) {
        const timelineCheck = checkTimeline(
          chapter.id,
          content,
          registry,
          bible,
          timeline.events,
          language.rules
        );
        flags.push(...timelineCheck.flags);
        if (timeline.events.some((e) => e.chapterId === chapter.id)) {
          skipped.push(...timelineCheck.skipped);
        }
      }

      const characterCheck = checkCharacters(content, bible, language.rules);
      flags.push(...characterCheck.flags);
      skipped.push(...characterCheck.skipped);

      // Check open plot threads that should be referenced
      const chapterOrder = chapter.order;
      for (const thread of bible.plotThreads) {
        if (thread.status === "open") {
          const openedChapter = registry.chapters.find(
            (c) => c.id === thread.openedIn
          );
          if (
            openedChapter &&
            chapterOrder - openedChapter.order > 5 &&
            !contentLower.includes(normalizeForCompare(thread.title))
          ) {
            flags.push({
              type: "plot_thread",
              severity: "warning",
              description: `Open plot thread "${thread.title}" (opened in ${thread.openedIn}) hasn't been referenced in ${chapterOrder - openedChapter.order} chapters.`,
              suggestion: `Consider weaving in the "${thread.title}" plot thread or resolving it.`,
            });
          }
        }
      }

      let summary: string;
      const errorCount = flags.filter((f) => f.severity === "error").length;
      const warningCount = flags.filter((f) => f.severity === "warning").length;

      if (flags.length === 0) {
        summary = skipped.length
          ? `No continuity issues detected by the checks that ran; ${skipped.length} language-dependent check(s) did not run.`
          : "No continuity issues detected.";
      } else {
        summary = `Found ${errorCount} error(s) and ${warningCount} warning(s).`;
      }

      const eventsForChapter =
        timeline?.events.filter((e) => e.chapterId === chapter.id).length ?? 0;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                flags,
                summary,
                language: language.tag,
                ...(skipped.length ? { checksSkipped: skipped } : {}),
                ...(languageNote(language, skipped)
                  ? { languageNote: languageNote(language, skipped) }
                  : {}),
                timelineEventsForChapter: eventsForChapter,
                ...(timeline && eventsForChapter === 0
                  ? {
                      timelineNote:
                        "No timeline events are logged for this chapter, so its timing was not cross-referenced. Log them with book_timeline_add.",
                    }
                  : {}),
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
