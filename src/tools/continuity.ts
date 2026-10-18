import { z } from "zod";
import { ToolServer } from "./tool-server";
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
import {
  CharacterFlag,
  ThreadFlag,
  checkCharacters,
  checkScenePov,
  checkThreads,
} from "./continuity-rules";
import { TimelineFlag } from "./timeline-continuity";
import { SettingFlag, checkSceneSettings } from "./continuity-settings";
import { checkLinks } from "../links/check";
import {
  chapterFileExists,
  getNotes,
  getOutline,
  getResearch,
  getScenes,
  trashedChapterIds,
} from "../storage/filestore";
import { classifyPov } from "./style-rules";
import { listScenes } from "../scenes/list";

// Each flag is prose for a person plus fields for the model (see
// continuity-flag.ts): `code`, `chapterId`, `entities`, `evidence`, `repair`.
type ContinuityFlag = CharacterFlag | TimelineFlag | ThreadFlag | SettingFlag;

export function registerContinuityTools(server: ToolServer): void {
  server.tool(
    "book_continuity_check",
    "Cross-reference a chapter draft against the story bible, the timeline and the scene notes. Every flag has a stable `code`, the ids involved (`entities`), the passage that triggered it (`evidence`, with its paragraph number for book_chapter_read) and, where a tool repairs it, the call (`repair`; `choose` is the argument the author must decide — a flag never guesses between fixing the prose and fixing the record). `brokenReferences` counts ids in other records that point at nothing (book_links_check lists them).",
    {
      chapterId: z.string().describe('Chapter ID (e.g. "ch-001"), chapter title, or "#N" for the Nth chapter in reading order'),
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

      const characterCheck = checkCharacters(content, bible, language.rules, chapter.id);
      flags.push(...characterCheck.flags);
      skipped.push(...characterCheck.skipped);

      const [listed] = listScenes([chapter], () => content).chapters;

      // Each scene against its noted point of view, in a third-person book.
      const guide = getStyleGuide();
      if (guide && classifyPov(guide.pov) === "third") {
        flags.push(...checkScenePov(listed.scenes, bible, chapter.id));
      }

      // Each scene against the place it is noted at.
      flags.push(...checkSceneSettings(content, listed.scenes, bible, language.rules, chapter.id));

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

      // References to or from this chapter that no longer resolve: not a
      // continuity flag, but every check above trusts them.
      const links = checkLinks({
        registry,
        bible,
        timeline,
        outline: getOutline(),
        notes: getNotes(),
        scenes: getScenes(),
        research: getResearch(),
        fileExists: chapterFileExists,
        trashed: trashedChapterIds(),
        lostScenes: [],
      });
      const brokenReferences = links.issues.filter(
        (i) => i.severity === "error" && (i.chapterId === chapter.id || i.from.id === chapter.id)
      ).length;

      const eventsForChapter =
        timeline?.events.filter((e) => e.chapterId === chapter.id).length ?? 0;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                chapterId: chapter.id,
                flags,
                summary,
                ...(brokenReferences
                  ? {
                      brokenReferences,
                      brokenReferencesNote: `${brokenReferences} reference(s) to or from this chapter point at nothing, so the checks above may be working from stale ids. Run book_links_check with chapterId="${chapter.id}".`,
                    }
                  : {}),
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
