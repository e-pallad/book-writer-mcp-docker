// Looking up story-bible entries by whatever the author calls them. Every tool
// that takes a character, setting or plot thread accepts its id or its name
// (or alias, or title), so the same reference works everywhere.

import { getRegistry } from "./filestore";
import { resolveChapter } from "./chapters";
import { Character, PlotThread, Setting, StoryBible, Theme } from "./schema";
import { BookMCPError } from "../utils/errors";
import { normalizeForCompare } from "../utils/text";

function known(items: { id: string }[], label: (item: never) => string): string {
  return items.map((item) => label(item as never)).join(", ") || "none";
}

export function findCharacter(bible: StoryBible, ref: string): Character | undefined {
  const needle = normalizeForCompare(ref);
  return (
    bible.characters.find((c) => c.id === ref) ??
    bible.characters.find(
      (c) =>
        normalizeForCompare(c.name) === needle ||
        c.aliases.some((a) => normalizeForCompare(a) === needle)
    )
  );
}

export function resolveCharacter(bible: StoryBible, ref: string): Character {
  const character = findCharacter(bible, ref);
  if (!character) {
    throw new BookMCPError(
      `Character "${ref}" not found. Known characters: ${known(
        bible.characters,
        (c: Character) => `${c.name} (${c.id})`
      )}`
    );
  }
  return character;
}

export function resolveSetting(bible: StoryBible, ref: string): Setting {
  const needle = normalizeForCompare(ref);
  const setting =
    bible.settings.find((s) => s.id === ref) ??
    bible.settings.find((s) => normalizeForCompare(s.name) === needle);
  if (!setting) {
    throw new BookMCPError(
      `Setting "${ref}" not found. Known settings: ${known(
        bible.settings,
        (s: Setting) => `${s.name} (${s.id})`
      )}`
    );
  }
  return setting;
}

export function resolveThread(bible: StoryBible, ref: string): PlotThread {
  const needle = normalizeForCompare(ref);
  const byId = bible.plotThreads.find((t) => t.id === ref);
  if (byId) return byId;
  const byTitle = bible.plotThreads.filter((t) => normalizeForCompare(t.title) === needle);
  if (byTitle.length === 1) return byTitle[0];
  if (byTitle.length > 1) {
    throw new BookMCPError(
      `Several plot threads are titled "${ref}": ${byTitle.map((t) => t.id).join(", ")}. Use the id.`
    );
  }
  throw new BookMCPError(
    `Plot thread "${ref}" not found. Known threads: ${known(
      bible.plotThreads,
      (t: PlotThread) => `${t.title} (${t.id})`
    )}`
  );
}

/**
 * A chapter reference as the story bible should store it: the id when the
 * chapter exists (a title is resolved to it), otherwise the reference as
 * given, with a warning. Lenient on purpose: a plot thread or a character's
 * first appearance is often planned before the chapter is written.
 */
export function chapterRef(ref: string): { id: string; warning?: string } {
  const trimmed = ref.trim();
  if (!trimmed) return { id: "" };
  const registry = getRegistry();
  if (!registry) return { id: trimmed };
  try {
    return { id: resolveChapter(registry, trimmed).id };
  } catch {
    return {
      id: trimmed,
      warning: `No chapter "${trimmed}" exists yet; it was stored as given. Use the chapter id once the chapter is created.`,
    };
  }
}

export function normaliseThemes(themes: (Theme | string)[] | undefined): Theme[] {
  return (themes ?? []).map((theme) =>
    typeof theme === "string" ? { name: theme, description: "" } : theme
  );
}
