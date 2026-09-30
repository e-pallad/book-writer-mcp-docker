import { z } from "zod";
import { ToolServer } from "./tool-server";
import { getStoryBible, updateStoryBible } from "../storage/filestore";
import { Character, CharacterArc, Setting, PlotThread, Theme } from "../storage/schema";
import {
  chapterRef,
  normaliseThemes,
  resolveCharacter,
  resolveSetting,
  resolveThread,
} from "../storage/bible";
import { BookMCPError } from "../utils/errors";
import { normalizeForCompare } from "../utils/text";
import { briefSchema, writeReply } from "./brief";

// Ids were the millisecond the entry was created, which collides whenever two
// are added inside the same millisecond — easy to hit when a tool call adds a
// cast of characters in one go. Two characters sharing an id is worse than it
// sounds: book_character_update looks one up by id and would silently amend
// whichever came first.
//
// Called inside the story-bible transaction, so `existing` is the authoritative
// list and a suffix is enough to guarantee uniqueness without randomness.
function generateId(existing: { id: string }[], prefix: string): string {
  const taken = new Set(existing.map((entry) => entry.id));
  const base = `${prefix}-${Date.now().toString(36)}`;
  if (!taken.has(base)) return base;

  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}

// How a character speaks, as opposed to how the book is written. Shared by
// book_character_add and book_character_update so both describe it identically.
const voiceProfileSchema = z
  .object({
    vocabulary: z
      .string()
      .optional()
      .default("")
      .describe(
        "Words and registers this character reaches for (e.g. 'nautical slang, no abstractions', 'clinical and Latinate')"
      ),
    sentenceLength: z
      .enum(["clipped", "short", "medium", "long", "rambling", "varied"])
      .optional()
      .default("varied")
      .describe("How long their sentences run"),
    verbalTics: z
      .array(z.string())
      .optional()
      .default([])
      .describe(
        "Repeated turns of phrase, matched literally against their dialogue (e.g. ['Look', 'aye', 'mate'])"
      ),
    neverSays: z
      .array(z.string())
      .optional()
      .default([])
      .describe(
        "Words or phrases this character would never use. Matched literally, so give words rather than descriptions of a habit."
      ),
    notes: z
      .string()
      .optional()
      .default("")
      .describe("Anything else about how they sound"),
  })
  .describe(
    "Optional per-character voice profile. book_style_check uses it to judge this character's dialogue against the global style guide."
  );

// How a character changes across the book. Shared by add and update.
const arcSchema = z
  .object({
    want: z.string().optional().describe("What they want — the goal they chase"),
    need: z.string().optional().describe("What they actually need, often without knowing it"),
    wound: z.string().optional().describe("The hurt in their past behind the lie"),
    lie: z.string().optional().describe("The false belief they hold about themselves or the world"),
    arcType: z
      .enum(["positive", "negative", "flat"])
      .optional()
      .describe("positive (they change for the better), negative (for the worse), flat (they stay true and change others)"),
    milestones: z
      .array(z.object({ chapterId: z.string(), note: z.string() }))
      .optional()
      .describe("Chapters where the arc moves, and what shifts there"),
  })
  .describe("The character's arc. Optional.");

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function withWarnings<T extends Record<string, unknown>>(payload: T, warnings: (string | undefined)[]) {
  const present = warnings.filter((w): w is string => Boolean(w));
  return present.length ? { ...payload, warnings: present } : payload;
}

/** An arc as stored: milestone chapters as ids, and warnings for ones not written yet. */
function normaliseArc(arc: z.infer<typeof arcSchema>): { arc: CharacterArc; warnings: string[] } {
  const warnings: string[] = [];
  const milestones = arc.milestones?.map((m) => {
    const ref = chapterRef(m.chapterId);
    if (ref.warning) warnings.push(ref.warning);
    return { chapterId: ref.id, note: m.note };
  });
  const cleaned: CharacterArc = {};
  for (const field of ["want", "need", "wound", "lie"] as const) {
    if (arc[field]?.trim()) cleaned[field] = arc[field]!.trim();
  }
  if (arc.arcType) cleaned.arcType = arc.arcType;
  if (milestones) cleaned.milestones = milestones;
  return { arc: cleaned, warnings };
}

