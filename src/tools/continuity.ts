import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getRegistry,
  getStoryBible,
  getStyleGuide,
  getTimeline,
  readChapterFile,
} from "../storage/filestore";
import { checkTimeline } from "./timeline-continuity";
import { BookMCPError } from "../utils/errors";
import { resolveChapter } from "../storage/chapters";
import { languageNote, projectLanguage } from "../lang";
import { checkCharacters, checkScenePov, checkThreads } from "./continuity-rules";
import { classifyPov } from "./style-rules";
import { listScenes } from "../scenes/list";

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

      // Each scene against its noted point of view, in a third-person book.
      const guide = getStyleGuide();
      if (guide && classifyPov(guide.pov) === "third") {
        const [listed] = listScenes([chapter], () => content).chapters;
        flags.push(...checkScenePov(listed.scenes, bible));
      }

      // Open plot threads left resting too long.
      flags.push(
        ...checkThreads(chapter, registry.chapters, bible, (c) =>
          c.id === chapter.id ? content : readChapterFile(c.filename)
        )
      );

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
