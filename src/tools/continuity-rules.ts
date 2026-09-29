// The story-bible half of book_continuity_check, apart from the tool so it can
// be type-checked and tested on its own.

import { ChapterMeta, Character, PlotThread, StoryBible } from "../storage/schema";
import { LanguageRules } from "../lang/types";
import { escapeRegExp, normalizeForCompare, wholeWordRegExp } from "../utils/text";
import { speakerTagsIn } from "./voice";

export interface CharacterFlag {
  type: "character";
  severity: "error" | "warning";
  description: string;
  suggestion: string;
}

export const LANGUAGE_DEPENDENT_CONTINUITY_CHECKS = [
  "traitContradictions",
  "unregisteredCharacters",
];

// How close an opposite has to be to the character's name to count as
// describing them.
const NEARBY = 200;

/** Every name a character answers to, and the parts of a full name. */
export function namesOf(character: Character): string[] {
  const names = new Set<string>();
  for (const name of [character.name, ...character.aliases]) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    names.add(trimmed);
    // "Mara Vance" is tagged "Mara said" as often as "Mara Vance said".
    for (const part of trimmed.split(/\s+/)) {
      if (part.length > 1) names.add(part);
    }
  }
  return [...names];
}

function positions(text: string, pattern: RegExp): number[] {
  const global = pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
  return [...text.matchAll(global)].map((m) => m.index ?? 0);
}

// An opposite as a whole word, with any of the language's adjective endings:
// "klein" also finds "kleine" and "kleinen", but never "Kleinigkeit".
function oppositePattern(word: string, rules: LanguageRules): RegExp {
  const endings = rules.adjectiveEndings.length
    ? `(?:${rules.adjectiveEndings.map(escapeRegExp).join("|")})?`
    : "";
  return new RegExp(
    `(?<![\\p{L}\\p{N}_])${escapeRegExp(word.normalize("NFC"))}${endings}(?![\\p{L}\\p{N}_])`,
    rules.adjectivesLowercase ? "gu" : "giu"
  );
}

// The trait keys a free-text trait mentions: "very tall" is about "tall".
function traitKeys(trait: string, rules: LanguageRules): string[] {
  const normalized = normalizeForCompare(trait);
  return Object.keys(rules.traitOpposites).filter((key) =>
    oppositePattern(key, rules).test(normalized)
  );
}

export function checkCharacters(
  content: string,
  bible: StoryBible,
  rules: LanguageRules | null
): { flags: CharacterFlag[]; skipped: string[] } {
  if (!rules) return { flags: [], skipped: [...LANGUAGE_DEPENDENT_CONTINUITY_CHECKS] };

  const flags: CharacterFlag[] = [];
  const text = content.normalize("NFC");

  // A trait in the story bible contradicted near the character's name.
  for (const character of bible.characters) {
    const namePositions = namesOf(character).flatMap((name) =>
      positions(text, wholeWordRegExp(name))
    );
    if (namePositions.length === 0) continue;

    for (const trait of character.traits) {
      for (const key of traitKeys(trait, rules)) {
        for (const opposite of rules.traitOpposites[key]) {
          const near = positions(text, oppositePattern(opposite, rules)).some((at) =>
            namePositions.some((nameAt) => Math.abs(nameAt - at) < NEARBY)
          );
          if (near) {
            flags.push({
              type: "character",
              severity: "error",
              description: `Character "${character.name}" is described as "${trait}" in story bible but "${opposite}" appears near their name in this chapter.`,
              suggestion: `Verify the description of ${character.name} matches the story bible trait "${trait}".`,
            });
          }
        }
      }
    }
  }

  // Someone speaking in a dialogue tag who is not in the story bible.
  const known = new Set(
    bible.characters.flatMap((c) => namesOf(c).map((n) => normalizeForCompare(n)))
  );
  const reported = new Set<string>();
  for (const name of speakerTagsIn(text, rules)) {
    const key = normalizeForCompare(name);
    if (known.has(key) || reported.has(key) || name.length <= 2) continue;
    reported.add(key);
    flags.push({
      type: "character",
      severity: "warning",
      description: `"${name}" appears to be a character (used with dialogue tags) but is not in the story bible.`,
      suggestion: `Add "${name}" to the story bible using book_character_add.`,
    });
  }

  return { flags, skipped: [] };
}

// ---------------------------------------------------------------------------
// Plot threads

/** Whether a chapter's text names a thread by its title or one of its keywords. */
export function threadMentioned(thread: PlotThread, text: string): boolean {
  const normalized = text.normalize("NFC");
  return [thread.title, ...(thread.keywords ?? [])]
    .map((term) => term.trim())
    .filter(Boolean)
    .some((term) => wholeWordRegExp(term).test(normalized));
}

/**
 * The last chapter, up to and including `upTo`, that carries a thread: the one
 * it opens in, one the author touched it in, or one whose prose names it.
 * Null when the chapter it opens in is no longer in the book.
 */
export function lastCarried(
  thread: PlotThread,
  chapters: ChapterMeta[],
  upTo: ChapterMeta,
  textOf: (chapter: ChapterMeta) => string
): ChapterMeta | null {
  const opened = chapters.find((c) => c.id === thread.openedIn);
  if (!opened) return null;

  const touched = new Set((thread.touches ?? []).map((t) => t.chapterId));
  const candidates = chapters
    .filter((c) => c.order >= opened.order && c.order <= upTo.order)
    .sort((a, b) => b.order - a.order);

  for (const chapter of candidates) {
    if (chapter.id === opened.id || touched.has(chapter.id)) return chapter;
    if (threadMentioned(thread, textOf(chapter))) return chapter;
  }
  return opened;
}

// A thread can rest for this many chapters before it is worth a reminder.
export const THREAD_REST_CHAPTERS = 5;

export interface ThreadFlag {
  type: "plot_thread";
  severity: "warning";
  description: string;
  suggestion: string;
}

/** Open threads that have gone unmentioned for too long by this chapter. */
export function checkThreads(
  chapter: ChapterMeta,
  chapters: ChapterMeta[],
  bible: StoryBible,
  textOf: (chapter: ChapterMeta) => string
): ThreadFlag[] {
  const flags: ThreadFlag[] = [];
  for (const thread of bible.plotThreads) {
    if (thread.status !== "open") continue;
    const last = lastCarried(thread, chapters, chapter, textOf);
    if (!last || last.id === chapter.id) continue;

    const gap = chapter.order - last.order;
    if (gap > THREAD_REST_CHAPTERS) {
      flags.push({
        type: "plot_thread",
        severity: "warning",
        description: `Open plot thread "${thread.title}" (opened in ${thread.openedIn}) was last carried in ${last.id} ("${last.title}"), ${gap} chapters before this one.`,
        suggestion: `Weave "${thread.title}" in, resolve it, or mark it abandoned with book_plot_thread_update. If this chapter carries it without naming it, record that with book_plot_thread_touch, or give the thread keywords the prose does use.`,
      });
    }
  }
  return flags;
}
