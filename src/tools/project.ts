import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getCoverSpec, updateRegistry } from "../storage/filestore";
import { Registry } from "../storage/schema";
import { BookMCPError } from "../utils/errors";
import { isValidLanguageTag, rulesFor, supportedLanguages } from "../lang";

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

// The fields book_init sets and nothing could change afterwards: a working
// title that became the real one, a target that grew, a language that was
// never set on a project created before the field existed.
type Editable = Pick<Registry, "title" | "author" | "genre" | "targetWordCount" | "language">;

export function registerProjectTools(server: McpServer): void {
  server.tool(
    "book_project_update",
    "Change the book's own details after book_init: title, author, genre, target word count and the language it is written in. Every field is optional.",
    {
      title: z.string().optional().describe("Book title"),
      author: z.string().optional().describe("Author name"),
      genre: z.string().optional().describe("Genre"),
      targetWordCount: z.number().optional().describe("Target word count"),
      language: z
        .string()
        .optional()
        .describe(
          'Language the book is written in, as a BCP 47 tag ("de", "en-GB"). Picks the rules for the style and continuity checks and the language exports declare.'
        ),
    },
    async (input) => {
      const changes = Object.fromEntries(
        Object.entries(input).filter(([, value]) => value !== undefined)
      ) as Partial<Editable>;

      if (Object.keys(changes).length === 0) {
        throw new BookMCPError(
          "Nothing to update: pass at least one of title, author, genre, targetWordCount or language."
        );
      }
      for (const field of ["title", "author"] as const) {
        if (changes[field] !== undefined && !changes[field]!.trim()) {
          throw new BookMCPError(`The ${field} cannot be empty.`);
        }
      }
      if (
        changes.targetWordCount !== undefined &&
        (!Number.isFinite(changes.targetWordCount) || changes.targetWordCount <= 0)
      ) {
        throw new BookMCPError("targetWordCount must be a positive number.");
      }
      if (changes.language !== undefined) {
        if (!isValidLanguageTag(changes.language)) {
          throw new BookMCPError(
            `"${changes.language}" is not a language tag. Use a BCP 47 tag such as "de", "en" or "en-GB".`
          );
        }
        changes.language = changes.language.trim();
      }

      const previous: Partial<Editable> = {};
      const registry = await updateRegistry((registry) => {
        for (const [key, value] of Object.entries(changes) as [keyof Editable, never][]) {
          (previous as Record<string, unknown>)[key] = registry[key];
          registry[key] = typeof value === "string" ? ((value as string).trim() as never) : value;
        }
      });

      const notes: string[] = [];
      if (changes.language !== undefined) {
        const rules = rulesFor(changes.language);
        notes.push(
          rules
            ? `Style and continuity checks now use the ${rules.name} rules.`
            : `No rules are available for "${changes.language}" (supported: ${supportedLanguages().join(
                ", "
              )}); checks that depend on the language will say they did not run.`
        );
      }
      // The cover spec keeps its own copy of the title and author, because a
      // cover can legitimately differ (a series name, a pen name). Say so
      // rather than silently leaving them out of step.
      const spec = getCoverSpec();
      if (spec && changes.title !== undefined && spec.title !== registry.title) {
        notes.push(
          `The cover spec still says "${spec.title}". Update it with book_cover_create_spec if the cover should carry the new title.`
        );
      }
      if (spec && changes.author !== undefined && spec.authorName !== registry.author) {
        notes.push(`The cover spec still names "${spec.authorName}" as the author.`);
      }

      return jsonResult({
        message: "Project details updated.",
        changed: Object.fromEntries(
          Object.keys(changes).map((key) => [
            key,
            { from: previous[key as keyof Editable] ?? null, to: registry[key as keyof Editable] },
          ])
        ),
        project: {
          title: registry.title,
          author: registry.author,
          genre: registry.genre,
          targetWordCount: registry.targetWordCount,
          language: registry.language ?? null,
        },
        ...(notes.length ? { notes } : {}),
      });
    }
  );
}
