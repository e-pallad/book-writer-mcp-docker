import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getRegistry,
  saveRegistry,
  initProject,
  readChapterFile,
  writeChapterFile,
  getProjectPaths,
} from "../storage/filestore";
import { ChapterMeta } from "../storage/schema";
import { countWords, estimateReadingTime } from "../utils/wordcount";
import { BookMCPError } from "../utils/errors";

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
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
    },
    async ({ title, author, genre, targetWordCount }) => {
      const registry = initProject(title, author, genre, targetWordCount);
      const paths = getProjectPaths();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                message: `Book project "${title}" initialized successfully.`,
                paths: {
                  registry: paths.registryPath,
                  storyBible: paths.storyBiblePath,
                  styleGuide: paths.styleGuidePath,
                  outline: paths.outlinePath,
                  chapters: paths.chaptersDir,
                },
                registry,
              },
              null,
              2
            ),
          },
        ],
      };
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
    },
    async ({ title, synopsis, order, content }) => {
      const registry = getRegistry();
      if (!registry)
        throw new BookMCPError(
          "No book project found. Run book_init first."
        );

      const chapterNum = order ?? registry.chapters.length + 1;
      const id = `ch-${String(chapterNum).padStart(3, "0")}`;
      const filename = `${id}-${slugify(title)}.md`;
      const chapterContent = content || `# ${title}\n\n`;

      writeChapterFile(filename, chapterContent);

      const meta: ChapterMeta = {
        id,
        title,
        filename,
        status: content ? "draft" : "outline",
        wordCount: countWords(chapterContent),
        order: chapterNum,
        synopsis,
        updatedAt: new Date().toISOString(),
      };

      registry.chapters.push(meta);
      registry.chapters.sort((a, b) => a.order - b.order);
      saveRegistry(registry);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                message: `Chapter "${title}" created.`,
                chapterId: id,
                filename,
                path: `chapters/${filename}`,
                meta,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // book_chapter_read
  server.tool(
    "book_chapter_read",
    "Read a chapter's full content plus its metadata",
    {
      chapterId: z
        .string()
        .describe('Chapter ID (e.g. "ch-001") or chapter title'),
    },
    async ({ chapterId }) => {
      const registry = getRegistry();
      if (!registry)
        throw new BookMCPError("No book project found. Run book_init first.");

      const chapter = registry.chapters.find(
        (c) =>
          c.id === chapterId ||
          c.title.toLowerCase() === chapterId.toLowerCase()
      );
      if (!chapter)
        throw new BookMCPError(`Chapter "${chapterId}" not found.`);

      const content = readChapterFile(chapter.filename);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ meta: chapter, content }, null, 2),
          },
        ],
      };
    }
  );

  // book_chapter_update
  server.tool(
    "book_chapter_update",
    "Write updated content to a chapter file",
    {
      chapterId: z.string().describe("Chapter ID"),
      content: z.string().describe("Full updated chapter content"),
      status: z
        .enum(["outline", "draft", "review", "final"])
        .optional()
        .describe("Updated chapter status"),
    },
    async ({ chapterId, content, status }) => {
      const registry = getRegistry();
      if (!registry)
        throw new BookMCPError("No book project found. Run book_init first.");

      const chapter = registry.chapters.find((c) => c.id === chapterId);
      if (!chapter)
        throw new BookMCPError(`Chapter "${chapterId}" not found.`);

      writeChapterFile(chapter.filename, content);
      chapter.wordCount = countWords(content);
      if (status) chapter.status = status;
      chapter.updatedAt = new Date().toISOString();
      saveRegistry(registry);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                message: `Chapter "${chapter.title}" updated.`,
                wordCount: chapter.wordCount,
                meta: chapter,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // book_chapter_list
  server.tool(
    "book_chapter_list",
    "List all chapters with status and word counts",
    {},
    async () => {
      const registry = getRegistry();
      if (!registry)
        throw new BookMCPError("No book project found. Run book_init first.");

      const table = registry.chapters.map((c) => ({
        id: c.id,
        title: c.title,
        status: c.status,
        wordCount: c.wordCount,
        synopsis: c.synopsis,
        order: c.order,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ chapters: table }, null, 2),
          },
        ],
      };
    }
  );

  // book_chapter_reorder
  server.tool(
    "book_chapter_reorder",
    "Change chapter order",
    {
      chapterId: z.string().describe("Chapter ID to reorder"),
      newOrder: z.number().describe("New order position"),
    },
    async ({ chapterId, newOrder }) => {
      const registry = getRegistry();
      if (!registry)
        throw new BookMCPError("No book project found. Run book_init first.");

      const chapter = registry.chapters.find((c) => c.id === chapterId);
      if (!chapter)
        throw new BookMCPError(`Chapter "${chapterId}" not found.`);

      const oldOrder = chapter.order;
      for (const c of registry.chapters) {
        if (c.id === chapterId) {
          c.order = newOrder;
        } else if (oldOrder < newOrder && c.order > oldOrder && c.order <= newOrder) {
          c.order--;
        } else if (oldOrder > newOrder && c.order >= newOrder && c.order < oldOrder) {
          c.order++;
        }
      }
      registry.chapters.sort((a, b) => a.order - b.order);
      saveRegistry(registry);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                message: `Chapter "${chapter.title}" moved to position ${newOrder}.`,
                chapters: registry.chapters.map((c) => ({
                  id: c.id,
                  title: c.title,
                  order: c.order,
                })),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // book_stats
  server.tool(
    "book_stats",
    "Return manuscript-wide statistics",
    {},
    async () => {
      const registry = getRegistry();
      if (!registry)
        throw new BookMCPError("No book project found. Run book_init first.");

      const totalWordCount = registry.chapters.reduce(
        (sum, c) => sum + c.wordCount,
        0
      );
      const byStatus: Record<string, number> = {};
      for (const c of registry.chapters) {
        byStatus[c.status] = (byStatus[c.status] || 0) + 1;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                totalWordCount,
                targetWordCount: registry.targetWordCount,
                percentComplete: Math.round(
                  (totalWordCount / registry.targetWordCount) * 100
                ),
                chapterCount: registry.chapters.length,
                byStatus,
                estimatedReadingTimeMinutes: estimateReadingTime(totalWordCount),
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
