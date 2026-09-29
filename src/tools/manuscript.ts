import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getRegistry,
  getTimeline,
  updateRegistry,
  updateOutlineIfPresent,
  getStoryBible,
  getOutline,
  getNotes,
  initProject,
  readChapterFile,
  writeChapterFile,
  renameChapterFile,
  trashChapterFile,
  getProjectPaths,
} from "../storage/filestore";
import { ChapterMeta, Registry } from "../storage/schema";
import { countWords, estimateReadingTime } from "../utils/wordcount";
import { BookMCPError } from "../utils/errors";
import { normalizeForCompare, slugify, splitParagraphs } from "../utils/text";
import { snapshotIfChanged, trashHistory } from "../storage/history";
import { recordWords, saveChapterContent } from "../storage/writing-log";
import { chaptersInOrder, requireProject, resolveChapter } from "../storage/chapters";
import { assembleBook } from "../export/assemble";
import { measureExtent } from "../export/normseite";
import { isValidLanguageTag, rulesFor, supportedLanguages } from "../lang";

export { resolveChapter, requireProject } from "../storage/chapters";

// Ids must stay unique and stable: the story bible, the timeline and plot
// threads all point at them. Counting chapters is not enough once a chapter in
// the middle has been deleted (3 chapters minus one would hand out "ch-003"
// again), so the highest id ever used decides the next one.
function nextChapterId(registry: Registry): string {
  let highest = 0;
  for (const chapter of registry.chapters) {
    const match = /^ch-(\d+)$/.exec(chapter.id);
    if (match) highest = Math.max(highest, parseInt(match[1], 10));
  }
  return `ch-${String(highest + 1).padStart(3, "0")}`;
}

// A title with no ASCII-representable letters leaves an empty slug, so the id
// alone names the file rather than every such chapter sharing one filename and
// overwriting the previous one.
function chapterFilename(id: string, title: string): string {
  const slug = slugify(title);
  return slug ? `${id}-${slug}.md` : `${id}.md`;
}

// The first ATX heading of a chapter file. "## Scene" does not match: after the
// optional indent the next character must be the only "#".
const H1_PATTERN = /^[ \t]{0,3}#[ \t]+(.+?)[ \t]*#*[ \t]*$/m;

