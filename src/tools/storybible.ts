import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getStoryBible, updateStoryBible } from "../storage/filestore";
import { Character, Setting, PlotThread } from "../storage/schema";
import { BookMCPError } from "../utils/errors";
import { normalizeForCompare } from "../utils/text";

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

function requireBible() {
  const bible = getStoryBible();
  if (!bible)
    throw new BookMCPError("No story bible found. Run book_init first.");
  return bible;
}

export function registerStoryBibleTools(server: McpServer): void {
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
      firstAppearance: z.string().optional().default("").describe("Chapter ID of first appearance"),
      notes: z.string().optional().default("").describe("Additional notes"),
      voiceProfile: voiceProfileSchema.optional(),
    },
    async (input) => {
      const character: Character = {
        id: "",
        name: input.name,
        aliases: input.aliases,
        role: input.role,
        description: input.description,
        backstory: input.backstory,
        traits: input.traits,
        relationships: input.relationships,
        firstAppearance: input.firstAppearance,
        notes: input.notes,
        ...(input.voiceProfile ? { voiceProfile: input.voiceProfile } : {}),
      };
      // The read, the id, the push and the write all happen with
      // story-bible.json held, so two characters added at once can neither
      // overwrite one another nor be handed the same id.
      await updateStoryBible((bible) => {
        character.id = generateId(bible.characters, "char");
        bible.characters.push(character);
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { message: `Character "${character.name}" added.`, character },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // book_character_update
  server.tool(
    "book_character_update",
    "Update an existing character's details",
    {
      characterId: z.string().describe("Character ID"),
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
        })
        .describe("Fields to update"),
    },
    async ({ characterId, updates }) => {
      let character!: Character;
      await updateStoryBible((bible) => {
        const found = bible.characters.find((c) => c.id === characterId);
        if (!found)
          throw new BookMCPError(`Character "${characterId}" not found.`);
        Object.assign(found, updates);
        character = found;
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { message: `Character "${character.name}" updated.`, character },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // book_character_get
  server.tool(
    "book_character_get",
    "Retrieve a character's full profile",
    {
      nameOrId: z.string().describe("Character name or ID"),
    },
    async ({ nameOrId }) => {
      const bible = requireBible();
      const needle = normalizeForCompare(nameOrId);
      const character = bible.characters.find(
        (c) =>
          c.id === nameOrId ||
          normalizeForCompare(c.name) === needle ||
          c.aliases.some((a) => normalizeForCompare(a) === needle)
      );
      if (!character)
        throw new BookMCPError(`Character "${nameOrId}" not found.`);

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(character, null, 2) },
        ],
      };
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

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ characters: list }, null, 2),
          },
        ],
      };
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

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { message: `Setting "${setting.name}" added.`, setting },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // book_setting_get
  server.tool(
    "book_setting_get",
    "Retrieve a setting's details",
    {
      nameOrId: z.string().describe("Setting name or ID"),
    },
    async ({ nameOrId }) => {
      const bible = requireBible();
      const needle = normalizeForCompare(nameOrId);
      const setting = bible.settings.find(
        (s) => s.id === nameOrId || normalizeForCompare(s.name) === needle
      );
      if (!setting)
        throw new BookMCPError(`Setting "${nameOrId}" not found.`);

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(setting, null, 2) },
        ],
      };
    }
  );

  // book_setting_list
  server.tool(
    "book_setting_list",
    "List all settings",
    {},
    async () => {
      const bible = requireBible();
      const list = bible.settings.map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ settings: list }, null, 2),
          },
        ],
      };
    }
  );

  // book_plot_thread_add
  server.tool(
    "book_plot_thread_add",
    "Add an open plot thread",
    {
      title: z.string().describe("Plot thread title"),
      openedIn: z.string().describe("Chapter ID where thread opens"),
      summary: z.string().describe("Thread summary"),
    },
    async ({ title, openedIn, summary }) => {
      const thread: PlotThread = {
        id: "",
        title,
        status: "open",
        openedIn,
        summary,
      };
      await updateStoryBible((bible) => {
        thread.id = generateId(bible.plotThreads, "plot");
        bible.plotThreads.push(thread);
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { message: `Plot thread "${title}" added.`, thread },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // book_plot_thread_resolve
  server.tool(
    "book_plot_thread_resolve",
    "Mark a plot thread as resolved",
    {
      threadId: z.string().describe("Plot thread ID"),
      resolvedIn: z.string().describe("Chapter ID where thread resolves"),
    },
    async ({ threadId, resolvedIn }) => {
      let thread!: PlotThread;
      await updateStoryBible((bible) => {
        const found = bible.plotThreads.find((t) => t.id === threadId);
        if (!found)
          throw new BookMCPError(`Plot thread "${threadId}" not found.`);
        found.status = "resolved";
        found.resolvedIn = resolvedIn;
        thread = found;
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { message: `Plot thread "${thread.title}" resolved.`, thread },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // book_plot_threads_list
  server.tool(
    "book_plot_threads_list",
    "List all plot threads, filtered by status",
    {
      status: z
        .enum(["open", "resolved", "all"])
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

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ threads }, null, 2),
          },
        ],
      };
    }
  );
}
