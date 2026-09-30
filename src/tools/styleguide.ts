import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getStoryBible,
  getStyleGuide,
  updateStyleGuide,
  writeStyleGuide,
} from "../storage/filestore";
import {
  attributeDialogue,
  checkVoice,
  checkVoiceConfusion,
  extractDialogue,
} from "./voice";
import { BookMCPError } from "../utils/errors";
import { normalizeForCompare } from "../utils/text";
import { languageNote, projectLanguage } from "../lang";
import { checkStyle } from "./style-rules";
import { briefSchema, writeReply } from "./brief";

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
      brief: briefSchema,
    },
    async ({ brief, ...guide }) => {
      await writeStyleGuide(guide);
      return writeReply(brief, { message: "Style guide saved.", guide }, { id: "style", status: "updated" });
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
    "Check a passage against the style guide. Given a character, also checks that character's dialogue against their own voice profile, flagging lines that do not sound like them.",
    {
      passage: z.string().describe("Text passage to check"),
      chapterId: z.string().optional().describe("Optional chapter ID for context"),
      characterId: z
        .string()
        .optional()
        .describe(
          "Optional character whose dialogue this passage is. Given one, the passage is checked against their voice profile as well as the global style guide."
        ),
    },
    async ({ passage, chapterId, characterId }) => {
      const guide = getStyleGuide();
      if (!guide)
        throw new BookMCPError("No style guide found. Use book_style_set to create one.");

      const language = projectLanguage();
      const { violations, skipped } = checkStyle(passage, guide, language.rules);

      // Everything above judges the passage as prose. What follows judges one
      // character's dialogue inside it, which is a different question: the
      // style guide is the book's voice, a voice profile is one person's.
      const voiceViolations: {
        rule: string;
        excerpt: string;
        suggestion: string;
      }[] = [];
      let voiceSummary: Record<string, unknown> | undefined;

      if (characterId !== undefined) {
        const bible = getStoryBible();
        if (!bible)
          throw new BookMCPError("No story bible found. Run book_init first.");

        const needle = normalizeForCompare(characterId);
        const character = bible.characters.find(
          (c) =>
            c.id === characterId ||
            normalizeForCompare(c.name) === needle ||
            c.aliases.some((a) => normalizeForCompare(a) === needle)
        );
        if (!character)
          throw new BookMCPError(`Character "${characterId}" not found.`);

        if (!character.voiceProfile) {
          voiceSummary = {
            character: character.name,
            checked: false,
            note: `${character.name} has no voice profile. Add one with book_character_update to check their dialogue against it.`,
          };
        } else {
          const dialogue = extractDialogue(passage, language.rules);
          if (!language.rules) skipped.push("speakerTags");
          const { own, others } = attributeDialogue(character, dialogue);

          voiceViolations.push(...checkVoice(character, own));
          voiceViolations.push(
            ...checkVoiceConfusion(character, own, bible.characters)
          );

          voiceSummary = {
            character: character.name,
            checked: true,
            dialogueLinesFound: dialogue.length,
            linesAttributedToCharacter: own.length,
            linesAttributedToOthers: others.length,
            voiceProfile: character.voiceProfile,
            ...(dialogue.length === 0
              ? {
                  note: "No quoted dialogue found in this passage, so only the global style guide was applied.",
                }
              : {}),
          };
        }
      }

      const allViolations = [...violations, ...voiceViolations];

      // A passage whose language-dependent checks could not run has not been
      // shown to be clean, and is not reported as if it had.
      let score: "clean" | "partially_checked" | "minor_issues" | "needs_work";
      if (allViolations.length === 0) score = skipped.length ? "partially_checked" : "clean";
      else if (allViolations.length <= 2) score = "minor_issues";
      else score = "needs_work";
      const languageMessage = languageNote(language, skipped);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                violations: allViolations,
                styleViolations: violations,
                voiceViolations,
                score,
                language: language.tag,
                ...(skipped.length ? { checksSkipped: skipped } : {}),
                ...(languageMessage ? { languageNote: languageMessage } : {}),
                chapterId,
                ...(voiceSummary ? { voice: voiceSummary } : {}),
              },
              null,
              2
            ),
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
      brief: briefSchema,
    },
    async ({ brief, ...input }) => {
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

      return writeReply(
        brief,
        {
          message: `Author influence "${input.author}" added to style guide.`,
          influence: input,
          totalInfluences,
        },
        { id: input.author, status: "created" }
      );
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
      brief: briefSchema,
    },
    async ({ author, brief }) => {
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

      return writeReply(
        brief,
        {
          message: removed > 0
            ? `Removed influence "${author}".`
            : `Author "${author}" not found in influences.`,
          removed,
          remaining,
        },
        { id: author, status: removed > 0 ? "deleted" : "unchanged" }
      );
    }
  );
}
