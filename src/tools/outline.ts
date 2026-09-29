import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getOutline,
  getRegistry,
  updateOutline,
  writeOutline,
} from "../storage/filestore";
import { resolveChapter, requireProject } from "../storage/chapters";
import { Outline } from "../storage/schema";
import { BookMCPError } from "../utils/errors";
import { normalizeForCompare } from "../utils/text";
import { autoLink, chapterFor, compareOutline, entries } from "../outline/link";

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

export function registerOutlineTools(server: McpServer): void {
  server.tool(
    "book_outline_set",
    "Set or replace the full hierarchical outline. An entry can name the manuscript chapter it stands for (chapterId); entries whose title matches exactly one chapter are linked automatically.",
    {
      outline: z
        .array(
          z.object({
            act: z.string().optional().describe("Act name"),
            chapters: z.array(
              z.object({
                title: z.string().describe("Chapter title"),
                synopsis: z.string().describe("Chapter synopsis"),
                scenes: z.array(z.string()).optional().describe("Scene list"),
                chapterId: z
                  .string()
                  .optional()
                  .describe("The manuscript chapter this entry stands for (id or title), once it exists"),
              })
            ),
          })
        )
        .describe("Hierarchical outline with acts and chapters"),
    },
    async ({ outline }) => {
      const registry = getRegistry();
      const acts: Outline["acts"] = outline.map((act) => ({
        ...(act.act !== undefined ? { act: act.act } : {}),
        chapters: act.chapters.map((entry) => {
          if (entry.chapterId === undefined) {
            const { chapterId: _drop, ...rest } = entry;
            return rest;
          }
          if (!registry) throw new BookMCPError("No book project found. Run book_init first.");
          return { ...entry, chapterId: resolveChapter(registry, entry.chapterId).id };
        }),
      }));

      const linkedIds = acts.flatMap((a) => a.chapters.map((c) => c.chapterId).filter(Boolean));
      if (new Set(linkedIds).size !== linkedIds.length) {
        throw new BookMCPError("Two outline entries are linked to the same chapter.");
      }

      const next: Outline = { acts };
      const report = registry ? autoLink(next, registry) : null;
      await writeOutline(next);

      return jsonResult({
        message: "Outline saved.",
        actCount: acts.length,
        chapterCount: acts.reduce((sum, act) => sum + act.chapters.length, 0),
        ...(report
          ? {
              linkedToChapters: report.alreadyLinked + report.linked.length,
              ...(report.ambiguous.length ? { ambiguous: report.ambiguous } : {}),
            }
          : {}),
      });
    }
  );

  server.tool(
    "book_outline_get",
    "Retrieve the full outline, with each entry's manuscript chapter and its status where one has been written",
    {},
    async () => {
      const outline = getOutline();
      if (!outline)
        throw new BookMCPError("No outline found. Run book_init first.");
      const registry = getRegistry();

      return jsonResult({
        acts: outline.acts.map((act) => ({
          ...(act.act !== undefined ? { act: act.act } : {}),
          chapters: act.chapters.map((entry) => {
            const chapter = registry ? chapterFor(entry, registry) : undefined;
            return {
              ...entry,
              ...(chapter
                ? { written: { chapterId: chapter.id, status: chapter.status, wordCount: chapter.wordCount } }
                : { written: null }),
            };
          }),
        })),
      });
    }
  );

  server.tool(
    "book_outline_update_chapter",
    "Update one outline entry — its synopsis, scenes, or the manuscript chapter it is linked to. Find it by its title, or by the chapter it is linked to.",
    {
      chapterTitle: z
        .string()
        .optional()
        .describe("The outline entry's title"),
      chapterId: z
        .string()
        .optional()
        .describe("Or: the manuscript chapter (id or title) the entry is linked to"),
      synopsis: z.string().optional().describe("New synopsis"),
      scenes: z.array(z.string()).optional().describe("New scene list"),
      linkTo: z
        .string()
        .optional()
        .describe('Link the entry to this manuscript chapter (id or title); "" removes the link'),
    },
    async ({ chapterTitle, chapterId, synopsis, scenes, linkTo }) => {
      if (chapterTitle === undefined && chapterId === undefined) {
        throw new BookMCPError("Name the entry: pass chapterTitle, or chapterId for a linked entry.");
      }
      const registry = chapterId !== undefined || linkTo ? requireProject() : getRegistry();
      const byChapter = chapterId !== undefined ? resolveChapter(registry!, chapterId) : undefined;
      const link = linkTo ? resolveChapter(registry!, linkTo).id : linkTo;

      let title = chapterTitle ?? "";
      await updateOutline((outline) => {
        const found = entries(outline).find(({ entry }) =>
          byChapter
            ? registry && chapterFor(entry, registry)?.id === byChapter.id
            : normalizeForCompare(entry.title) === normalizeForCompare(chapterTitle!)
        );
        if (!found) {
          throw new BookMCPError(
            byChapter
              ? `No outline entry stands for ${byChapter.id} ("${byChapter.title}").`
              : `Chapter "${chapterTitle}" not found in outline.`
          );
        }
        const entry = found.entry;
        title = entry.title;
        if (synopsis !== undefined) entry.synopsis = synopsis;
        if (scenes !== undefined) entry.scenes = scenes;
        if (link !== undefined) {
          if (link) {
            const taken = entries(outline).find(({ entry: e }) => e !== entry && e.chapterId === link);
            if (taken) {
              throw new BookMCPError(`${link} is already linked to the outline entry "${taken.entry.title}".`);
            }
            entry.chapterId = link;
          } else {
            delete entry.chapterId;
          }
        }
      });

      return jsonResult({ message: `Outline chapter "${title}" updated.` });
    }
  );

  server.tool(
    "book_outline_link",
    "Link outline entries to the manuscript chapters written from them, where the title makes it unambiguous — so a rename no longer depends on the two titles staying the same. Reports what it could not link.",
    {},
    async () => {
      const registry = requireProject();
      let report!: ReturnType<typeof autoLink>;
      await updateOutline((outline) => {
        report = autoLink(outline, registry);
        if (!report.linked.length) return false;
      });
      return jsonResult({
        message: report.linked.length
          ? `Linked ${report.linked.length} outline entr${report.linked.length === 1 ? "y" : "ies"}.`
          : "Nothing new to link.",
        ...report,
        ...(report.ambiguous.length
          ? {
              hint: "Link these by hand with book_outline_update_chapter chapterTitle=... linkTo=<chapter id>.",
            }
          : {}),
      });
    }
  );

  server.tool(
    "book_outline_compare",
    "Compare the plan with what was written: outline entries with no chapter yet, chapters the outline does not mention, chapters that moved, and where plan and chapter now describe a chapter differently.",
    {},
    async () => {
      const registry = requireProject();
      const outline = getOutline();
      if (!outline) throw new BookMCPError("No outline found. Set one with book_outline_set.");
      const comparison = compareOutline(outline, registry);
      const clean =
        !comparison.notWritten.length &&
        !comparison.notPlanned.length &&
        !comparison.moved.length &&
        !comparison.retitled.length;
      return jsonResult({
        ...comparison,
        summary: clean
          ? "The manuscript follows the outline."
          : [
              comparison.notWritten.length && `${comparison.notWritten.length} planned chapter(s) not written yet`,
              comparison.notPlanned.length && `${comparison.notPlanned.length} chapter(s) not in the plan`,
              comparison.moved.length && `${comparison.moved.length} chapter(s) in a different place than planned`,
              comparison.retitled.length && `${comparison.retitled.length} chapter(s) retitled since planning`,
            ]
              .filter(Boolean)
              .join("; ") + ".",
      });
    }
  );
}
