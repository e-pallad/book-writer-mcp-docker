// What a language contributes to the checks. Every heuristic that reads prose
// — tense, point of view, passive voice, who is speaking, which weekday a
// chapter names, whether a trait is contradicted — depends on the language the
// book is written in. Keeping them all in one object per language means a
// check either has rules for the project's language or knows it has none, and
// can say so instead of reporting a clean result it never checked.

export type DayPart = "morning" | "afternoon" | "evening" | "night";

export interface LanguageRules {
  /** Base language subtag: "en", "de". */
  code: string;
  /** English name of the language, for messages. */
  name: string;

  /** Narration that reads as present tense. Matched against narration only, never dialogue. */
  presentTense: RegExp;
  /** Narration that reads as past tense. */
  pastTense: RegExp;
  /** Internal thought in the first person ("I thought"). */
  firstPersonThought: RegExp;
  /** Internal thought in the third person ("she thought"). */
  thirdPersonThought: RegExp;
  /** One passive construction. */
  passive: RegExp;

  /** Verbs of speech that tag a line of dialogue: "said", "sagte". */
  speechVerbs: string[];
  /**
   * Words that, directly before a capitalised word, make it a noun rather than
   * a name. German capitalises every noun, so "Die Frau sagte" would otherwise
   * read as a character called "Frau".
   */
  determiners: string[];
  /** Capitalised words that are never a character's name. */
  notNames: string[];

  weekdays: string[];
  dayParts: Record<DayPart, string[]>;

  /** A physical trait and the words that contradict it. */
  traitOpposites: Record<string, string[]>;
  /**
   * Endings an adjective may take and still be the same word — "klein",
   * "kleine", "kleinen" — so an inflected opposite is still recognised.
   */
  adjectiveEndings: string[];
}

export interface Labels {
  contents: string;
  by: string;
  titlePage: string;
  beginning: string;
}
