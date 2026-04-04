import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getStoryBible, saveStoryBible } from "../storage/filestore";
import { Character, Setting, PlotThread } from "../storage/schema";
import { BookMCPError } from "../utils/errors";

function generateId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}`;
}

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
    },
    async (input) => {
      const bible = requireBible();
      const character: Character = {
        id: generateId("char"),
        name: input.name,
        aliases: input.aliases,
        role: input.role,
        description: input.description,
        backstory: input.backstory,
        traits: input.traits,
        relationships: input.relationships,
        firstAppearance: input.firstAppearance,
        notes: input.notes,
      };
      bible.characters.push(character);
      saveStoryBible(bible);

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
        })
        .describe("Fields to update"),
    },
    async ({ characterId, updates }) => {
      const bible = requireBible();
      const character = bible.characters.find((c) => c.id === characterId);
      if (!character)
        throw new BookMCPError(`Character "${characterId}" not found.`);

      Object.assign(character, updates);
      saveStoryBible(bible);

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
      const character = bible.characters.find(
        (c) =>
          c.id === nameOrId ||
          c.name.toLowerCase() === nameOrId.toLowerCase() ||
          c.aliases.some((a) => a.toLowerCase() === nameOrId.toLowerCase())
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
      const bible = requireBible();
      const setting: Setting = {
        id: generateId("set"),
        name: input.name,
        description: input.description,
        type: input.type,
        notes: input.notes,
      };
      bible.settings.push(setting);
      saveStoryBible(bible);

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
      const setting = bible.settings.find(
        (s) =>
          s.id === nameOrId ||
          s.name.toLowerCase() === nameOrId.toLowerCase()
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
      const bible = requireBible();
      const thread: PlotThread = {
        id: generateId("plot"),
        title,
        status: "open",
        openedIn,
        summary,
      };
      bible.plotThreads.push(thread);
      saveStoryBible(bible);

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
      const bible = requireBible();
      const thread = bible.plotThreads.find((t) => t.id === threadId);
      if (!thread)
        throw new BookMCPError(`Plot thread "${threadId}" not found.`);

      thread.status = "resolved";
      thread.resolvedIn = resolvedIn;
      saveStoryBible(bible);

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
