import { z } from "zod";
import { ToolServer } from "./tool-server";
import { getResearch, updateResearch } from "../storage/filestore";
import { requireProject, resolveChapter } from "../storage/chapters";
import { chapterRef } from "../storage/bible";
import { ResearchEntry } from "../storage/schema";
import { BookMCPError } from "../utils/errors";
import { normalizeForCompare } from "../utils/text";
import { briefSchema, writeReply } from "./brief";

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function newId(existing: ResearchEntry[]): string {
  const taken = new Set(existing.map((e) => e.id));
  const base = `res-${Date.now().toString(36)}`;
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}

/** Chapter references as ids, with a warning for each chapter not written yet. */
function chapterIds(refs: string[] | undefined): { ids: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const ids = (refs ?? []).map((ref) => {
    const r = chapterRef(ref);
    if (r.warning) warnings.push(r.warning);
    return r.id;
  });
  return { ids: [...new Set(ids.filter(Boolean))], warnings };
}

const PREVIEW = 300;

/**
 * Research entries a placeholder's note points at: by id, or by a title or
 * tag the note names. "[RECHERCHE: Gezeiten]" finds the entry on the tides.
 */
export function researchFor(note: string, entries: ResearchEntry[]): { id: string; title: string }[] {
  const needle = normalizeForCompare(note.trim());
  if (!needle) return [];
  return entries
    .filter((e) => {
      if (e.id === note.trim()) return true;
      const title = normalizeForCompare(e.title);
      return (
        title.includes(needle) ||
        needle.includes(title) ||
        e.tags.some((t) => needle.includes(normalizeForCompare(t)))
      );
    })
    .map((e) => ({ id: e.id, title: e.title }));
}