// The exported manuscript is built from the chapter files, not from the
// registry, so a rename that only touched the registry would still export the
// old title. The heading is rewritten when it still spells out the old title;
// a heading the author has customised ("# Kapitel 3 — Der Anfang") is left
// alone and reported instead of being silently overwritten.
function retitleContent(
  content: string,
  oldTitle: string,
  newTitle: string
): { content: string; headingUpdated: boolean } {
  const match = H1_PATTERN.exec(content);
  if (!match) return { content, headingUpdated: false };
  if (normalizeForCompare(match[1]) !== normalizeForCompare(oldTitle)) {
    return { content, headingUpdated: false };
  }

  const heading = match[0];
  const start = match.index;
  return {
    content:
      content.slice(0, start) +
      // A function replacement: a title containing "$&" or "$1" would
      // otherwise be read as a replacement pattern.
      heading.replace(/#[ \t]+.*$/, () => `# ${newTitle}`) +
      content.slice(start + heading.length),
    headingUpdated: true,
  };
}

// The outline stores chapters by title, so a renamed chapter would otherwise
// lose its outline entry. This is called with registry.json already held; the
// registry -> outline order is the only one used anywhere, so it cannot
// deadlock against an outline tool.
async function renameInOutline(oldTitle: string, newTitle: string): Promise<boolean> {
  return updateOutlineIfPresent((outline) => {
    let renamed = false;
    for (const act of outline.acts) {
      for (const chapter of act.chapters) {
        if (normalizeForCompare(chapter.title) === normalizeForCompare(oldTitle)) {
          chapter.title = newTitle;
          renamed = true;
        }
      }
    }
    // Nothing matched, so leave outline.json untouched.
    return renamed ? undefined : false;
  });
}

// Everything that points at a chapter by id or by title, so a delete can say
// what it leaves dangling instead of quietly breaking continuity checks.
function findReferences(chapter: ChapterMeta): string[] {
  const references: string[] = [];

  const bible = getStoryBible();
  if (bible) {
    for (const character of bible.characters) {
      if (character.firstAppearance === chapter.id) {
        references.push(
          `Character "${character.name}" has firstAppearance "${chapter.id}".`
        );
      }
    }
    for (const thread of bible.plotThreads) {
      if (thread.openedIn === chapter.id) {
        references.push(`Plot thread "${thread.title}" opens in "${chapter.id}".`);
      }
      if (thread.resolvedIn === chapter.id) {
        references.push(
          `Plot thread "${thread.title}" resolves in "${chapter.id}".`
        );
      }
    }
  }

  // The timeline moved out of the story bible into timeline.json, but a
  // deleted chapter still leaves its events pointing at nothing.
  const timeline = getTimeline();
  if (timeline) {
    for (const event of timeline.events) {
      if (event.chapterId === chapter.id) {
        references.push(
          `Timeline event "${event.event}" (${event.id}) is set in "${chapter.id}".`
        );
      }
    }
  }

  const notes = (getNotes()?.notes ?? []).filter((n) => n.chapterId === chapter.id);
  if (notes.length) {
    const open = notes.filter((n) => n.status === "open").length;
    references.push(
      `${notes.length} note(s) on this chapter (${open} open) now point at a deleted chapter.`
    );
  }

  const outline = getOutline();
  if (outline) {
    for (const act of outline.acts) {
      for (const outlineChapter of act.chapters) {
        if (
          normalizeForCompare(outlineChapter.title) ===
          normalizeForCompare(chapter.title)
        ) {
          references.push(
            `The outline still contains a chapter titled "${chapter.title}".`
          );
        }
      }
    }
  }

  return references;
}

// Applies a new title to a chapter: registry entry, file name and the heading
// inside the file. Shared by book_chapter_rename and book_chapter_update so
// both routes leave the project in the same state.
async function applyTitle(
  registry: Registry,
  chapter: ChapterMeta,
  newTitle: string,
  options: { updateOutline: boolean }
): Promise<{ warnings: string[]; details: Record<string, unknown> }> {
  const trimmed = newTitle.trim();
  if (!trimmed) throw new BookMCPError("A chapter title cannot be empty.");

  const oldTitle = chapter.title;
  const oldFilename = chapter.filename;
  const warnings: string[] = [];

  const duplicate = registry.chapters.find(
    (c) =>
      c.id !== chapter.id &&
      normalizeForCompare(c.title) === normalizeForCompare(trimmed)
  );
  if (duplicate) {
    warnings.push(
      `Chapter "${duplicate.id}" carries the same title. Both chapters can only be addressed by id from now on.`
    );
  }

  const newFilename = chapterFilename(chapter.id, trimmed);
  const content = readChapterFile(oldFilename);
  const { content: retitled, headingUpdated } = retitleContent(
    content,
    oldTitle,
    trimmed
  );

  // Rename first: it is the step that can fail on a name collision, and
  // failing before anything was written leaves the project untouched.
  const fileRenamed = renameChapterFile(oldFilename, newFilename);
  // Even when nothing was renamed (a chapter registered but never written to
  // disk) the registry points at the name the file will get.
  chapter.filename = newFilename;
  chapter.title = trimmed;
  chapter.updatedAt = new Date().toISOString();

  if (headingUpdated) {
    saveChapterContent(registry, chapter, retitled);
  } else if (content) {
    warnings.push(
      `The heading inside "chapters/${chapter.filename}" does not spell out the old title and was left unchanged. Edit it with book_chapter_update if the export should show the new title.`
    );
  }

  const outlineRenamed = options.updateOutline
    ? await renameInOutline(oldTitle, trimmed)
    : false;

  return {
    warnings,
    details: {
      previousTitle: oldTitle,
      title: trimmed,
      previousFilename: oldFilename,
      filename: chapter.filename,
      fileRenamed,
      headingUpdated,
      outlineUpdated: outlineRenamed,
    },
  };
}

function jsonResult(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

export function registerManuscriptTools(server: McpServer): void {
  // book_init
  server.tool(
    "book_init",
    "Initialize a new book project in the current directory",
    {
      title: z.string().describe("Book title"),
      author: z.string().describe("Author name"),
      genre: z.string().describe("Book genre"),
      targetWordCount: z
        .number()
        .optional()
        .default(80000)
        .describe("Target word count (default: 80000)"),
      language: z
        .string()
        .optional()
        .default("en")
        .describe(
          'Language the book is written in, as a BCP 47 tag: "de", "en", "en-GB", "de-AT" (default: "en"). Decides which rules the style and continuity checks use and what language exports declare — set it for any book not written in English.'
        ),
    },
    async ({ title, author, genre, targetWordCount, language }) => {
      if (!isValidLanguageTag(language)) {
        throw new BookMCPError(
          `"${language}" is not a language tag. Use a BCP 47 tag such as "de", "en" or "en-GB".`
        );
      }
      const registry = initProject(title, author, genre, targetWordCount, language.trim());
      const rules = rulesFor(language);
      const paths = getProjectPaths();
      return jsonResult({
        message: `Book project "${title}" initialized successfully.`,
        paths: {
          registry: paths.registryPath,
          storyBible: paths.storyBiblePath,
          styleGuide: paths.styleGuidePath,
          outline: paths.outlinePath,
          chapters: paths.chaptersDir,
        },
        registry,
        language: rules
          ? `${registry.language} — style and continuity checks use the ${rules.name} rules.`
          : `${registry.language} — no language-specific rules are available (supported: ${supportedLanguages().join(", ")}); checks that depend on the language will say they did not run.`,
      });
    }
  );

  // book_chapter_create
  server.tool(
    "book_chapter_create",
    "Create a new chapter file and register it",
    {
      title: z.string().describe("Chapter title"),
      synopsis: z.string().describe("Brief chapter synopsis"),
      order: z
        .number()
        .optional()
        .describe("Chapter order (auto-appends if omitted)"),
      content: z
        .string()
        .optional()
        .describe("Optional initial draft content"),
      part: z
        .string()
        .optional()
        .describe('The part of the book it belongs to, e.g. "Die Stadt"; consecutive chapters with the same part share a part page'),
      numbered: z
        .boolean()
        .optional()
        .describe("false for a prologue or epilogue that carries no chapter number (default: true)"),
    },
    async ({ title, synopsis, order, content, part, numbered }) => {
      const trimmedTitle = title.trim();
      if (!trimmedTitle)
        throw new BookMCPError("A chapter title cannot be empty.");

      let id!: string;
      let filename!: string;
      let meta!: ChapterMeta;

      // Held from reading the registry to writing it: two chapters created at
      // once would otherwise be handed the same id.
      await updateRegistry((registry) => {
        // The id is independent of the position: two chapters may share an
        // order slot while being reordered.
        id = nextChapterId(registry);
        const chapterNum = order ?? registry.chapters.length + 1;
        filename = chapterFilename(id, trimmedTitle);
        const chapterContent = content || `# ${trimmedTitle}\n\n`;

        meta = {
          id,
          title: trimmedTitle,
          filename,
          status: content ? "draft" : "outline",
          wordCount: 0,
          order: chapterNum,
          synopsis,
          updatedAt: new Date().toISOString(),
          ...(part?.trim() ? { part: part.trim() } : {}),
          ...(numbered === false ? { numbered: false } : {}),
        };
        saveChapterContent(registry, meta, chapterContent);

        registry.chapters.push(meta);
        registry.chapters.sort((a, b) => a.order - b.order);
      });

      return jsonResult({
        message: `Chapter "${trimmedTitle}" created.`,
        chapterId: id,
        filename,
        path: `chapters/${filename}`,
        meta,
      });
    }
  );

  // book_chapter_read
  server.tool(
    "book_chapter_read",
    "Read a chapter's full content plus its metadata. Give fromParagraph and/or toParagraph to read only part of it — useful for a long chapter when only one passage matters.",
    {
      chapterId: z
        .string()
        .describe('Chapter ID (e.g. "ch-001") or chapter title'),
      fromParagraph: z
        .number()
        .optional()
        .describe(
          "First paragraph to return, 1-based. Paragraphs are separated by blank lines, and book_chapter_find reports the number of each match. Omit for the start of the chapter."
        ),
      toParagraph: z
        .number()
        .optional()
        .describe(
          "Last paragraph to return, inclusive. Omit for the end of the chapter."
        ),
    },
    async ({ chapterId, fromParagraph, toParagraph }) => {
      const registry = requireProject();
      const chapter = resolveChapter(registry, chapterId);
      const content = readChapterFile(chapter.filename);

      // Unchanged when neither bound is given: the whole chapter, same shape
      // as before.
      if (fromParagraph === undefined && toParagraph === undefined) {
        return jsonResult({ meta: chapter, content });
      }

      const paragraphs = splitParagraphs(content);
      const total = paragraphs.length;
      const from = fromParagraph ?? 1;
      const to = toParagraph ?? total;

      if (!Number.isInteger(from) || !Number.isInteger(to)) {
        throw new BookMCPError("Paragraph numbers must be whole numbers.");
      }
      if (from < 1 || to < 1) {
        throw new BookMCPError("Paragraph numbers start at 1.");
      }
      // Checked before from > to: with toParagraph left out it defaults to the
      // last paragraph, so an out-of-range start would otherwise be reported
      // as being "after" a bound the caller never passed.
      if (from > total) {
        throw new BookMCPError(
          `Chapter "${chapter.id}" has ${total} paragraph(s), so paragraph ${from} does not exist.`
        );
      }
      if (from > to) {
        throw new BookMCPError(
          `fromParagraph (${from}) is after toParagraph (${to}).`
        );
      }

      const slice = paragraphs.slice(from - 1, Math.min(to, total));
      const text = content.slice(
        slice[0].start,
        slice[slice.length - 1].end
      );

      return jsonResult({
        meta: chapter,
        content: text,
        paragraphRange: {
          from,
          to: Math.min(to, total),
          totalParagraphs: total,
          truncated: from > 1 || to < total,
        },
      });
    }
  );

  // book_chapter_update
  server.tool(
    "book_chapter_update",
    "Update a chapter: content, title, synopsis, status, the part it belongs to, or whether it carries a number. Every field is optional, so it can retitle a chapter without touching its prose.",
    {
      chapterId: z
        .string()
        .describe('Chapter ID (e.g. "ch-001") or current chapter title'),
      content: z
        .string()
        .optional()
        .describe("Full updated chapter content (leave out to keep the prose)"),
      title: z
        .string()
        .optional()
        .describe("New chapter title (renames the file and the heading too)"),
      synopsis: z.string().optional().describe("Updated chapter synopsis"),
      status: z
        .enum(["outline", "draft", "review", "final"])
        .optional()
        .describe("Updated chapter status"),
      part: z
        .string()
        .optional()
        .describe('The part of the book it belongs to ("" takes it out of any part)'),
      numbered: z
        .boolean()
        .optional()
        .describe("false for a prologue or epilogue that carries no chapter number"),
    },
    async ({ chapterId, content, title, synopsis, status, part, numbered }) => {
      if (
        content === undefined &&
        title === undefined &&
        synopsis === undefined &&
        status === undefined &&
        part === undefined &&
        numbered === undefined
      ) {
        throw new BookMCPError(
          "Nothing to update: pass at least one of content, title, synopsis, status, part or numbered."
        );
      }

      const warnings: string[] = [];
      let renameDetails: Record<string, unknown> | undefined;
      let chapter!: ChapterMeta;
      let snapshotTimestamp: string | null = null;

      await updateRegistry(async (registry) => {
        chapter = resolveChapter(registry, chapterId);

        // The previous prose is filed away before anything in this call
        // changes it. This runs ahead of applyTitle because a rename rewrites
        // the heading and moves the file, so a snapshot taken afterwards
        // would already carry part of the new state.
        snapshotTimestamp =
          content !== undefined
            ? snapshotIfChanged(chapter.id, chapter.filename, content)
            : null;

        if (title !== undefined) {
          const result = await applyTitle(registry, chapter, title, {
            updateOutline: true,
          });
          warnings.push(...result.warnings);
          renameDetails = result.details;
        }

        if (content !== undefined) {
          saveChapterContent(registry, chapter, content);
        }
        if (synopsis !== undefined) chapter.synopsis = synopsis;
        if (status) chapter.status = status;
        if (part !== undefined) {
          if (part.trim()) chapter.part = part.trim();
          else delete chapter.part;
        }
        if (numbered !== undefined) {
          if (numbered) delete chapter.numbered;
          else chapter.numbered = false;
        }
        chapter.updatedAt = new Date().toISOString();
      });

      // Marking a chapter final with feedback still open on it is allowed —
      // the author decides — but never silent.
      if (status === "final") {
        const open = (getNotes()?.notes ?? []).filter(
          (n) => n.chapterId === chapter.id && n.status === "open"
        );
        if (open.length) {
          warnings.push(
            `${open.length} open note(s) on this chapter (${[...new Set(open.map((n) => n.source))].join(
              ", "
            )}). See them with book_note_list chapterId="${chapter.id}".`
          );
        }
      }

      return jsonResult({
        message: `Chapter "${chapter.title}" updated.`,
        wordCount: chapter.wordCount,
        meta: chapter,
        ...(snapshotTimestamp
          ? {
              previousVersionSaved: snapshotTimestamp,
              hint: "Use book_chapter_history_list to review earlier versions, or book_chapter_revert to restore one.",
            }
          : {}),
        ...(renameDetails ? { rename: renameDetails } : {}),
        ...(warnings.length ? { warnings } : {}),
      });
    }
  );

  // book_chapter_rename
  server.tool(
    "book_chapter_rename",
    "Rename a chapter: updates the registry, the chapter file name, the heading inside the file and the matching outline entry",
    {
      chapterId: z
        .string()
        .describe('Chapter ID (e.g. "ch-001") or current chapter title'),
      title: z.string().describe("New chapter title"),
      synopsis: z
        .string()
        .optional()
        .describe("Optionally update the synopsis in the same call"),
      updateOutline: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "Also rename the chapter in the outline when it is listed there (default: true)"
        ),
    },
    async ({ chapterId, title, synopsis, updateOutline }) => {
      let chapter!: ChapterMeta;
      let warnings!: string[];
      let details!: Record<string, unknown>;

      await updateRegistry(async (registry) => {
        chapter = resolveChapter(registry, chapterId);
        ({ warnings, details } = await applyTitle(registry, chapter, title, {
          updateOutline,
        }));
        if (synopsis !== undefined) chapter.synopsis = synopsis;
      });

      return jsonResult({
        message: `Chapter "${details.previousTitle}" renamed to "${chapter.title}".`,
        chapterId: chapter.id,
        path: `chapters/${chapter.filename}`,
        ...details,
        meta: chapter,
        ...(warnings.length ? { warnings } : {}),
      });
    }
  );

  // book_chapter_delete
  server.tool(
    "book_chapter_delete",
    "Delete a chapter from the manuscript. The chapter file is moved to .book-mcp/trash/ so it can be recovered by hand.",
    {
      chapterId: z
        .string()
        .describe('Chapter ID (e.g. "ch-001") or chapter title'),
      confirm: z
        .boolean()
        .describe(
          "Must be true. Guards against deleting a chapter by accident — deleting removes prose from the manuscript."
        ),
      keepFile: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Keep the markdown file in chapters/ and only unregister the chapter (default: false)"
        ),
    },
    async ({ chapterId, confirm, keepFile }) => {
      let chapter!: ChapterMeta;
      let references!: string[];
      let trashedPath: string | null = null;
      let trashedHistory: { path: string; count: number } | null = null;
      let remaining!: ChapterMeta[];

      await updateRegistry((registry) => {
        chapter = resolveChapter(registry, chapterId);

        if (!confirm) {
          throw new BookMCPError(
            `Chapter "${chapter.id}" ("${chapter.title}", ${chapter.wordCount} words) was not deleted. Call book_chapter_delete again with confirm=true to delete it.`
          );
        }

        references = findReferences(chapter);
        // The words leave the book either way, so the day's tally shows it.
        recordWords(registry, chapter.id, countWords(readChapterFile(chapter.filename)), 0);
        trashedPath = keepFile ? null : trashChapterFile(chapter.filename);
        // Ids are reused once the highest chapter is deleted, so the revisions
        // go with the chapter rather than waiting for its successor.
        trashedHistory = keepFile ? null : trashHistory(chapter.id);

        registry.chapters = registry.chapters.filter((c) => c.id !== chapter.id);
        // Deleting from the middle leaves a gap, so positions are closed up.
        // Ids stay as they are: the story bible and the timeline point at them.
        registry.chapters.sort((a, b) => a.order - b.order);
        registry.chapters.forEach((c, index) => {
          c.order = index + 1;
        });
        remaining = registry.chapters;
      });

      return jsonResult({
        message: `Chapter "${chapter.title}" (${chapter.id}) deleted.`,
        deleted: {
          id: chapter.id,
          title: chapter.title,
          wordCount: chapter.wordCount,
          status: chapter.status,
        },
        file: keepFile
          ? `Left in place at chapters/${chapter.filename}.`
          : trashedPath
          ? `Moved to ${trashedPath}.`
          : "No chapter file existed on disk.",
        ...(trashedHistory
          ? {
              history: `${trashedHistory.count} saved version(s) moved to ${trashedHistory.path}.`,
            }
          : {}),
        chapters: remaining.map((c) => ({
          id: c.id,
          title: c.title,
          order: c.order,
        })),
        ...(references.length
          ? {
              danglingReferences: references,
              hint: "These still point at the deleted chapter. Update them with the story bible and outline tools.",
            }
          : {}),
      });
    }
  );

  // book_chapter_list
  server.tool(
    "book_chapter_list",
    "List all chapters with status and word counts",
    {},
    async () => {
      const registry = requireProject();

      const table = registry.chapters.map((c) => ({
        id: c.id,
        title: c.title,
        status: c.status,
        wordCount: c.wordCount,
        synopsis: c.synopsis,
        order: c.order,
        ...(c.part ? { part: c.part } : {}),
        ...(c.numbered === false ? { numbered: false } : {}),
      }));

      return jsonResult({ chapters: table });
    }
  );

  // book_chapter_reorder
  server.tool(
    "book_chapter_reorder",
    "Change chapter order",
    {
      chapterId: z
        .string()
        .describe('Chapter ID (e.g. "ch-001") or chapter title'),
      newOrder: z.number().describe("New order position"),
    },
    async ({ chapterId, newOrder }) => {
      let chapter!: ChapterMeta;
      let ordered!: ChapterMeta[];

      await updateRegistry((registry) => {
        chapter = resolveChapter(registry, chapterId);

        const oldOrder = chapter.order;
        for (const c of registry.chapters) {
          if (c.id === chapter.id) {
            c.order = newOrder;
          } else if (oldOrder < newOrder && c.order > oldOrder && c.order <= newOrder) {
            c.order--;
          } else if (oldOrder > newOrder && c.order >= newOrder && c.order < oldOrder) {
            c.order++;
          }
        }
        registry.chapters.sort((a, b) => a.order - b.order);
        ordered = registry.chapters;
      });

      return jsonResult({
        message: `Chapter "${chapter.title}" moved to position ${newOrder}.`,
        chapters: ordered.map((c) => ({
          id: c.id,
          title: c.title,
          order: c.order,
        })),
      });
    }
  );

  // book_stats
  server.tool(
    "book_stats",
    "Return manuscript-wide statistics",
    {},
    async () => {
      const registry = requireProject();

      const totalWordCount = registry.chapters.reduce(
        (sum, c) => sum + c.wordCount,
        0
      );
      const byStatus: Record<string, number> = {};
      for (const c of registry.chapters) {
        byStatus[c.status] = (byStatus[c.status] || 0) + 1;
      }

      // The extent as a publisher quotes it: in Normseiten (30 lines of 60
      // characters) and in characters, counted over the whole book.
      const extent = measureExtent(
        assembleBook(registry, chaptersInOrder(registry), { includeMatter: false })
      );

      return jsonResult({
        totalWordCount,
        targetWordCount: registry.targetWordCount,
        normPages: extent.normPages,
        charactersWithSpaces: extent.characters,
        percentComplete: Math.round(
          (totalWordCount / registry.targetWordCount) * 100
        ),
        chapterCount: registry.chapters.length,
        byStatus,
        estimatedReadingTimeMinutes: estimateReadingTime(totalWordCount),
      });
    }
  );
}
