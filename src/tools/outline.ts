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
import { autoLink, chapterFor, compareOutline, entries, entryByTitle } from "../outline/link";
import { briefSchema, writeReply } from "./brief";
import { actSchema, limitSchema, outlineEntryNumber, paginate, resolveAct, wantsPage } from "./paging";

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
      brief: briefSchema,
    },
    async ({ outline, brief }) => {
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

      return writeReply(brief, {
        message: "Outline saved.",
        actCount: acts.length,
        chapterCount: acts.reduce((sum, act) => sum + act.chapters.length, 0),
        ...(report
          ? {
              linkedToChapters: report.alreadyLinked + report.linked.length,
              ...(report.ambiguous.length ? { ambiguous: report.ambiguous } : {}),
            }
          : {}),
      }, { id: "outline", status: "updated" });
    }
  );

  server.tool(
    "book_outline_get",
    "Retrieve the outline, with each entry's manuscript chapter and its status where one has been written. Acts and chapters are numbered. For a long plan, page through it: act for one act, fromChapter to start further in, limit for how many — the reply's page.nextFromChapter continues where it stopped.",
    {
      act: actSchema,
      fromChapter: z
        .union([z.number(), z.string()])
        .optional()
        .describe(
          "Start at this outline chapter: its number (as this tool numbers them, counting on across acts), its title, or the manuscript chapter it stands for (default: the first)"
        ),
      limit: limitSchema,
    },
    async ({ act, fromChapter, limit }) => {
      const outline = getOutline();
      if (!outline)
        throw new BookMCPError("No outline found. Run book_init first.");
      const registry = getRegistry();

      // Numbered across the whole outline, so a number means the same entry
      // on every page and in every act.
      let position = 0;
      const numbered = outline.acts.flatMap((a, index) =>
        a.chapters.map((entry) => ({ number: ++position, item: { entry, act: index } }))
      );
      const actNumber = act !== undefined ? resolveAct(outline, act) : undefined;
      const selection =
        actNumber === undefined ? numbered : numbered.filter((n) => n.item.act === actNumber);
      const from =
        fromChapter === undefined ? undefined : outlineEntryNumber(outline, registry, fromChapter);
      const { items, page } = paginate(selection, from, limit);
      const paged = wantsPage({ act, fromChapter, limit });

      const acts = outline.acts.flatMap((a, index) => {
        const shown = items.filter((n) => n.item.act === index);
        // A page leaves out the acts it has nothing from; the whole outline
        // shows every act, even one still without chapters.
        if (!shown.length && paged) return [];
        return [
          {
            number: index + 1,
            ...(a.act !== undefined ? { act: a.act } : {}),
            chapters: shown.map(({ number, item: { entry } }) => {
              const chapter = registry ? chapterFor(entry, registry) : undefined;
              return {
                number,
                ...entry,
                ...(chapter
                  ? { written: { chapterId: chapter.id, status: chapter.status, wordCount: chapter.wordCount } }
                  : { written: null }),
              };
            }),
          },
        ];
      });

      return jsonResult({
        acts,
        ...(paged
          ? {
              page: {
                ...page,
                ...(actNumber !== undefined
                  ? {
                      act: {
                        number: actNumber + 1,
                        ...(outline.acts[actNumber].act ? { name: outline.acts[actNumber].act } : {}),
                      },
                    }
                  : {}),
              },
            }
          : {}),
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
      brief: briefSchema,
    },
    async ({ chapterTitle, chapterId, synopsis, scenes, linkTo, brief }) => {
      if (chapterTitle === undefined && chapterId === undefined) {
        throw new BookMCPError("Name the entry: pass chapterTitle, or chapterId for a linked entry.");
      }
      const registry = chapterId !== undefined || linkTo ? requireProject() : getRegistry();
      const byChapter = chapterId !== undefined ? resolveChapter(registry!, chapterId) : undefined;
      const link = linkTo ? resolveChapter(registry!, linkTo).id : linkTo;

      let title = chapterTitle ?? "";
      await updateOutline((outline) => {
        const all = entries(outline);
        const found = byChapter
          ? all.find(({ entry }) => registry && chapterFor(entry, registry)?.id === byChapter.id)
          : entryByTitle(all, chapterTitle!);
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

      return writeReply(
        brief,
        { message: `Outline chapter "${title}" updated.` },
        { id: title, status: "updated" }
      );
    }
  );

  server.tool(
    "book_outline_link",
    "Link outline entries to the manuscript chapters written from them, where the title makes it unambiguous — so a rename no longer depends on the two titles staying the same. Reports what it could not link.",
    { brief: briefSchema },
    async ({ brief }) => {
      const registry = requireProject();
      let report!: ReturnType<typeof autoLink>;
      await updateOutline((outline) => {
        report = autoLink(outline, registry);
        if (!report.linked.length) return false;
      });
      return writeReply(
        brief,
        {
          message: report.linked.length
            ? `Linked ${report.linked.length} outline entr${report.linked.length === 1 ? "y" : "ies"}.`
            : "Nothing new to link.",
          ...report,
          ...(report.ambiguous.length
            ? {
                hint: "Link these by hand with book_outline_update_chapter chapterTitle=... linkTo=<chapter id>.",
              }
            : {}),
        },
        { id: "outline", status: report.linked.length ? "updated" : "unchanged" }
      );
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
