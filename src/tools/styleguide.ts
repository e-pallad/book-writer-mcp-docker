import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getStyleGuide,
  updateStyleGuide,
  writeStyleGuide,
} from "../storage/filestore";
import { BookMCPError } from "../utils/errors";
import { normalizeForCompare, wholeWordRegExp } from "../utils/text";

export function registerStyleGuideTools(server: McpServer): void {
  server.tool(
    "book_style_set",
    "Set the full style guide for the book",
    {
      voice: z.string().describe("Voice description"),
      pov: z.string().describe("Point of view"),
      tense: z.enum(["past", "present", "future"]).describe("Narrative tense"),
      tone: z.string().describe("Tone description"),
      targetAudience: z.string().describe("Target audience"),
      sentenceStyle: z.string().describe("Sentence style guidelines"),
      thingsToAvoid: z.array(z.string()).describe("Things to avoid in writing"),
      recurringMotifs: z.array(z.string()).describe("Recurring motifs"),
      samplePassage: z.string().describe("Sample passage for tone matching"),
    },
    async (input) => {
      await writeStyleGuide(input);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ message: "Style guide saved.", guide: input }, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "book_style_get",
    "Retrieve the style guide",
    {},
    async () => {
      const guide = getStyleGuide();
      if (!guide)
        throw new BookMCPError("No style guide found. Use book_style_set to create one.");
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(guide, null, 2) },
        ],
      };
    }
  );

  server.tool(
    "book_style_check",
    "Check a passage against the style guide rules",
    {
      passage: z.string().describe("Text passage to check"),
      chapterId: z.string().optional().describe("Optional chapter ID for context"),
    },
    async ({ passage, chapterId }) => {
      const guide = getStyleGuide();
      if (!guide)
        throw new BookMCPError("No style guide found. Use book_style_set to create one.");

      const violations: { rule: string; excerpt: string; suggestion: string }[] = [];

      // Check tense
      if (guide.tense === "past") {
        const presentIndicators = /\b(he says|she says|they say|I say|he walks|she walks|they walk|I walk|he runs|she runs)\b/gi;
        const matches = passage.match(presentIndicators);
        if (matches) {
          violations.push({
            rule: "Tense: should be past tense",
            excerpt: matches.slice(0, 3).join(", "),
            suggestion: "Convert present tense verbs to past tense.",
          });
        }
      } else if (guide.tense === "present") {
        const pastIndicators = /\b(he said|she said|they said|I said|he walked|she walked|they walked|I walked)\b/gi;
        const matches = passage.match(pastIndicators);
        if (matches) {
          violations.push({
            rule: "Tense: should be present tense",
            excerpt: matches.slice(0, 3).join(", "),
            suggestion: "Convert past tense verbs to present tense.",
          });
        }
      }

      // Check passive voice
      const passivePattern = /\b(was|were|is|are|been|being)\s+\w+ed\b/gi;
      const passiveMatches = passage.match(passivePattern);
      if (passiveMatches && passiveMatches.length > 3) {
        violations.push({
          rule: "Excessive passive voice detected",
          excerpt: passiveMatches.slice(0, 3).join(", "),
          suggestion: "Rewrite in active voice where possible.",
        });
      }

      // Check things to avoid
      for (const avoidance of guide.thingsToAvoid) {
        // Unicode-aware boundaries: \b would never match a term that starts or
        // ends with a non-ASCII letter, so "Übertreibung" went unflagged.
        const regex = wholeWordRegExp(avoidance);
        const matches = passage.normalize("NFC").match(regex);
        if (matches) {
          violations.push({
            rule: `Avoid: "${avoidance}"`,
            excerpt: matches[0],
            suggestion: `Remove or rephrase to avoid "${avoidance}".`,
          });
        }
      }

      // Check POV consistency
      if (guide.pov.toLowerCase().includes("first person")) {
        const thirdPersonNarration = /\b(he thought|she thought|he felt|she felt|he knew|she knew)\b/gi;
        const matches = passage.match(thirdPersonNarration);
        if (matches) {
          violations.push({
            rule: "POV: first person narration shouldn't use third-person internal thoughts",
            excerpt: matches.slice(0, 3).join(", "),
            suggestion: "Rewrite internal thoughts from first person perspective.",
          });
        }
      } else if (guide.pov.toLowerCase().includes("third person")) {
        const firstPersonNarration = /\b(I thought|I felt|I knew|I wondered)\b/gi;
        const matches = passage.match(firstPersonNarration);
        if (matches) {
          violations.push({
            rule: "POV: third person narration shouldn't use first-person internal thoughts",
            excerpt: matches.slice(0, 3).join(", "),
            suggestion: "Rewrite from third person perspective.",
          });
        }
      }

      let score: "clean" | "minor_issues" | "needs_work";
      if (violations.length === 0) score = "clean";
      else if (violations.length <= 2) score = "minor_issues";
      else score = "needs_work";

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ violations, score, chapterId }, null, 2),
          },
        ],
      };
    }
  );

  // book_style_add_influence
  server.tool(
    "book_style_add_influence",
    "Add an author influence to the style guide. Reference well-known authors whose voice, technique, or style should shape the writing.",
    {
      author: z.string().describe("Author name (e.g. 'Cormac McCarthy', 'Donna Tartt', 'Haruki Murakami')"),
      works: z.array(z.string()).describe("Specific works to draw from (e.g. ['Blood Meridian', 'The Road'])"),
      elementsToEmulate: z
        .array(z.string())
        .describe(
          "Specific elements to draw from this author (e.g. ['sparse dialogue tags', 'long unpunctuated sentences', 'mythic imagery', 'unreliable narration', 'dry humor'])"
        ),
      notes: z.string().optional().default("").describe("Additional notes on how this influence should manifest"),
    },
    async (input) => {
      let totalInfluences = 0;
      await updateStyleGuide((guide) => {
        if (!guide.influences) guide.influences = [];
        guide.influences.push({
          author: input.author,
          works: input.works,
          elementsToEmulate: input.elementsToEmulate,
          notes: input.notes,
        });
        totalInfluences = guide.influences.length;
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                message: `Author influence "${input.author}" added to style guide.`,
                influence: input,
                totalInfluences,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // book_style_list_influences
  server.tool(
    "book_style_list_influences",
    "List all author influences in the style guide",
    {},
    async () => {
      const guide = getStyleGuide();
      if (!guide)
        throw new BookMCPError("No style guide found. Use book_style_set first.");

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { influences: guide.influences || [] },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // book_style_remove_influence
  server.tool(
    "book_style_remove_influence",
    "Remove an author influence from the style guide",
    {
      author: z.string().describe("Author name to remove"),
    },
    async ({ author }) => {
      let removed = 0;
      let remaining = 0;
      await updateStyleGuide((guide) => {
        if (!guide.influences) guide.influences = [];
        const before = guide.influences.length;
        guide.influences = guide.influences.filter(
          (i) => normalizeForCompare(i.author) !== normalizeForCompare(author)
        );
        removed = before - guide.influences.length;
        remaining = guide.influences.length;
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                message: removed > 0
                  ? `Removed influence "${author}".`
                  : `Author "${author}" not found in influences.`,
                removed,
                remaining,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