export function registerResearchTools(server: ToolServer): void {
  server.tool(
    "book_research_add",
    "Keep a piece of research — a fact, a source, a quotation, a note from a visit — with the chapters it is used in and tags to find it by. Mark a source bibliography=true to list it in the book's bibliography.",
    {
      title: z.string().describe("What it is about, in a few words"),
      content: z.string().optional().default("").describe("The fact, the excerpt, the note"),
      source: z
        .string()
        .optional()
        .describe('The citation as the bibliography should print it: "Müller, Anna: Der Hafen. Hamburg 1998."'),
      url: z.string().optional(),
      tags: z.array(z.string()).optional().default([]),
      chapters: z.array(z.string()).optional().describe("Chapter ids or titles it is used in"),
      bibliography: z.boolean().optional().default(false).describe("List it in the bibliography"),
      brief: briefSchema,
    },
    async ({ title, content, source, url, tags, chapters, bibliography, brief }) => {
      if (!title.trim()) throw new BookMCPError("A research entry needs a title.");
      requireProject();
      if (bibliography && !source?.trim()) {
        throw new BookMCPError("A bibliography entry needs its citation in source.");
      }
      const { ids, warnings } = chapterIds(chapters);
      const now = new Date().toISOString();
      const entry: ResearchEntry = {
        id: "",
        title: title.trim(),
        content,
        ...(source?.trim() ? { source: source.trim() } : {}),
        ...(url?.trim() ? { url: url.trim() } : {}),
        tags: tags.map((t) => t.trim()).filter(Boolean),
        chapterIds: ids,
        bibliography,
        createdAt: now,
        updatedAt: now,
      };
      await updateResearch((research) => {
        entry.id = newId(research.entries);
        research.entries.push(entry);
      });
      return writeReply(
        brief,
        {
          message: `Research entry "${entry.title}" saved.`,
          entry,
          ...(warnings.length ? { warnings } : {}),
        },
        { id: entry.id, status: "created" }
      );
    }
  );

  server.tool(
    "book_research_list",
    "Find research entries by tag, chapter or text. Content is shortened in a list of several; ask for one by id for all of it.",
    {
      id: z.string().optional().describe("One entry, in full"),
      tag: z.string().optional(),
      chapterId: z.string().optional().describe("Entries used in this chapter (id or title)"),
      query: z.string().optional().describe("Text to look for in title, content, source and tags"),
      bibliographyOnly: z.boolean().optional().default(false),
    },
    async ({ id, tag, chapterId, query, bibliographyOnly }) => {
      const registry = requireProject();
      const all = getResearch()?.entries ?? [];
      if (id) {
        const entry = all.find((e) => e.id === id);
        if (!entry) throw new BookMCPError(`Research entry "${id}" not found.`);
        return jsonResult({ entry });
      }
      const chapter = chapterId ? resolveChapter(registry, chapterId) : null;
      const needle = query ? normalizeForCompare(query) : null;
      const selected = all.filter(
        (e) =>
          (!tag || e.tags.some((t) => normalizeForCompare(t) === normalizeForCompare(tag))) &&
          (!chapter || e.chapterIds.includes(chapter.id)) &&
          (!bibliographyOnly || e.bibliography) &&
          (!needle ||
            [e.title, e.content, e.source ?? "", ...e.tags].some((f) => normalizeForCompare(f).includes(needle)))
      );

      const known = new Set(registry.chapters.map((c) => c.id));
      const byTag: Record<string, number> = {};
      for (const e of selected) for (const t of e.tags) byTag[t] = (byTag[t] ?? 0) + 1;

      return jsonResult({
        count: selected.length,
        byTag,
        entries: selected.map((e) => {
          const missing = e.chapterIds.filter((c) => !known.has(c));
          return {
            ...e,
            content: e.content.length > PREVIEW ? `${e.content.slice(0, PREVIEW)}…` : e.content,
            ...(missing.length ? { missingChapters: missing } : {}),
          };
        }),
      });
    }
  );

  server.tool(
    "book_research_update",
    "Change a research entry. Every field is optional and replaces what was there.",
    {
      id: z.string(),
      title: z.string().optional(),
      content: z.string().optional(),
      source: z.string().optional(),
      url: z.string().optional(),
      tags: z.array(z.string()).optional(),
      chapters: z.array(z.string()).optional().describe("Replaces the chapter list"),
      bibliography: z.boolean().optional(),
      brief: briefSchema,
    },
    async ({ id, chapters, brief, ...fields }) => {
      const { ids, warnings } = chapters ? chapterIds(chapters) : { ids: undefined, warnings: [] };
      let entry!: ResearchEntry;
      await updateResearch((research) => {
        const found = research.entries.find((e) => e.id === id);
        if (!found) throw new BookMCPError(`Research entry "${id}" not found.`);
        if (fields.title !== undefined) {
          if (!fields.title.trim()) throw new BookMCPError("A research entry needs a title.");
          found.title = fields.title.trim();
        }
        if (fields.content !== undefined) found.content = fields.content;
        for (const key of ["source", "url"] as const) {
          const value = fields[key];
          if (value === undefined) continue;
          if (value.trim()) found[key] = value.trim();
          else delete found[key];
        }
        if (fields.tags !== undefined) found.tags = fields.tags.map((t) => t.trim()).filter(Boolean);
        if (ids) found.chapterIds = ids;
        if (fields.bibliography !== undefined) found.bibliography = fields.bibliography;
        if (found.bibliography && !found.source) {
          throw new BookMCPError("A bibliography entry needs its citation in source.");
        }
        found.updatedAt = new Date().toISOString();
        entry = found;
      });
      return writeReply(
        brief,
        { message: `Research entry "${entry.title}" updated.`, entry, ...(warnings.length ? { warnings } : {}) },
        { id: entry.id, status: "updated" }
      );
    }
  );

  server.tool(
    "book_research_delete",
    "Delete a research entry",
    { id: z.string(), brief: briefSchema },
    async ({ id, brief }) => {
      let removed = false;
      await updateResearch((research) => {
        const before = research.entries.length;
        research.entries = research.entries.filter((e) => e.id !== id);
        removed = research.entries.length < before;
        if (!removed) return false;
      });
      if (!removed) throw new BookMCPError(`Research entry "${id}" not found.`);
      return writeReply(brief, { message: `Research entry ${id} deleted.` }, { id, status: "deleted" });
    }
  );
}
