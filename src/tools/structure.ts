import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getOutline, getStoryBible, readChapterFile, updateOutline } from "../storage/filestore";
import { requireProject, resolveChapter } from "../storage/chapters";
import { BookMCPError } from "../utils/errors";
import { projectLanguage } from "../lang";
import { splitScenes } from "../scenes/scenes";
import { DEFAULT_TOLERANCE, TEMPLATES, templateById } from "../structure/templates";
import { checkArcs, checkStructure } from "../structure/check";
import { briefSchema, writeReply } from "./brief";

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

const lang = () => (projectLanguage().tag.toLowerCase().startsWith("de") ? "de" : "en");

export function registerStructureTools(server: McpServer): void {
  server.tool(
    "book_structure_templates",
    "The story structures available — three-act, hero's journey, Save the Cat, Freytag's pyramid, seven-point — with their turning points and where each conventionally falls in the book.",
    {},
    async () => {
      const l = lang();
      return jsonResult({
        templates: TEMPLATES.map((t) => ({
          id: t.id,
          name: t.name[l],
          source: t.source,
          beats: t.beats.map((b) => ({
            id: b.id,
            name: b.name[l],
            at: `${Math.round(b.position * 100)}%`,
            description: b.description[l],
          })),
        })),
      });
    }
  );

  server.tool(
    "book_structure_set",
    "Choose the story structure the book follows. Beats already placed carry over when the new structure has a beat of the same id (a midpoint stays a midpoint); pass keepBeats=false to start over.",
    {
      template: z
        .enum(TEMPLATES.map((t) => t.id) as [string, ...string[]])
        .describe("three_act, heros_journey, save_the_cat, freytag, seven_point"),
      keepBeats: z.boolean().optional().default(true),
      brief: briefSchema,
    },
    async ({ template, keepBeats, brief }) => {
      const chosen = templateById(template)!;
      let carried: string[] = [];
      let dropped: string[] = [];
      await updateOutline((outline) => {
        const previous = outline.structure?.beats ?? [];
        const ids = new Set(chosen.beats.map((b) => b.id));
        const kept = keepBeats ? previous.filter((p) => ids.has(p.beat)) : [];
        carried = kept.map((p) => p.beat);
        dropped = previous.filter((p) => !kept.includes(p)).map((p) => p.beat);
        outline.structure = { template, beats: kept };
      });
      const l = lang();
      return writeReply(
        brief,
        {
          message: `The book follows the ${chosen.name[l]}.`,
          beats: chosen.beats.map((b) => ({ id: b.id, name: b.name[l], at: `${Math.round(b.position * 100)}%` })),
          ...(carried.length ? { carriedOver: carried } : {}),
          ...(dropped.length ? { dropped } : {}),
        },
        { id: template, status: "updated" }
      );
    }
  );

  server.tool(
    "book_beat_set",
    "Place a turning point of the chosen structure in the chapter (and, optionally, the scene) where it happens. An empty chapterId removes the placement.",
    {
      beat: z.string().describe('A beat id of the chosen structure, e.g. "midpoint" (book_structure_templates lists them)'),
      chapterId: z.string().describe('Chapter ID or title where the beat happens ("" to remove it)'),
      scene: z.number().optional().describe("The scene within the chapter, when the beat is that precise"),
      note: z.string().optional().describe("What happens there"),
      brief: briefSchema,
    },
    async ({ beat, chapterId, scene, note, brief }) => {
      const registry = requireProject();
      const outline = getOutline();
      const template = outline?.structure ? templateById(outline.structure.template) : undefined;
      if (!template) throw new BookMCPError("Choose a structure first with book_structure_set.");
      const known = template.beats.find((b) => b.id === beat);
      if (!known) {
        throw new BookMCPError(
          `"${beat}" is not a beat of the ${template.name.en}. Its beats: ${template.beats.map((b) => b.id).join(", ")}.`
        );
      }

      const chapter = chapterId.trim() ? resolveChapter(registry, chapterId) : null;
      if (chapter && scene !== undefined) {
        const count = splitScenes(readChapterFile(chapter.filename)).length;
        if (!Number.isInteger(scene) || scene < 1 || scene > count) {
          throw new BookMCPError(`Chapter ${chapter.id} has ${count} scene(s); there is no scene ${scene}.`);
        }
      }

      await updateOutline((o) => {
        const beats = (o.structure ??= { template: template.id, beats: [] }).beats;
        const rest = beats.filter((p) => p.beat !== beat);
        o.structure.beats = chapter
          ? [
              ...rest,
              {
                beat,
                chapterId: chapter.id,
                ...(scene !== undefined ? { scene } : {}),
                ...(note?.trim() ? { note: note.trim() } : {}),
              },
            ]
          : rest;
      });

      return writeReply(
        brief,
        {
          message: chapter
            ? `${known.name[lang()]} placed in ${chapter.id} ("${chapter.title}")${scene ? `, scene ${scene}` : ""}.`
            : `${known.name[lang()]} removed.`,
        },
        { id: beat, status: chapter ? "updated" : "deleted" }
      );
    }
  );

  server.tool(
    "book_structure_check",
    `Where the turning points actually fall, measured in words: each placed beat against its conventional position (±${Math.round(
      DEFAULT_TOLERANCE * 100
    )}% by default), beats placed out of order, beats not placed yet — and the characters' arcs. An unfinished book is measured against its target length.`,
    {
      tolerance: z
        .number()
        .optional()
        .describe(`How far a beat may sit from its place, as a share of the book (default ${DEFAULT_TOLERANCE})`),
    },
    async ({ tolerance }) => {
      const registry = requireProject();
      const report = checkStructure(
        getOutline(),
        registry,
        (c) => readChapterFile(c.filename),
        projectLanguage().tag,
        tolerance ?? DEFAULT_TOLERANCE
      );
      if (!report) throw new BookMCPError("Choose a structure first with book_structure_set.");
      const arcs = checkArcs(getStoryBible());
      return jsonResult({
        ...report,
        beats: report.beats.map((b) => ({
          ...b,
          expected: `${Math.round(b.expected * 100)}%`,
          actual: b.actual === null ? null : `${Math.round(b.actual * 100)}%`,
        })),
        summary: report.findings.length ? report.findings : ["Every placed beat sits where it is expected."],
        ...(arcs.length ? { arcs } : {}),
      });
    }
  );
}
