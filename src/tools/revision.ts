import { z } from "zod";
import { ToolServer } from "./tool-server";
import { getStoryBible, getStylesheet, readChapterFile, updateRegistry, updateStylesheet } from "../storage/filestore";
import { chaptersInOrder, requireProject, resolveChapter } from "../storage/chapters";
import { ChapterMeta, RevisionPass } from "../storage/schema";
import { BookMCPError } from "../utils/errors";
import { normalizeForCompare } from "../utils/text";
import { languageNote, projectLanguage } from "../lang";
import { donePasses, PASS_INFO, PASSES, passesOutOfOrder } from "../revision/passes";
import { checkQuotes, checkStylesheet } from "../revision/stylesheet";
import { analyzeProse } from "../prose/analyze";
import { briefSchema, chapterBrief, writeReply } from "./brief";

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

const PASS_SCHEMA = z
  .enum(PASSES as [RevisionPass, ...RevisionPass[]])
  .describe("structural (structure, Entwicklungslektorat), line (scene and style, Stillektorat), copy (Korrektorat), proof (Schlusskorrektur)");

const lang = () => (projectLanguage().tag.toLowerCase().startsWith("de") ? "de" : "en");

export function registerRevisionTools(server: ToolServer): void {
  // ---------------------------------------------------------------------------
  // Passes

  server.tool(
    "book_revision_checklist",
    "What a revision pass looks at, as a checklist in the book's language, and which tools help with it. Revise from the large to the small: structural, then line, then copy, then proof.",
    { pass: PASS_SCHEMA },
    async ({ pass }) => {
      const info = PASS_INFO[pass];
      const l = lang();
      return jsonResult({
        pass,
        name: info.name[l],
        order: `${PASSES.indexOf(pass) + 1} of ${PASSES.length}: ${PASSES.join(" → ")}`,
        checklist: info.checklist[l],
        tools: info.tools,
      });
    }
  );

  server.tool(
    "book_revision_mark",
    "Record that a revision pass is done for one or more chapters — or undo that with done=false.",
    {
      pass: PASS_SCHEMA,
      chapters: z.array(z.string()).describe('Chapter ids or titles, or ["all"]'),
      done: z.boolean().optional().default(true),
      note: z.string().optional().describe("What was done"),
      brief: briefSchema,
    },
    async ({ pass, chapters, done, note, brief }) => {
      const warnings: string[] = [];
      let marked: ChapterMeta[] = [];
      await updateRegistry((registry) => {
        const targets =
          chapters.length === 1 && chapters[0].toLowerCase() === "all"
            ? registry.chapters
            : chapters.map((ref) => resolveChapter(registry, ref));
        for (const chapter of targets) {
          const rest = (chapter.passes ?? []).filter((p) => p.pass !== pass);
          chapter.passes = done
            ? [...rest, { pass, at: new Date().toISOString(), ...(note?.trim() ? { note: note.trim() } : {}) }]
            : rest;
          if (!chapter.passes.length) delete chapter.passes;
          const early = passesOutOfOrder(chapter);
          if (done && early.includes(pass)) {
            const missing = PASSES.slice(0, PASSES.indexOf(pass)).filter((p) => !donePasses(chapter).has(p));
            warnings.push(`${chapter.id}: ${pass} marked before ${missing.join(", ")}.`);
          }
        }
        marked = targets;
      });
      return writeReply(
        brief,
        {
          message: `${done ? "Marked" : "Unmarked"} the ${pass} pass for ${marked.length} chapter(s).`,
          chapters: marked.map((c) => c.id),
          ...(warnings.length
            ? {
                warnings,
                hint: "A later pass before an earlier one risks polishing text the earlier pass will change.",
              }
            : {}),
        },
        { chapters: marked.map(chapterBrief) }
      );
    }
  );

  server.tool(
    "book_revision_status",
    "Where the revision stands: which pass each chapter has had, how far each pass has got across the book, and which pass comes next.",
    {},
    async () => {
      const registry = requireProject();
      const chapters = chaptersInOrder(registry);
      const rows = chapters.map((chapter) => {
        const done = donePasses(chapter);
        const early = passesOutOfOrder(chapter);
        return {
          chapterId: chapter.id,
          title: chapter.title,
          ...Object.fromEntries(PASSES.map((p) => [p, done.has(p)])),
          ...(early.length ? { outOfOrder: early } : {}),
        };
      });
      const progress = Object.fromEntries(
        PASSES.map((p) => [p, `${chapters.filter((c) => donePasses(c).has(p)).length}/${chapters.length}`])
      );
      const next = PASSES.find((p) => chapters.some((c) => !donePasses(c).has(p)));
      const l = lang();
      return jsonResult({
        progress,
        next: next
          ? {
              pass: next,
              name: PASS_INFO[next].name[l],
              chapters: chapters.filter((c) => !donePasses(c).has(next)).map((c) => c.id),
            }
          : null,
        chapters: rows,
      });
    }
  );

  // ---------------------------------------------------------------------------
  // Style sheet

  server.tool(
    "book_stylesheet_add",
    "Add a spelling to the copy-edit style sheet: the form the book uses, and the variants it should not (\"E-Mail\", not \"Email\" or \"eMail\"). Adding a preferred form that is already there replaces its entry.",
    {
      preferred: z.string().describe("The spelling the book uses"),
      variants: z.array(z.string()).describe("Spellings to find and replace"),
      note: z.string().optional(),
      caseSensitive: z.boolean().optional().default(true).describe("Treat 'email' and 'Email' as different (default: true)"),
      brief: briefSchema,
    },
    async ({ preferred, variants, note, caseSensitive, brief }) => {
      const cleaned = variants.map((v) => v.trim()).filter((v) => v && v !== preferred.trim());
      if (!preferred.trim() || !cleaned.length) {
        throw new BookMCPError("Give the preferred spelling and at least one variant that differs from it.");
      }
      let replaced = false;
      const sheet = await updateStylesheet((s) => {
        const before = s.entries.length;
        s.entries = s.entries.filter((e) => normalizeForCompare(e.preferred) !== normalizeForCompare(preferred));
        replaced = s.entries.length < before;
        s.entries.push({
          preferred: preferred.trim(),
          variants: cleaned,
          ...(note?.trim() ? { note: note.trim() } : {}),
          ...(caseSensitive ? {} : { caseSensitive: false }),
        });
      });
      return writeReply(
        brief,
        { message: `"${preferred.trim()}" added to the style sheet.`, entries: sheet.entries },
        { id: preferred.trim(), status: replaced ? "updated" : "created" }
      );
    }
  );

  server.tool(
    "book_stylesheet_list",
    "The copy-edit style sheet",
    {},
    async () => jsonResult({ entries: getStylesheet()?.entries ?? [] })
  );

  server.tool(
    "book_stylesheet_remove",
    "Remove an entry from the style sheet",
    { preferred: z.string(), brief: briefSchema },
    async ({ preferred, brief }) => {
      let removed = false;
      await updateStylesheet((s) => {
        const before = s.entries.length;
        s.entries = s.entries.filter((e) => normalizeForCompare(e.preferred) !== normalizeForCompare(preferred));
        removed = s.entries.length < before;
        if (!removed) return false;
      });
      if (!removed) throw new BookMCPError(`"${preferred}" is not in the style sheet.`);
      return writeReply(
        brief,
        { message: `"${preferred}" removed from the style sheet.` },
        { id: preferred, status: "deleted" }
      );
    }
  );

  server.tool(
    "book_stylesheet_check",
    "Check the whole book against the style sheet — every variant spelling still in the text, with where it is — and for mixed or typewriter quotation marks.",
    { chapters: z.array(z.string()).optional().describe("Chapter ids or titles (default: every chapter)") },
    async ({ chapters }) => {
      const registry = requireProject();
      const selected = chapters?.length
        ? chapters.map((ref) => resolveChapter(registry, ref))
        : chaptersInOrder(registry);
      const texts = selected.map((c) => ({ id: c.id, text: readChapterFile(c.filename) }));
      const sheet = getStylesheet() ?? { entries: [] };
      const variants = checkStylesheet(sheet, texts);
      const quotes = checkQuotes(texts.map((t) => t.text), projectLanguage().tag);
      return jsonResult({
        entries: sheet.entries.length,
        variants: variants.map((v) => ({
          ...v,
          fix: `book_replace_text oldText="${v.variant}" newText="${v.preferred}" wholeWord=true`,
        })),
        quotes,
        summary:
          !variants.length && !quotes.hints.length
            ? "Consistent: no variant spellings, one kind of quotation mark."
            : `${variants.reduce((s, v) => s + v.count, 0)} variant spelling(s)${quotes.hints.length ? ", and quotation marks to look at" : ""}.`,
        ...(sheet.entries.length ? {} : { hint: "The style sheet is empty. Add spellings with book_stylesheet_add." }),
      });
    }
  );

  // ---------------------------------------------------------------------------
  // Prose

  server.tool(
    "book_prose_check",
    "Line-edit analysis of a chapter or a passage: filler words, words echoed within a few lines, sentence lengths (average, spread, the longest), long paragraphs, the share of dialogue, and — in English — adverbs. Hints for revising, not errors.",
    {
      chapterId: z.string().optional().describe("Chapter ID or title"),
      passage: z.string().optional().describe("Or a passage of text"),
    },
    async ({ chapterId, passage }) => {
      if ((chapterId === undefined) === (passage === undefined)) {
        throw new BookMCPError("Pass either chapterId or passage.");
      }
      const registry = requireProject();
      const language = projectLanguage();
      if (!language.rules) {
        return jsonResult({
          checked: false,
          languageNote: languageNote(language, ["fillerWords", "repetitions", "sentenceLength"]),
        });
      }
      const chapter = chapterId ? resolveChapter(registry, chapterId) : null;
      const text = chapter ? readChapterFile(chapter.filename) : passage!;
      // The cast's names repeat by nature; they are not echoes.
      const names = (getStoryBible()?.characters ?? []).flatMap((c) => [c.name, ...c.aliases]);
      const report = analyzeProse(text, language.rules, names);
      return jsonResult({
        ...(chapter ? { chapterId: chapter.id, title: chapter.title } : {}),
        language: language.tag,
        ...report,
        ...(report.hints.length ? {} : { hints: ["Nothing stands out."] }),
      });
    }
  );
}
