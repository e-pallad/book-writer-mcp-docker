// Where the turning points actually fall. A beat is placed in a chapter (or a
// scene of one); its position is how far into the book that is, by words. For
// an unfinished book the measure is the target length, since the draft's end
// is not the book's end.

import { ChapterMeta, Outline, Registry, StoryBible } from "../storage/schema";
import { chaptersInOrder } from "../storage/chapters";
import { splitScenes } from "../scenes/scenes";
import { countWords } from "../utils/wordcount";
import { DEFAULT_TOLERANCE, StructureTemplate, templateById } from "./templates";

export interface BeatResult {
  beat: string;
  name: string;
  expected: number;
  /** Null for a beat not placed yet. */
  actual: number | null;
  chapterId?: string;
  scene?: number;
  deviation?: number;
  verdict: "on_target" | "early" | "late" | "missing" | "unplaced";
}

export interface StructureReport {
  template: string;
  name: string;
  basis: "manuscript" | "target";
  totalWords: number;
  beats: BeatResult[];
  /** Beats placed in a different order than the template's. */
  outOfOrder: string[];
  findings: string[];
}

/**
 * The share of the book reached by the middle of a chapter — or of one of its
 * scenes — counted in words.
 */
function positionOf(
  chapter: ChapterMeta,
  scene: number | undefined,
  ordered: ChapterMeta[],
  words: Map<string, number>,
  textOf: (c: ChapterMeta) => string,
  total: number
): number {
  let before = 0;
  for (const c of ordered) {
    if (c.id === chapter.id) break;
    before += words.get(c.id) ?? 0;
  }
  const own = words.get(chapter.id) ?? 0;
  if (scene !== undefined) {
    const scenes = splitScenes(textOf(chapter));
    const target = scenes[scene - 1];
    if (target) {
      // Whatever of the chapter belongs to no scene — its heading — comes
      // before the first one.
      const outside = own - scenes.reduce((sum, s) => sum + s.words, 0);
      const prior = scenes.slice(0, scene - 1).reduce((sum, s) => sum + s.words, 0);
      return (before + outside + prior + target.words / 2) / total;
    }
  }
  return (before + own / 2) / total;
}

export function checkStructure(
  outline: Outline | null,
  registry: Registry,
  textOf: (c: ChapterMeta) => string,
  language: string,
  tolerance = DEFAULT_TOLERANCE
): StructureReport | null {
  const structure = outline?.structure;
  if (!structure) return null;
  const template: StructureTemplate | undefined = templateById(structure.template);
  if (!template) return null;
  const lang = language.toLowerCase().startsWith("de") ? "de" : "en";

  const ordered = chaptersInOrder(registry);
  const words = new Map(ordered.map((c) => [c.id, countWords(textOf(c))]));
  const written = [...words.values()].reduce((a, b) => a + b, 0);
  const basis = written < registry.targetWordCount ? "target" : "manuscript";
  const total = Math.max(1, basis === "target" ? registry.targetWordCount : written);

  const beats: BeatResult[] = template.beats.map((beat) => {
    const placement = structure.beats.find((p) => p.beat === beat.id);
    const name = beat.name[lang];
    if (!placement) {
      return { beat: beat.id, name, expected: beat.position, actual: null, verdict: "unplaced" };
    }
    const chapter = ordered.find((c) => c.id === placement.chapterId);
    if (!chapter) {
      return {
        beat: beat.id,
        name,
        expected: beat.position,
        actual: null,
        chapterId: placement.chapterId,
        verdict: "missing",
      };
    }
    const actual = positionOf(chapter, placement.scene, ordered, words, textOf, total);
    const deviation = actual - beat.position;
    return {
      beat: beat.id,
      name,
      expected: beat.position,
      actual: Math.round(actual * 1000) / 1000,
      chapterId: chapter.id,
      ...(placement.scene !== undefined ? { scene: placement.scene } : {}),
      deviation: Math.round(deviation * 1000) / 1000,
      verdict: Math.abs(deviation) <= tolerance ? "on_target" : deviation < 0 ? "early" : "late",
    };
  });

  // Placed beats should follow the template's order through the book.
  const placed = beats.filter((b) => b.actual !== null);
  const outOfOrder = placed
    .filter((b, i) => placed.slice(i + 1).some((later) => (later.actual ?? 0) < (b.actual ?? 0)))
    .map((b) => b.beat);

  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const findings: string[] = [];
  for (const b of beats) {
    if (b.verdict === "early" || b.verdict === "late") {
      findings.push(
        `${b.name} sits at ${pct(b.actual!)} — expected around ${pct(b.expected)} (±${pct(tolerance)}), so ${
          b.verdict === "early" ? "early" : "late"
        }${basis === "target" ? ", measured against the target length" : ""}.`
      );
    } else if (b.verdict === "missing") {
      findings.push(`${b.name} is placed in ${b.chapterId}, which is no longer in the book.`);
    }
  }
  if (outOfOrder.length) {
    findings.push(`Out of the template's order: ${outOfOrder.join(", ")}.`);
  }
  const unplaced = beats.filter((b) => b.verdict === "unplaced");
  if (placed.length && unplaced.length) {
    findings.push(`Not placed yet: ${unplaced.map((b) => b.name).join(", ")}.`);
  }

  return {
    template: template.id,
    name: template.name[lang],
    basis,
    totalWords: total,
    beats,
    outOfOrder,
    findings,
  };
}

/** Advice on the characters' arcs: a main character without one, an arc without its core. */
export function checkArcs(bible: StoryBible | null): string[] {
  const advice: string[] = [];
  for (const character of bible?.characters ?? []) {
    const arc = character.arc;
    if (!arc) {
      if (character.role === "protagonist") {
        advice.push(`${character.name} is a protagonist without an arc. What do they want, and what do they need?`);
      }
      continue;
    }
    if (arc.arcType === "positive" || arc.arcType === "negative") {
      const gaps = (["want", "need", "lie"] as const).filter((f) => !arc[f]);
      if (gaps.length) {
        advice.push(`${character.name}'s ${arc.arcType} arc has no ${gaps.join(", ")} yet.`);
      }
    }
    if (arc.arcType && arc.arcType !== "flat" && !(arc.milestones?.length)) {
      advice.push(`${character.name}'s arc has no milestones: note the chapters where it moves.`);
    }
  }
  return advice;
}
