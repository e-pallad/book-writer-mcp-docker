// Picking the rules for a book's language. See types.ts for why they live in
// one place.

import { getRegistry } from "../storage/filestore";
import { en } from "./en";
import { Labels, LanguageRules } from "./types";

export type { LanguageRules, Labels, DayPart } from "./types";

const RULES: Record<string, LanguageRules> = { en };

const LABELS: Record<string, Labels> = {
  en: { contents: "Contents", by: "by", titlePage: "Title page", beginning: "Beginning" },
  de: { contents: "Inhalt", by: "von", titlePage: "Titelseite", beginning: "Beginn" },
};

/** The language a project had before it could have one: its checks were English. */
export const LEGACY_LANGUAGE = "en";

/** "de-AT" -> "de". */
export function baseLanguage(tag: string): string {
  return tag.trim().toLowerCase().split(/[-_]/)[0];
}

// BCP 47 in the shape a book needs: a language, optionally a region or script.
const TAG = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/;

export function isValidLanguageTag(tag: string): boolean {
  return TAG.test(tag.trim());
}

/** Rules for a language tag, or null when this server has none for it. */
export function rulesFor(tag: string): LanguageRules | null {
  return RULES[baseLanguage(tag)] ?? null;
}

/** Labels for exported pages; English when the language has none of its own. */
export function labelsFor(tag: string): Labels {
  return LABELS[baseLanguage(tag)] ?? LABELS.en;
}

export function supportedLanguages(): string[] {
  return Object.keys(RULES);
}

export interface ProjectLanguage {
  /** The tag as stored ("de-AT"), or the legacy default. */
  tag: string;
  rules: LanguageRules | null;
  /** Set when the project predates the language field. */
  assumed: boolean;
}

/** The project's language and the rules that go with it. */
export function projectLanguage(): ProjectLanguage {
  const stored = getRegistry()?.language?.trim();
  const tag = stored || LEGACY_LANGUAGE;
  return { tag, rules: rulesFor(tag), assumed: !stored };
}

/**
 * What to tell the caller about the checks a language could not have. An
 * author writing in a language this server has no rules for gets told which
 * checks did not run, rather than a clean result nothing earned.
 */
export function languageNote(language: ProjectLanguage, skipped: string[]): string | undefined {
  if (!language.rules && skipped.length) {
    return `No ${language.tag} rules are available (supported: ${supportedLanguages().join(
      ", "
    )}), so these checks did not run: ${skipped.join(", ")}. Only language-independent checks were applied.`;
  }
  if (language.assumed) {
    return "The project has no language set, so English rules were applied. Set it with book_project_update language=\"de\" (or another BCP 47 tag).";
  }
  return undefined;
}
