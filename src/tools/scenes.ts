import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getStoryBible, readChapterFile, updateScenes } from "../storage/filestore";
import { chaptersInOrder, requireProject, resolveChapter } from "../storage/chapters";
import { resolveCharacter } from "../storage/bible";
import { SceneMeta } from "../storage/schema";
import { BookMCPError } from "../utils/errors";
import { normalizeForCompare } from "../utils/text";
import { matchSceneMeta, sceneAnchor, splitScenes } from "../scenes/scenes";
import { describeMeta, listScenes, SCENE_FIELDS } from "../scenes/list";

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

export function registerSceneTools(server: McpServer): void {
  server.tool(
    "book_scene_list",
    "The scenes of a chapter — or of the whole book — as the scene breaks divide them: number, paragraph range, length, opening words, and what has been noted about each (point of view, setting, time, goal, conflict, outcome). Also how the book's words are shared between point-of-view characters.",
    {
      chapterId: z.string().optional().describe("One chapter (id or title); the whole book when left out"),
    },
    async ({ chapterId }) => {
      const registry = requireProject();
      const chapters = chapterId ? [resolveChapter(registry, chapterId)] : chaptersInOrder(registry);
      const { chapters: listed, lost, bible } = listScenes(chapters);

      const pov = new Map<string, { scenes: number; words: number }>();
      let total = 0;
      let described = 0;
      let withoutConflict = 0;
      let words = 0;
      for (const { scenes } of listed) {
        for (const { scene, meta } of scenes) {
          total++;
          words += scene.words;
          if (meta) described++;
          if (meta && !meta.conflict) withoutConflict++;
          const name = meta?.pov
            ? bible?.characters.find((c) => c.id === meta.pov)?.name ?? meta.pov
            : "(not set)";
          const entry = pov.get(name) ?? { scenes: 0, words: 0 };
          entry.scenes++;
          entry.words += scene.words;
          pov.set(name, entry);
        }
      }

      return jsonResult({
        totalScenes: total,
        described,
        pointOfView: [...pov]
          .map(([character, entry]) => ({
            character,
            ...entry,
            share: words ? `${Math.round((entry.words / words) * 100)}%` : "0%",
          }))
          .sort((a, b) => b.words - a.words),
        ...(withoutConflict
          ? {
              withoutConflict: `${withoutConflict} described scene(s) have no conflict noted. A scene without one is often a scene that can go.`,
            }
          : {}),
        chapters: listed.map(({ chapter, scenes }) => ({
          chapterId: chapter.id,
          title: chapter.title,
          scenes: scenes.map(({ scene, meta }) => ({
            scene: scene.index,
            paragraphs:
              scene.firstParagraph === scene.lastParagraph
                ? `${scene.firstParagraph}`
                : `${scene.firstParagraph}–${scene.lastParagraph}`,
            words: scene.words,
            opening: scene.opening,
            ...describeMeta(meta, bible),
          })),
        })),
        ...(lost.length
          ? {
              lostMetadata: lost,
              lostHint:
                "These notes belonged to scenes whose opening words were rewritten or cut. Set them again on the right scene with book_scene_set.",
            }
          : {}),
      });
    }
  );

  server.tool(
    "book_scene_set",
    "Note what a scene is: its point-of-view character, setting, time, the POV character's goal, the conflict in the way, the outcome, a summary. Scenes are numbered by the scene breaks in the chapter (book_scene_list shows them). Given fields replace what was there; an empty string clears one.",
    {
      chapterId: z.string().describe('Chapter ID (e.g. "ch-001") or chapter title'),
      scene: z.number().describe("Scene number within the chapter, 1-based"),
      pov: z.string().optional().describe("Point-of-view character (id, name or alias)"),
      setting: z.string().optional().describe("Where it happens — a setting from the story bible or free text"),
      time: z.string().optional().describe("When it happens, in the story's terms"),
      goal: z.string().optional().describe("What the point-of-view character wants in this scene"),
      conflict: z.string().optional().describe("What stands in the way"),
      outcome: z.string().optional().describe("How it ends for them — the turn into the next scene"),
      summary: z.string().optional().describe("What happens, in a sentence or two"),
    },
    async ({ chapterId, scene: number, pov, ...fields }) => {
      const registry = requireProject();
      const chapter = resolveChapter(registry, chapterId);
      const scenes = splitScenes(readChapterFile(chapter.filename));
      const scene = scenes[number - 1];
      if (!Number.isInteger(number) || !scene) {
        throw new BookMCPError(
          `Chapter ${chapter.id} has ${scenes.length} scene(s); there is no scene ${number}.`
        );
      }
      if (pov === undefined && Object.values(fields).every((v) => v === undefined)) {
        throw new BookMCPError("Nothing to set: pass at least one of pov, setting, time, goal, conflict, outcome or summary.");
      }

      const bible = getStoryBible();
      const povId =
        pov === undefined ? undefined : pov.trim() === "" ? "" : bible ? resolveCharacter(bible, pov).id : pov;
      const setting = fields.setting?.trim();
      const knownSetting =
        setting && bible
          ? bible.settings.find(
              (s) => s.id === setting || normalizeForCompare(s.name) === normalizeForCompare(setting)
            )
          : undefined;

      let meta!: SceneMeta;
      await updateScenes((stored) => {
        const mine = stored.scenes.filter((m) => m.chapterId === chapter.id);
        const matched = matchSceneMeta(scenes, mine).byScene.get(scene.index);
        meta = matched ?? { chapterId: chapter.id, anchor: "", indexHint: scene.index, updatedAt: "" };
        if (!matched) stored.scenes.push(meta);

        // Re-anchored to the scene as it reads now.
        meta.anchor = sceneAnchor(scene.text);
        meta.indexHint = scene.index;
        if (povId !== undefined) {
          if (povId) meta.pov = povId;
          else delete meta.pov;
        }
        for (const field of SCENE_FIELDS) {
          const value = fields[field];
          if (value === undefined) continue;
          if (value.trim()) meta[field] = value.trim();
          else delete meta[field];
        }
        if (fields.setting !== undefined) {
          if (knownSetting) meta.settingId = knownSetting.id;
          else delete meta.settingId;
        }
        meta.updatedAt = new Date().toISOString();
      });

      return jsonResult({
        message: `Scene ${scene.index} of ${chapter.id} ("${chapter.title}") updated.`,
        scene: {
          scene: scene.index,
          opening: scene.opening,
          words: scene.words,
          ...describeMeta(meta, bible),
        },
        ...(setting && !knownSetting
          ? { note: `"${setting}" is not a setting in the story bible; it was kept as text. book_setting_add adds it.` }
          : {}),
      });
    }
  );
}
