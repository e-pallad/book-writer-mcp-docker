export interface Registry {
  title: string;
  author: string;
  genre: string;
  targetWordCount: number;
  /**
   * BCP 47 tag of the language the book is written in ("de", "en-GB"). Picks
   * the rules the style and continuity checks use, and the language exports
   * declare. Absent in projects created before it existed, which are treated
   * as English — the only language their checks ever knew.
   */
  language?: string;
  /**
   * Which revision of the word counter produced the chapters' wordCount. The
   * counter stopped counting markup as words; a registry from before that is
   * recounted the next time it is written.
   */
  countVersion?: number;
  /**
   * How chapters are numbered in the exports: not at all (the title alone,
   * the default), "Kapitel 3", or "Drittes Kapitel".
   */
  chapterNumbering?: "none" | "numeric" | "words";
  /** Words a day the author aims for; 0 or absent for no goal. */
  dailyWordGoal?: number;
  /** YYYY-MM-DD the draft is due. */
  deadline?: string;
  /**
   * IANA time zone that decides where one writing day ends and the next
   * begins ("Europe/Berlin"). A container runs in UTC, so without this a late
   * evening session in Berlin would count towards tomorrow.
   */
  timezone?: string;
  createdAt: string;
  updatedAt: string;
  chapters: ChapterMeta[];
}

export interface AuthorProfile {
  name: string;
  linkedinUrl?: string;
  headline?: string;
  location?: string;
  summary?: string;
  experience?: { title: string; company: string; duration?: string }[];
  education?: { school: string; degree?: string; field?: string }[];
  skills?: string[];
  publications?: string[];
  interests?: string[];
  photoUrl?: string;
  generatedIntro?: string;
  generatedIntroShort?: string;
  updatedAt: string;
}

export interface ChapterMeta {
  id: string;
  title: string;
  filename: string;
  status: "outline" | "draft" | "review" | "final";
  wordCount: number;
  order: number;
  synopsis: string;
  updatedAt: string;
  /**
   * The part of the book the chapter belongs to ("Die Stadt"). Consecutive
   * chapters with the same part share one part page in the exports.
   */
  part?: string;
  /**
   * False for a chapter that carries no number — a prologue, an epilogue —
   * so the chapters after it are numbered from where they would be.
   */
  numbered?: boolean;
}

export interface StoryBible {
  characters: Character[];
  settings: Setting[];
  /**
   * What the book is about underneath the plot. Older projects hold bare
   * strings here (nothing wrote to the field before the theme tools existed,
   * but a hand-edited file might); readers normalise them with normaliseThemes.
   */
  themes: (Theme | string)[];
  plotThreads: PlotThread[];
  /**
   * Where the timeline lives, rather than the timeline itself. Events point at
   * chapters and characters by id, so keeping them in their own file avoids a
   * second copy of anything the story bible already holds.
   */
  timelineRef?: string;
  /**
   * Events written inline by an older version of this server. Migrated into
   * timeline.json the first time the timeline is read, then cleared.
   */
  timeline?: LegacyTimelineEvent[];
}

export interface Character {
  id: string;
  name: string;
  aliases: string[];
  role: "protagonist" | "antagonist" | "supporting" | "minor";
  description: string;
  backstory: string;
  traits: string[];
  relationships: { characterId: string; nature: string }[];
  firstAppearance: string;
  notes: string;
  /**
   * How this character speaks, as distinct from how the book is written. The
   * style guide is one voice for the whole manuscript; this is the voice of
   * one person inside it, and book_style_check uses it to judge dialogue.
   * Optional: most characters do not need one.
   */
  voiceProfile?: VoiceProfile;
}

export interface VoiceProfile {
  /** Words and registers this character reaches for: "nautical slang", "clinical, Latinate". */
  vocabulary: string;
  /** How long their sentences run. */
  sentenceLength: "clipped" | "short" | "medium" | "long" | "rambling" | "varied";
  /** Repeated turns of phrase: "starts sentences with 'Look'", "never contracts". */
  verbalTics: string[];
  /**
   * Things this character would never say. Checked literally against dialogue,
   * so these should be words or phrases rather than descriptions of a habit.
   */
  neverSays: string[];
  /** Anything else about how they sound. */
  notes: string;
}

export interface Setting {
  id: string;
  name: string;
  description: string;
  type: "location" | "world" | "organization";
  notes: string;
}

export interface Theme {
  name: string;
  description: string;
}

export interface PlotThread {
  id: string;
  title: string;
  /** "abandoned" is a thread the author chose to drop, as opposed to forgot. */
  status: "open" | "resolved" | "abandoned";
  openedIn: string;
  resolvedIn?: string;
  summary: string;
  /**
   * Words that show the thread is being carried in a chapter — a name, an
   * object, a place — besides its title, which rarely appears in prose.
   */
  keywords?: string[];
  /** Chapters the author has said carry the thread forward, named or not. */
  touches?: { chapterId: string; note: string; at: string }[];
  /** Why the thread was dropped. */
  abandonedReason?: string;
}

/** The shape story-bible.json used before timeline.json existed. */
export interface LegacyTimelineEvent {
  id: string;
  event: string;
  chapterId: string;
  order: number;
}

export interface Timeline {
  events: TimelineEvent[];
}

