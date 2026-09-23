import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getRegistry,
  getStoryBible,
  getTimeline,
  loadOrInitTimeline,
  updateTimeline,
} from "../storage/filestore";
import { Registry, StoryBible, TimelineEvent } from "../storage/schema";
import { BookMCPError } from "../utils/errors";
import { normalizeForCompare } from "../utils/text";

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function generateEventId(existing: TimelineEvent[]): string {
  const taken = new Set(existing.map((e) => e.id));
  const base = `tl-${Date.now().toString(36)}`;
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}

// Chapters are addressed by id or title everywhere else, so the timeline does
// the same. Returns the canonical id.
function resolveChapterId(registry: Registry | null, ref: string): string {
  if (!registry) return ref;
  const byId = registry.chapters.find((c) => c.id === ref);
  if (byId) return byId.id;

  const matches = registry.chapters.filter(
    (c) => normalizeForCompare(c.title) === normalizeForCompare(ref)
  );
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) {
    throw new BookMCPError(
      `Several chapters are titled "${ref}": ${matches
        .map((c) => c.id)
        .join(", ")}. Use the chapter id instead.`
    );
  }
  throw new BookMCPError(
    `Chapter "${ref}" not found. Known chapters: ${
      registry.chapters.map((c) => `${c.id} ("${c.title}")`).join(", ") || "none"
    }`
  );
}

// Characters likewise: an author names them, the file stores ids.
function resolveCharacterId(bible: StoryBible | null, ref: string): string {
  if (!bible) return ref;
  const needle = normalizeForCompare(ref);
  const match = bible.characters.find(
    (c) =>
      c.id === ref ||
      normalizeForCompare(c.name) === needle ||
      c.aliases.some((a) => normalizeForCompare(a) === needle)
  );
  if (!match) {
    throw new BookMCPError(
      `Character "${ref}" is not in the story bible. Add them with book_character_add first, or pass an existing id.`
    );
  }
  return match.id;
}

/**
 * Story order, not insertion order.
 *
 * `sortKey` decides when it is there. Events without one cannot be placed on
 * the clock, so they sort after everything that can be, falling back to the
 * order of the chapter they belong to and then to when they were logged. That
 * keeps an un-keyed event somewhere sensible instead of at an arbitrary spot.
 */
export function sortEvents(
  events: TimelineEvent[],
  registry: Registry | null
): TimelineEvent[] {
  const chapterOrder = new Map<string, number>();
  for (const chapter of registry?.chapters ?? []) {
    chapterOrder.set(chapter.id, chapter.order);
  }

  const positionOf = (event: TimelineEvent) =>
    event.chapterId !== undefined
      ? chapterOrder.get(event.chapterId) ?? Number.MAX_SAFE_INTEGER
      : Number.MAX_SAFE_INTEGER;

  return [...events].sort((a, b) => {
    const aKey = a.sortKey?.trim();
    const bKey = b.sortKey?.trim();

    if (aKey && bKey) {
      const compared = aKey.localeCompare(bKey);
      if (compared !== 0) return compared;
    } else if (aKey) {
      return -1;
    } else if (bKey) {
      return 1;
    }

    const byChapter = positionOf(a) - positionOf(b);
    if (byChapter !== 0) return byChapter;

    return a.createdAt.localeCompare(b.createdAt);
  });
}

function describe(
  event: TimelineEvent,
  registry: Registry | null,
  bible: StoryBible | null
) {
  const chapter = event.chapterId
    ? registry?.chapters.find((c) => c.id === event.chapterId)
    : undefined;

  return {
    id: event.id,
    event: event.event,
    inStoryTime: event.inStoryTime,
    sortKey: event.sortKey,
    chapterId: event.chapterId,
    chapterTitle: chapter?.title,
    characterIds: event.characterIds,
    // Resolved on the way out rather than stored, so a renamed character does
    // not leave a stale copy of their name in timeline.json.
    characters: event.characterIds.map(
      (id) => bible?.characters.find((c) => c.id === id)?.name ?? id
    ),
    notes: event.notes,
    updatedAt: event.updatedAt,
  };
}

