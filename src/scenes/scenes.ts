// Scenes: the stretches of a chapter between its scene breaks. Classic
// drafting thinks in scenes — one point of view, one place, one time; a goal,
// a conflict, a turn — and a chapter is only the container they are grouped
// into. Nothing about a scene is stored with the text; its metadata is kept
// apart and anchored to the scene's opening words.

import { SceneMeta } from "../storage/schema";
import { isSceneBreakLine } from "../utils/markdown";
import { paragraphNumberAt, toNFC } from "../utils/text";
import { condense } from "../utils/match";
import { countWords } from "../utils/wordcount";

export interface Scene {
  /** 1-based within the chapter. */
  index: number;
  start: number;
  end: number;
  text: string;
  firstParagraph: number;
  lastParagraph: number;
  words: number;
  /** The first words, for recognising the scene and anchoring its metadata. */
  opening: string;
}

// Long enough to be unique within a chapter, short enough that an edit further
// into the scene's first paragraph does not unmoor its metadata.
export const ANCHOR_CHARS = 60;

function anchorOf(text: string): string {
  return condense(text.trim()).slice(0, ANCHOR_CHARS);
}

/** A chapter's scenes, in order. A chapter with no breaks is one scene. */
export function splitScenes(content: string): Scene[] {
  const text = toNFC(content);
  // The chapter's own heading belongs to no scene.
  const heading = /^\s*[ \t]{0,3}#[ \t]+.*(?:\r?\n|$)/.exec(text);
  const bodyStart = heading ? heading[0].length : 0;

  const segments: { start: number; end: number }[] = [];
  let segmentStart = bodyStart;
  let lineStart = bodyStart;
  while (lineStart <= text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    if (isSceneBreakLine(text.slice(lineStart, lineEnd))) {
      segments.push({ start: segmentStart, end: lineStart });
      segmentStart = lineEnd + 1;
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  segments.push({ start: segmentStart, end: text.length });

  const scenes: Scene[] = [];
  for (const segment of segments) {
    const raw = text.slice(segment.start, Math.min(segment.end, text.length));
    if (!raw.trim()) continue;
    const start = segment.start + raw.search(/\S/);
    const end = segment.start + raw.trimEnd().length;
    const body = text.slice(start, end);
    scenes.push({
      index: scenes.length + 1,
      start,
      end,
      text: body,
      firstParagraph: paragraphNumberAt(text, start),
      lastParagraph: paragraphNumberAt(text, end - 1),
      words: countWords(body),
      opening: anchorOf(body),
    });
  }
  return scenes;
}

export { anchorOf as sceneAnchor };

export interface MatchedScenes {
  /** Metadata per scene index. */
  byScene: Map<number, SceneMeta>;
  /** Metadata whose scene could not be found — its opening was rewritten or cut. */
  lost: SceneMeta[];
}

/**
 * Pairs a chapter's stored metadata with its current scenes: a scene that
 * still opens with the anchored words first, one that still contains them
 * second, the scene number last as a tie-breaker between scenes that open
 * alike. Metadata that finds no scene is reported, never guessed onto one.
 */
export function matchSceneMeta(scenes: Scene[], metas: SceneMeta[]): MatchedScenes {
  const byScene = new Map<number, SceneMeta>();
  const lost: SceneMeta[] = [];

  // Most recent first, so when two entries claim one scene the newer wins.
  const ordered = [...metas].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const meta of ordered) {
    const opens = scenes.filter((s) => s.opening.startsWith(meta.anchor) || meta.anchor.startsWith(s.opening));
    const contains = opens.length ? opens : scenes.filter((s) => condense(s.text).includes(meta.anchor));
    const free = contains.filter((s) => !byScene.has(s.index));
    if (!free.length) {
      lost.push(meta);
      continue;
    }
    const chosen = free.sort(
      (a, b) => Math.abs(a.index - meta.indexHint) - Math.abs(b.index - meta.indexHint)
    )[0];
    byScene.set(chosen.index, meta);
  }
  return { byScene, lost };
}
