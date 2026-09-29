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
   * Words that, before a capitalised word (with up to two adjectives in
   * between), make it a noun rather than a name: articles, possessives,
   * prepositions. German capitalises every noun, so "Die Frau sagte" would
   * otherwise read as a character called "Frau".
   */
  determiners: string[];
  /** Capitalised words that are never a character's name. */
  notNames: string[];
  /**
   * Pronouns that, straight after a verb of speech, show the word before the
   * verb was not its subject. German inverts after any opening adverb —
   * "Hinterher sagte er" — so "Hinterher" is not a speaker. Left empty for
   * English, where "Kell said he would come" has Kell as the subject.
   */
  invertedSubjectPronouns?: string[];

  /**
   * The days of the week, one entry per day, each listing the names that day
   * goes by ("samstag", "sonnabend"). Lowercase.
   */
  weekdays: string[][];
  dayParts: Record<DayPart, string[]>;

  /** A physical trait and the words that contradict it. */
  traitOpposites: Record<string, string[]>;
  /**
   * Endings an adjective may take and still be the same word — "klein",
   * "kleine", "kleinen" — so an inflected opposite is still recognised.
   */
  adjectiveEndings: string[];
  /**
   * Adjectives are only ever lowercase, so a capitalised match is a noun —
   * true for German, where "Alter" (age) is not the adjective "alt".
   */
  adjectivesLowercase?: boolean;
}

export type MatterLabelKey =
  | "copyright"
  | "dedication"
  | "epigraph"
  | "foreword"
  | "preface"
  | "dramatis_personae"
  | "afterword"
  | "acknowledgements"
  | "glossary"
  | "bibliography"
  | "about_author"
  | "also_by";

/** Words the exports print, in the book's language. */
export interface Labels {
  contents: string;
  by: string;
  titlePage: string;
  beginning: string;
  /** "Kapitel 3" / "Drittes Kapitel"; null past the words the language has. */
  chapter: (n: number, style: "numeric" | "words") => string;
  /** "Zweiter Teil" / "Part Two". */
  part: (n: number) => string;
  matter: Record<MatterLabelKey, string>;
  allRightsReserved: string;
  firstPublished: string;
  editions: { ebook: string; paperback: string; hardcover: string };
  roles: {
    editor: string;
    translator: string;
    illustrator: string;
    cover_designer: string;
    foreword: string;
    other: string;
  };
  /** "Hafen-Krimis, Band 2". */
  seriesVolume: (name: string, n?: number) => string;
}