export function registerTimelineTools(server: McpServer): void {
  // book_timeline_add
  server.tool(
    "book_timeline_add",
    "Log an event on the story's timeline. Records when something happens in the story's own terms, so continuity checks can catch a chapter that contradicts it.",
    {
      event: z.string().describe("What happens, in a sentence"),
      inStoryTime: z
        .string()
        .describe(
          'When it happens as the story tells it, free text: "Saturday night, ~23:30", "three winters before the siege", "the morning after the fire"'
        ),
      sortKey: z
        .string()
        .optional()
        .describe(
          'Optional key that puts this event in order. Anything that sorts lexicographically works: an ISO-ish stamp ("1997-06-14T23:30") or a scheme of your own ("Y02-D14-2330"). Events without one are listed after those that have one.'
        ),
      chapterId: z
        .string()
        .optional()
        .describe('Chapter this event happens in — id ("ch-003") or title'),
      characterIds: z
        .array(z.string())
        .optional()
        .default([])
        .describe("Characters involved — ids or names, resolved against the story bible"),
      notes: z.string().optional().default("").describe("Additional notes"),
    },
    async (input) => {
      const registry = getRegistry();
      const bible = getStoryBible();

      const chapterId =
        input.chapterId !== undefined
          ? resolveChapterId(registry, input.chapterId)
          : undefined;
      const characterIds = input.characterIds.map((ref) =>
        resolveCharacterId(bible, ref)
      );

      const now = new Date().toISOString();
      const event: TimelineEvent = {
        id: "",
        event: input.event,
        inStoryTime: input.inStoryTime,
        sortKey: input.sortKey?.trim() || undefined,
        chapterId,
        characterIds,
        notes: input.notes,
        createdAt: now,
        updatedAt: now,
      };

      const timeline = await updateTimeline((current) => {
        event.id = generateEventId(current.events);
        current.events.push(event);
      });

      return jsonResult({
        message: `Timeline event "${event.event}" logged.`,
        event: describe(event, registry, bible),
        totalEvents: timeline.events.length,
        ...(event.sortKey
          ? {}
          : {
              hint: "No sortKey given, so this event sorts after every event that has one. Add one with book_timeline_update to place it.",
            }),
      });
    }
  );

  // book_timeline_list
  server.tool(
    "book_timeline_list",
    "List timeline events in story order. Optionally filtered to one chapter or one character.",
    {
      chapterId: z
        .string()
        .optional()
        .describe('Only events in this chapter — id ("ch-003") or title'),
      characterId: z
        .string()
        .optional()
        .describe("Only events involving this character — id or name"),
    },
    async ({ chapterId, characterId }) => {
      const registry = getRegistry();
      const bible = getStoryBible();
      const timeline = getTimeline() ?? loadOrInitTimeline();

      let events = timeline.events;
      if (chapterId !== undefined) {
        const resolved = resolveChapterId(registry, chapterId);
        events = events.filter((e) => e.chapterId === resolved);
      }
      if (characterId !== undefined) {
        const resolved = resolveCharacterId(bible, characterId);
        events = events.filter((e) => e.characterIds.includes(resolved));
      }

      const sorted = sortEvents(events, registry);
      const unplaced = sorted.filter((e) => !e.sortKey?.trim()).length;

      return jsonResult({
        eventCount: sorted.length,
        ...(chapterId !== undefined ? { filteredByChapter: chapterId } : {}),
        ...(characterId !== undefined ? { filteredByCharacter: characterId } : {}),
        events: sorted.map((e) => describe(e, registry, bible)),
        ...(unplaced
          ? {
              note: `${unplaced} event(s) have no sortKey and are listed last. Give them one with book_timeline_update to place them in order.`,
            }
          : {}),
      });
    }
  );

  // book_timeline_update
  server.tool(
    "book_timeline_update",
    "Correct a timeline event. Every field is optional, so a sortKey can be added without restating the event.",
    {
      eventId: z.string().describe("Timeline event ID"),
      event: z.string().optional().describe("Corrected description"),
      inStoryTime: z.string().optional().describe("Corrected in-story time"),
      sortKey: z
        .string()
        .optional()
        .describe('Corrected sort key. Pass an empty string to remove it.'),
      chapterId: z
        .string()
        .optional()
        .describe("Move the event to another chapter — id or title"),
      characterIds: z
        .array(z.string())
        .optional()
        .describe("Replace the character list — ids or names"),
      notes: z.string().optional().describe("Corrected notes"),
    },
    async (input) => {
      const registry = getRegistry();
      const bible = getStoryBible();

      if (
        input.event === undefined &&
        input.inStoryTime === undefined &&
        input.sortKey === undefined &&
        input.chapterId === undefined &&
        input.characterIds === undefined &&
        input.notes === undefined
      ) {
        throw new BookMCPError(
          "Nothing to update: pass at least one of event, inStoryTime, sortKey, chapterId, characterIds or notes."
        );
      }

      let updated!: TimelineEvent;
      await updateTimeline((timeline) => {
        const found = timeline.events.find((e) => e.id === input.eventId);
        if (!found) {
          throw new BookMCPError(
            `Timeline event "${input.eventId}" not found. List them with book_timeline_list.`
          );
        }

        if (input.event !== undefined) found.event = input.event;
        if (input.inStoryTime !== undefined) found.inStoryTime = input.inStoryTime;
        if (input.sortKey !== undefined) {
          // An empty string is how a caller says "unplace this event".
          found.sortKey = input.sortKey.trim() || undefined;
        }
        if (input.chapterId !== undefined) {
          found.chapterId = resolveChapterId(registry, input.chapterId);
        }
        if (input.characterIds !== undefined) {
          found.characterIds = input.characterIds.map((ref) =>
            resolveCharacterId(bible, ref)
          );
        }
        if (input.notes !== undefined) found.notes = input.notes;
        found.updatedAt = new Date().toISOString();
        updated = found;
      });

      return jsonResult({
        message: `Timeline event "${updated.event}" updated.`,
        event: describe(updated, registry, bible),
      });
    }
  );

  // book_timeline_delete
  server.tool(
    "book_timeline_delete",
    "Remove an event from the timeline",
    {
      eventId: z.string().describe("Timeline event ID"),
    },
    async ({ eventId }) => {
      let removed!: TimelineEvent;
      const timeline = await updateTimeline((current) => {
        const index = current.events.findIndex((e) => e.id === eventId);
        if (index === -1) {
          throw new BookMCPError(
            `Timeline event "${eventId}" not found. List them with book_timeline_list.`
          );
        }
        removed = current.events[index];
        current.events.splice(index, 1);
      });

      return jsonResult({
        message: `Timeline event "${removed.event}" deleted.`,
        deleted: { id: removed.id, event: removed.event, inStoryTime: removed.inStoryTime },
        remainingEvents: timeline.events.length,
      });
    }
  );
}
