// Scenes with their metadata, for the scene tools, the continuity check and
// the dashboard alike.

import { getScenes, getStoryBible, readChapterFile } from "../storage/filestore";
import { ChapterMeta, SceneMeta, StoryBible } from "../storage/schema";
import { matchSceneMeta, Scene, splitScenes } from "./scenes";

export const SCENE_FIELDS = ["setting", "time", "goal", "conflict", "outcome", "summary"] as const;

/** A scene's metadata as a reader wants it: the POV by name, only what is set. */
export function describeMeta(meta: SceneMeta | undefined, bible: StoryBible | null): Record<string, string> {
  if (!meta) return {};
  const pov = meta.pov ? bible?.characters.find((c) => c.id === meta.pov) : undefined;
  return {
    ...(meta.pov ? { pov: pov ? pov.name : `${meta.pov} (no longer in the story bible)` } : {}),
    ...Object.fromEntries(
      SCENE_FIELDS.filter((f) => meta[f]).map((f) => [f, meta[f] as string])
    ),
  };
}

export interface ListedChapter {
  chapter: ChapterMeta;
  scenes: { scene: Scene; meta?: SceneMeta }[];
}

/** The scenes of some chapters, each with its metadata, plus what went missing. */
export function listScenes(
  chapters: ChapterMeta[],
  textOf: (chapter: ChapterMeta) => string = (c) => readChapterFile(c.filename)
): {
  chapters: ListedChapter[];
  lost: ({ chapterId: string; anchor: string } & Record<string, string>)[];
  bible: StoryBible | null;
} {
  const bible = getStoryBible();
  const stored = getScenes()?.scenes ?? [];
  const lost: ({ chapterId: string; anchor: string } & Record<string, string>)[] = [];

  const listed = chapters.map((chapter) => {
    const scenes = splitScenes(textOf(chapter));
    const matched = matchSceneMeta(
      scenes,
      stored.filter((m) => m.chapterId === chapter.id)
    );
    for (const meta of matched.lost) {
      lost.push({ chapterId: chapter.id, anchor: meta.anchor, ...describeMeta(meta, bible) });
    }
    return {
      chapter,
      scenes: scenes.map((scene) => ({ scene, meta: matched.byScene.get(scene.index) })),
    };
  });
  return { chapters: listed, lost, bible };
}
