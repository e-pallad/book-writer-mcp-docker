// What every flag of book_continuity_check carries besides its prose.
// `description` and `suggestion` are for a person; the rest is for the model
// that has to act on the flag: a stable `code` to branch on, the ids involved,
// the passage that triggered it, and the call that repairs it — so it neither
// parses a sentence nor goes looking for the sentence in the chapter.

import { Snippet } from "../utils/match";

export interface FlagRepair {
  tool: string;
  args: Record<string, unknown>;
  /**
   * The argument that only the author can decide, when the flag cannot say.
   * A flag never guesses between "fix the prose" and "fix the record".
   */
  choose?: string;
}

export interface FlagDetail {
  /** Stable name of the rule that fired, e.g. "trait_contradiction". */
  code: string;
  /** The chapter the flag was raised for. */
  chapterId: string;
  /** Ids of the records involved, by kind. */
  entities?: {
    characterId?: string;
    threadId?: string;
    settingId?: string;
    otherSettingIds?: string[];
    eventId?: string;
    otherEventId?: string;
    otherChapterId?: string;
    sceneIndex?: number;
  };
  /** The passages in this chapter that triggered it; read one with book_chapter_read fromParagraph/toParagraph. */
  evidence?: Snippet[];
  repair?: FlagRepair;
}