export interface TimelineEvent {
  id: string;
  /** What happens, in a sentence. */
  event: string;
  /**
   * When it happens, as the story tells it: "Saturday night, ~23:30", "three
   * winters before the siege". Free text, because a story's own clock rarely
   * maps onto a calendar.
   */
  inStoryTime: string;
  /**
   * Optional sortable key that puts the event in order — an ISO-ish string
   * ("1997-06-14T23:30") or any scheme that sorts lexicographically
   * ("Y02-D14-2330"). Events without one sort after those that have one.
   */
  sortKey?: string;
  chapterId?: string;
  characterIds: string[];
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface StyleGuide {
  voice: string;
  pov: string;
  tense: "past" | "present" | "future";
  tone: string;
  targetAudience: string;
  sentenceStyle: string;
  thingsToAvoid: string[];
  recurringMotifs: string[];
  samplePassage: string;
  influences?: AuthorInfluence[];
}

export interface AuthorInfluence {
  author: string;
  works: string[];
  elementsToEmulate: string[];
  notes: string;
}

export interface CoverSpec {
  title: string;
  subtitle?: string;
  authorName: string;
  genre: string;
  targetPlatform: "kindle" | "paperback" | "hardcover" | "all";
  dimensions: CoverDimensions;
  design: CoverDesign;
  backCover?: BackCover;
  spine?: SpineSpec;
}

export interface CoverDimensions {
  widthInches: number;
  heightInches: number;
  dpi: number;
  widthPixels: number;
  heightPixels: number;
  bleedInches: number;
}

export interface CoverDesign {
  mood: string;
  colorPalette: string[];
  typography: {
    titleFont: string;
    subtitleFont?: string;
    authorFont: string;
  };
  imagery: string;
  style: string;
  referenceCovers?: string[];
}

export interface BackCover {
  blurb: string;
  authorBio: string;
  barcodePlacement: "bottom-right" | "bottom-center" | "bottom-left";
  testimonials?: string[];
}

export interface SpineSpec {
  text: string;
  widthInches: number;
}

export interface Outline {
  acts: OutlineAct[];
}

export interface OutlineAct {
  act?: string;
  chapters: OutlineChapter[];
}

export interface OutlineChapter {
  title: string;
  synopsis: string;
  scenes?: string[];
}

export interface AiDisclosure {
  /** How AI was used for each content type Amazon asks about. */
  text: "none" | "ai_generated" | "ai_assisted";
  images: "none" | "ai_generated" | "ai_assisted";
  translations: "none" | "ai_generated" | "ai_assisted";
  notes: string;
  /** Whether any of the above obliges a declaration to KDP. */
  disclosureRequired: boolean;
  recordedAt: string;
  /** Which reading of Amazon's policy this was recorded against. */
  policyVersion: string;
  policyVerifiedOn: string;
}

export interface WritingLog {
  /** When the log began; nothing before this was recorded. */
  startedAt: string;
  /** One entry per calendar day in the project's time zone, keyed YYYY-MM-DD. */
  days: Record<string, WritingDay>;
}

export interface WritingDay {
  /** Words gained: each change contributes its growth, if it grew the text. */
  added: number;
  /** Words cut: each change contributes its shrinkage, if it shrank the text. */
  removed: number;
  /** Net change per chapter id. */
  chapters: Record<string, number>;
  /** How many changes were made. */
  changes: number;
}

/** What a store, a catalogue and an EPUB reader need to know about the book. */
export interface PublishingMetadata {
  subtitle?: string;
  series?: { name: string; number?: number };
  /**
   * The book's description — the blurb on the back cover and the text on the
   * store page. The one copy: the cover spec and the EPUB read it from here.
   */
  description?: string;
  /** Search keywords or phrases; KDP takes seven. */
  keywords?: string[];
  /** Store categories or BISAC/Thema codes; KDP takes three. */
  categories?: string[];
  isbn?: { ebook?: string; paperback?: string; hardcover?: string };
  publisher?: string;
  /** YYYY-MM-DD. */
  publicationDate?: string;
  copyright?: { holder?: string; year?: number };
  contributors?: { name: string; role: ContributorRole }[];
  /**
   * A stable identifier for a book with no ISBN yet, so re-exported drafts
   * are recognised as the same book by a reader's library.
   */
  uuid?: string;
  updatedAt: string;
}

export type ContributorRole =
  | "editor"
  | "translator"
  | "illustrator"
  | "cover_designer"
  | "foreword"
  | "other";

/** Front and back matter: everything in a book that is not a chapter. */
export type MatterType =
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

export interface MatterSection {
  type: MatterType;
  /**
   * Markdown. Empty for a section written at export time from the project's
   * own data — the copyright page from the metadata, the cast from the story
   * bible, the author's bio from their profile.
   */
  content: string;
  /** Heading override; the language's default otherwise. */
  title?: string;
  /** Moves a section to the other end of the book (a cast list at the back). */
  position?: "front" | "back";
  updatedAt: string;
}

export interface Matter {
  sections: MatterSection[];
}

/** A reader's or editor's note on a chapter, anchored to a passage. */
export interface Note {
  id: string;
  chapterId: string;
  /**
   * The passage the note is about, verbatim. Found again in the chapter each
   * time the note is read, so revising the text around it does not move it.
   * Empty for a note on the chapter as a whole.
   */
  anchorText: string;
  /** Where the passage was when the note was made — tells repeats apart. */
  paragraphHint?: number;
  /** Who said it: "Testleserin A", "Lektorat", "the author". */
  source: string;
  kind: "comment" | "question" | "suggestion" | "praise";
  text: string;
  status: "open" | "resolved";
  resolution?: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface Notes {
  notes: Note[];
}