function requireBible() {
  const bible = getStoryBible();
  if (!bible)
    throw new BookMCPError("No story bible found. Run book_init first.");
  return bible;
}

export function registerStoryBibleTools(server: ToolServer): void {
  // book_character_add
  server.tool(
    "book_character_add",
    "Add a character to the story bible",
    {
      name: z.string().describe("Character name"),
      aliases: z.array(z.string()).optional().default([]).describe("Alternative names"),
      role: z.enum(["protagonist", "antagonist", "supporting", "minor"]).describe("Character role"),
      description: z.string().describe("Physical/personality description"),
      backstory: z.string().optional().default("").describe("Character backstory"),
      traits: z.array(z.string()).optional().default([]).describe("Key traits"),
      relationships: z
        .array(z.object({ characterId: z.string(), nature: z.string() }))
        .optional()
        .default([])
        .describe("Relationships to other characters"),
      firstAppearance: z
        .string()
        .optional()
        .default("")
        .describe("Chapter of first appearance (id or title)"),
      notes: z.string().optional().default("").describe("Additional notes"),
      voiceProfile: voiceProfileSchema.optional(),
      arc: arcSchema.optional(),
      brief: briefSchema,
    },
    async (input) => {
      const first = chapterRef(input.firstAppearance);
      const arc = input.arc ? normaliseArc(input.arc) : undefined;
      const character: Character = {
        id: "",
        name: input.name,
        aliases: input.aliases,
        role: input.role,
        description: input.description,
        backstory: input.backstory,
        traits: input.traits,
        relationships: input.relationships,
        firstAppearance: first.id,
        notes: input.notes,
        ...(input.voiceProfile ? { voiceProfile: input.voiceProfile } : {}),
        ...(arc ? { arc: arc.arc } : {}),
      };
      // The read, the id, the push and the write all happen with
      // story-bible.json held, so two characters added at once can neither
      // overwrite one another nor be handed the same id.
      await updateStoryBible((bible) => {
        character.id = generateId(bible.characters, "char");
        bible.characters.push(character);
      });

      return writeReply(
        input.brief,
        withWarnings({ message: `Character "${character.name}" added.`, character }, [
          first.warning,
          ...(arc?.warnings ?? []),
        ]),
        { id: character.id, status: "created" }
      );
    }
  );

  // book_character_update
  server.tool(
    "book_character_update",
    "Update an existing character's details. To rename a character everywhere, including the prose, use book_character_rename.",
    {
      characterId: z.string().describe("Character id, name or alias"),
      updates: z
        .object({
          name: z.string().optional(),
          aliases: z.array(z.string()).optional(),
          role: z.enum(["protagonist", "antagonist", "supporting", "minor"]).optional(),
          description: z.string().optional(),
          backstory: z.string().optional(),
          traits: z.array(z.string()).optional(),
          relationships: z
            .array(z.object({ characterId: z.string(), nature: z.string() }))
            .optional(),
          firstAppearance: z.string().optional(),
          notes: z.string().optional(),
          voiceProfile: voiceProfileSchema.optional(),
          arc: arcSchema.optional(),
        })
        .describe("Fields to update"),
      brief: briefSchema,
    },
    async ({ characterId, updates, brief }) => {
      let character!: Character;
      const first = updates.firstAppearance !== undefined ? chapterRef(updates.firstAppearance) : null;
      const arc = updates.arc ? normaliseArc(updates.arc) : null;
      await updateStoryBible((bible) => {
        const found = resolveCharacter(bible, characterId);
        const { arc: _arc, ...rest } = updates;
        Object.assign(found, rest);
        if (first) found.firstAppearance = first.id;
        // An arc is merged, so its milestones can be added without restating it.
        if (arc) found.arc = { ...(found.arc ?? {}), ...arc.arc };
        character = found;
      });

      return writeReply(
        brief,
        withWarnings({ message: `Character "${character.name}" updated.`, character }, [
          first?.warning,
          ...(arc?.warnings ?? []),
          updates.name !== undefined
            ? "Only the story bible was changed. book_character_rename also renames the character in the chapters."
            : undefined,
        ]),
        { id: character.id, status: "updated" }
      );
    }
  );

  // book_character_get
  server.tool(
    "book_character_get",
    "Retrieve a character's full profile",
    {
      nameOrId: z.string().describe("Character name, alias or ID"),
    },
    async ({ nameOrId }) => {
      const character = resolveCharacter(requireBible(), nameOrId);
      return jsonResult(character);
    }
  );

  // book_character_list
  server.tool(
    "book_character_list",
    "List all characters with role and first appearance",
    {},
    async () => {
      const bible = requireBible();
      const list = bible.characters.map((c) => ({
        id: c.id,
        name: c.name,
        role: c.role,
        firstAppearance: c.firstAppearance,
        traits: c.traits,
      }));
      return jsonResult({ characters: list });
    }
  );

  // book_setting_add
  server.tool(
    "book_setting_add",
    "Add a setting to the story bible",
    {
      name: z.string().describe("Setting name"),
      description: z.string().describe("Setting description"),
      type: z.enum(["location", "world", "organization"]).describe("Setting type"),
      notes: z.string().optional().default("").describe("Additional notes"),
      brief: briefSchema,
    },
    async (input) => {
      const setting: Setting = {
        id: "",
        name: input.name,
        description: input.description,
        type: input.type,
        notes: input.notes,
      };
      await updateStoryBible((bible) => {
        setting.id = generateId(bible.settings, "set");
        bible.settings.push(setting);
      });
      return writeReply(
        input.brief,
        { message: `Setting "${setting.name}" added.`, setting },
        { id: setting.id, status: "created" }
      );
    }
  );

  // book_setting_update
  server.tool(
    "book_setting_update",
    "Change a setting in the story bible: its name, description, type or notes. Every field is optional.",
    {
      settingId: z.string().describe("Setting id or name"),
      name: z.string().optional().describe("New name"),
      description: z.string().optional().describe("New description"),
      type: z.enum(["location", "world", "organization"]).optional().describe("New type"),
      notes: z.string().optional().describe("New notes"),
      brief: briefSchema,
    },
    async ({ settingId, brief, ...changes }) => {
      const fields = Object.fromEntries(
        Object.entries(changes).filter(([, value]) => value !== undefined)
      ) as Partial<Setting>;
      if (Object.keys(fields).length === 0) {
        throw new BookMCPError(
          "Nothing to update: pass at least one of name, description, type or notes."
        );
      }
      if (fields.name !== undefined && !fields.name.trim()) {
        throw new BookMCPError("A setting's name cannot be empty.");
      }

      let setting!: Setting;
      let previousName = "";
      await updateStoryBible((bible) => {
        setting = resolveSetting(bible, settingId);
        previousName = setting.name;
        Object.assign(setting, fields);
      });

      return writeReply(
        brief,
        {
          message:
            fields.name !== undefined && fields.name !== previousName
              ? `Setting "${previousName}" renamed to "${setting.name}" and updated.`
              : `Setting "${setting.name}" updated.`,
          setting,
        },
        { id: setting.id, status: "updated" }
      );
    }
  );

  // book_setting_get
  server.tool(
    "book_setting_get",
    "Retrieve a setting's details",
    {
      nameOrId: z.string().describe("Setting name or ID"),
    },
    async ({ nameOrId }) => jsonResult(resolveSetting(requireBible(), nameOrId))
  );

  // book_setting_list
  server.tool(
    "book_setting_list",
    "List all settings",
    {},
    async () => {
      const bible = requireBible();
      return jsonResult({
        settings: bible.settings.map((s) => ({ id: s.id, name: s.name, type: s.type })),
      });
    }
  );

  // book_plot_thread_add
  server.tool(
    "book_plot_thread_add",
    "Add an open plot thread",
    {
      title: z.string().describe("Plot thread title"),
      openedIn: z.string().describe("Chapter where the thread opens (id or title)"),
      summary: z.string().describe("Thread summary"),
      keywords: z
        .array(z.string())
        .optional()
        .describe(
          "Words that show a chapter carries this thread — a name, an object, a place (e.g. ['Schuldschein', 'Kells Schulden']). The title rarely appears in prose, so these are what continuity checks look for."
        ),
      brief: briefSchema,
    },
    async ({ title, openedIn, summary, keywords, brief }) => {
      const opened = chapterRef(openedIn);
      const thread: PlotThread = {
        id: "",
        title,
        status: "open",
        openedIn: opened.id,
        summary,
        ...(keywords?.length ? { keywords } : {}),
      };
      await updateStoryBible((bible) => {
        thread.id = generateId(bible.plotThreads, "plot");
        bible.plotThreads.push(thread);
      });

      return writeReply(
        brief,
        withWarnings({ message: `Plot thread "${title}" added.`, thread }, [opened.warning]),
        { id: thread.id, status: thread.status }
      );
    }
  );

  // book_plot_thread_resolve
  server.tool(
    "book_plot_thread_resolve",
    "Mark a plot thread as resolved",
    {
      threadId: z.string().describe("Plot thread id or title"),
      resolvedIn: z.string().describe("Chapter where the thread resolves (id or title)"),
      brief: briefSchema,
    },
    async ({ threadId, resolvedIn, brief }) => {
      const resolved = chapterRef(resolvedIn);
      let thread!: PlotThread;
      await updateStoryBible((bible) => {
        thread = resolveThread(bible, threadId);
        thread.status = "resolved";
        thread.resolvedIn = resolved.id;
        delete thread.abandonedReason;
      });

      return writeReply(
        brief,
        withWarnings({ message: `Plot thread "${thread.title}" resolved.`, thread }, [
          resolved.warning,
        ]),
        { id: thread.id, status: thread.status }
      );
    }
  );

  // book_plot_thread_update
  server.tool(
    "book_plot_thread_update",
    "Change a plot thread: title, summary, keywords, where it opens or resolves, or its status — including 'abandoned' for a thread deliberately dropped rather than resolved. Every field is optional.",
    {
      threadId: z.string().describe("Plot thread id or title"),
      title: z.string().optional().describe("New title"),
      summary: z.string().optional().describe("New summary"),
      keywords: z.array(z.string()).optional().describe("Replaces the keyword list"),
      openedIn: z.string().optional().describe("Chapter where it opens (id or title)"),
      resolvedIn: z.string().optional().describe("Chapter where it resolves (id or title)"),
      status: z
        .enum(["open", "resolved", "abandoned"])
        .optional()
        .describe("open, resolved, or abandoned (dropped on purpose)"),
      reason: z
        .string()
        .optional()
        .describe("Why the thread was abandoned — kept with it, so the decision is not re-litigated later"),
      brief: briefSchema,
    },
    async ({ threadId, title, summary, keywords, openedIn, resolvedIn, status, reason, brief }) => {
      if (
        [title, summary, keywords, openedIn, resolvedIn, status, reason].every((v) => v === undefined)
      ) {
        throw new BookMCPError(
          "Nothing to update: pass at least one of title, summary, keywords, openedIn, resolvedIn, status or reason."
        );
      }
      if (title !== undefined && !title.trim()) {
        throw new BookMCPError("A plot thread's title cannot be empty.");
      }
      const opened = openedIn !== undefined ? chapterRef(openedIn) : null;
      const resolved = resolvedIn !== undefined ? chapterRef(resolvedIn) : null;
      let thread!: PlotThread;
      await updateStoryBible((bible) => {
        thread = resolveThread(bible, threadId);
        if (status === "resolved" && !resolved && !thread.resolvedIn) {
          throw new BookMCPError(
            `Say where "${thread.title}" resolves: pass resolvedIn, or use book_plot_thread_resolve.`
          );
        }
        if (title !== undefined) thread.title = title.trim();
        if (summary !== undefined) thread.summary = summary;
        if (keywords !== undefined) thread.keywords = keywords;
        if (opened) thread.openedIn = opened.id;
        if (resolved) thread.resolvedIn = resolved.id;
        if (status !== undefined) thread.status = status;
        if (thread.status === "abandoned") {
          if (reason !== undefined) thread.abandonedReason = reason;
        } else {
          delete thread.abandonedReason;
        }
        if (thread.status === "open") delete thread.resolvedIn;
      });

      return writeReply(
        brief,
        withWarnings({ message: `Plot thread "${thread.title}" updated.`, thread }, [
          opened?.warning,
          resolved?.warning,
          status === undefined && reason !== undefined && thread.status !== "abandoned"
            ? "A reason is only kept for an abandoned thread."
            : undefined,
        ]),
        { id: thread.id, status: thread.status }
      );
    }
  );

  // book_plot_thread_touch
  server.tool(
    "book_plot_thread_touch",
    "Record that a chapter carries a plot thread forward, even where the prose never names it. Continuity checks and the dashboard count a touched chapter as the thread being kept alive.",
    {
      threadId: z.string().describe("Plot thread id or title"),
      chapterId: z.string().describe("Chapter that carries the thread (id or title)"),
      note: z.string().optional().default("").describe("How the chapter carries it"),
      brief: briefSchema,
    },
    async ({ threadId, chapterId, note, brief }) => {
      const chapter = chapterRef(chapterId);
      if (chapter.warning) throw new BookMCPError(`Chapter "${chapterId}" not found.`);

      let thread!: PlotThread;
      await updateStoryBible((bible) => {
        thread = resolveThread(bible, threadId);
        const touches = (thread.touches ??= []);
        const existing = touches.find((t) => t.chapterId === chapter.id);
        const at = new Date().toISOString();
        if (existing) {
          existing.note = note || existing.note;
          existing.at = at;
        } else {
          touches.push({ chapterId: chapter.id, note, at });
        }
      });

      return writeReply(
        brief,
        withWarnings(
          {
            message: `"${thread.title}" is carried in ${chapter.id}.`,
            thread,
          },
          [
            thread.status !== "open"
              ? `The thread is ${thread.status}; the touch was recorded anyway.`
              : undefined,
          ]
        ),
        { id: thread.id, status: thread.status }
      );
    }
  );

  // book_plot_threads_list
  server.tool(
    "book_plot_threads_list",
    "List all plot threads, filtered by status",
    {
      status: z
        .enum(["open", "resolved", "abandoned", "all"])
        .optional()
        .default("all")
        .describe("Filter by status"),
    },
    async ({ status }) => {
      const bible = requireBible();
      let threads = bible.plotThreads;
      if (status !== "all") {
        threads = threads.filter((t) => t.status === status);
      }
      return jsonResult({ threads });
    }
  );

  // book_theme_add
  server.tool(
    "book_theme_add",
    "Add a theme — what the book is about underneath its plot (e.g. 'Schuld und Vergebung', 'the cost of loyalty').",
    {
      name: z.string().describe("The theme, in a few words"),
      description: z
        .string()
        .optional()
        .default("")
        .describe("How the book treats it: the question it asks, where it surfaces"),
      brief: briefSchema,
    },
    async ({ name, description, brief }) => {
      const trimmed = name.trim();
      if (!trimmed) throw new BookMCPError("A theme needs a name.");

      let themes!: Theme[];
      let replaced = false;
      await updateStoryBible((bible) => {
        themes = normaliseThemes(bible.themes);
        const existing = themes.find(
          (t) => normalizeForCompare(t.name) === normalizeForCompare(trimmed)
        );
        if (existing) {
          existing.description = description || existing.description;
          replaced = true;
        } else {
          themes.push({ name: trimmed, description });
        }
        bible.themes = themes;
      });

      return writeReply(
        brief,
        {
          message: replaced ? `Theme "${trimmed}" updated.` : `Theme "${trimmed}" added.`,
          themes,
        },
        { id: trimmed, status: replaced ? "updated" : "created" }
      );
    }
  );

  // book_theme_list
  server.tool(
    "book_theme_list",
    "List the book's themes",
    {},
    async () => jsonResult({ themes: normaliseThemes(requireBible().themes) })
  );

  // book_theme_remove
  server.tool(
    "book_theme_remove",
    "Remove a theme",
    {
      name: z.string().describe("The theme's name"),
      brief: briefSchema,
    },
    async ({ name, brief }) => {
      let themes!: Theme[];
      let removed = 0;
      await updateStoryBible((bible) => {
        const all = normaliseThemes(bible.themes);
        themes = all.filter((t) => normalizeForCompare(t.name) !== normalizeForCompare(name));
        removed = all.length - themes.length;
        if (removed === 0) return false;
        bible.themes = themes;
      });
      if (removed === 0) {
        throw new BookMCPError(
          `Theme "${name}" not found. Themes: ${themes.map((t) => t.name).join(", ") || "none"}`
        );
      }
      return writeReply(
        brief,
        { message: `Theme "${name}" removed.`, themes },
        { id: name, status: "deleted" }
      );
    }
  );
}
