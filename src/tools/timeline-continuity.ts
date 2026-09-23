import { Registry, StoryBible, TimelineEvent } from "../storage/schema";
import { normalizeForCompare, wholeWordRegExp } from "../utils/text";

export interface TimelineFlag {
  type: "timeline";
  severity: "error" | "warning";
  description: string;
  suggestion: string;
}

// Weekday names carry most of the in-story time an author writes down
// ("Saturday night, ~23:30"), and they are unambiguous enough to compare
// without parsing a date out of prose.
const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

// "the morning after" and "that night" describe the same day differently, so
// only these coarse buckets are compared — enough to catch a scene logged at
// night and drafted at dawn.
const DAY_PARTS: Record<string, string[]> = {
  morning: ["morning", "dawn", "sunrise", "daybreak"],
  afternoon: ["afternoon", "midday", "noon"],
  evening: ["evening", "dusk", "sunset", "twilight"],
  night: ["night", "midnight", "small hours"],
};

function mentionedTerms(text: string, terms: string[]): string[] {
  return terms.filter((term) => wholeWordRegExp(term).test(text));
}

function dayPartsIn(text: string): string[] {
  return Object.entries(DAY_PARTS)
    .filter(([, synonyms]) => mentionedTerms(text, synonyms).length > 0)
    .map(([part]) => part);
}

/**
 * Cross-references a chapter against the events already logged for it and for
 * the chapters around it.
 *
 * Three things are checked, and each is reported only when the timeline has
 * enough information to be sure something disagrees — a chapter with no logged
 * events produces no flags rather than a pile of guesses.
 */
export function checkTimeline(
  chapterId: string,
  content: string,
  registry: Registry,
  bible: StoryBible,
  events: TimelineEvent[]
): TimelineFlag[] {
  const flags: TimelineFlag[] = [];
  const chapter = registry.chapters.find((c) => c.id === chapterId);
  if (!chapter) return flags;

  const normalizedContent = normalizeForCompare(content);
  const ownEvents = events.filter((e) => e.chapterId === chapterId);

  // 1. Chronology against chapter order.
  //
  // An event logged in a later chapter that happens earlier than one logged in
  // an earlier chapter is either a flashback or a mistake. Reported as an
  // error because it is a statement the timeline itself makes, not a reading
  // of the prose.
  const placed = events.filter((e) => e.sortKey?.trim() && e.chapterId);
  for (const own of placed.filter((e) => e.chapterId === chapterId)) {
    for (const other of placed) {
      if (other.id === own.id || other.chapterId === chapterId) continue;
      const otherChapter = registry.chapters.find((c) => c.id === other.chapterId);
      if (!otherChapter) continue;

      const ownKey = own.sortKey!.trim();
      const otherKey = other.sortKey!.trim();

      const chapterIsLater = chapter.order > otherChapter.order;
      const eventIsEarlier = ownKey.localeCompare(otherKey) < 0;

      if (chapterIsLater && eventIsEarlier) {
        flags.push({
          type: "timeline",
          severity: "error",
          description: `"${own.event}" (${own.inStoryTime || ownKey}) is logged in ${chapter.id}, after ${otherChapter.id}, but happens before "${other.event}" (${other.inStoryTime || otherKey}) which is logged there.`,
          suggestion: `Either this chapter is a flashback — note that in the event's notes — or one of the two sortKeys is wrong. Correct it with book_timeline_update.`,
        });
      }
    }
  }

  // 2. The prose naming a different weekday or time of day than the event
  //    logged for this very chapter.
  for (const event of ownEvents) {
    if (!event.inStoryTime) continue;
    const loggedTime = normalizeForCompare(event.inStoryTime);

    const loggedDays = mentionedTerms(loggedTime, WEEKDAYS);
    const draftedDays = mentionedTerms(normalizedContent, WEEKDAYS);
    const contradictingDays = draftedDays.filter((d) => !loggedDays.includes(d));
    if (loggedDays.length && contradictingDays.length) {
      flags.push({
        type: "timeline",
        severity: "error",
        description: `The timeline puts "${event.event}" on ${loggedDays.join("/")} ("${event.inStoryTime}"), but this chapter says ${contradictingDays.join("/")}.`,
        suggestion: `Change the chapter to match, or correct the event with book_timeline_update eventId="${event.id}".`,
      });
    }

    const loggedParts = dayPartsIn(loggedTime);
    const draftedParts = dayPartsIn(normalizedContent);
    const contradictingParts = draftedParts.filter((p) => !loggedParts.includes(p));
    // Only when the draft names exactly one time of day: a chapter that spans
    // morning to night legitimately mentions several.
    if (
      loggedParts.length &&
      draftedParts.length === 1 &&
      contradictingParts.length === 1
    ) {
      flags.push({
        type: "timeline",
        severity: "warning",
        description: `The timeline puts "${event.event}" at ${loggedParts.join("/")} ("${event.inStoryTime}"), but this chapter reads as ${contradictingParts[0]}.`,
        suggestion: `Check which is right and correct the other.`,
      });
    }
  }

  // 3. A character the timeline places in this chapter who never appears in it.
  for (const event of ownEvents) {
    for (const characterId of event.characterIds) {
      const character = bible.characters.find((c) => c.id === characterId);
      if (!character) {
        flags.push({
          type: "timeline",
          severity: "warning",
          description: `Timeline event "${event.event}" references character id "${characterId}", which is no longer in the story bible.`,
          suggestion: `Update the event with book_timeline_update, or re-add the character.`,
        });
        continue;
      }

      const named =
        normalizedContent.includes(normalizeForCompare(character.name)) ||
        character.aliases.some((a) =>
          normalizedContent.includes(normalizeForCompare(a))
        );
      if (!named) {
        flags.push({
          type: "timeline",
          severity: "warning",
          description: `The timeline has ${character.name} present for "${event.event}" in this chapter, but they are never named in it.`,
          suggestion: `Either bring ${character.name} into the scene or drop them from the event with book_timeline_update.`,
        });
      }
    }
  }

  return flags;
}
