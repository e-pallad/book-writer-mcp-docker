import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getRegistry,
  getStoryBible,
  readChapterFile,
} from "../storage/filestore";
import { BookMCPError } from "../utils/errors";
import { CAPITALIZED_WORD_PATTERN, normalizeForCompare } from "../utils/text";

interface ContinuityFlag {
  type: "character" | "timeline" | "setting" | "plot_thread";
  severity: "error" | "warning";
  description: string;
  suggestion: string;
}

export function registerContinuityTools(server: McpServer): void {
  server.tool(
    "book_continuity_check",
    "Cross-reference a chapter draft against the story bible for continuity issues",
    {
      chapterId: z.string().describe("Chapter ID to check"),
    },
    async ({ chapterId }) => {
      const registry = getRegistry();
      if (!registry)
        throw new BookMCPError("No book project found. Run book_init first.");

      const bible = getStoryBible();
      if (!bible)
        throw new BookMCPError("No story bible found. Run book_init first.");

      const chapter = registry.chapters.find((c) => c.id === chapterId);
      if (!chapter)
        throw new BookMCPError(`Chapter "${chapterId}" not found.`);

      const content = readChapterFile(chapter.filename);
      const contentLower = normalizeForCompare(content);
      const flags: ContinuityFlag[] = [];

      // Check character name consistency
      for (const character of bible.characters) {
        const nameFound = contentLower.includes(normalizeForCompare(character.name));
        const aliasFound = character.aliases.some((a) =>
          contentLower.includes(normalizeForCompare(a))
        );

        if (nameFound || aliasFound) {
          // Check if character traits are contradicted
          for (const trait of character.traits) {
            const traitLower = trait.toLowerCase();
            // Look for obvious contradictions (e.g., "tall" character described as "short")
            const opposites: Record<string, string[]> = {
              tall: ["short", "small", "tiny", "petite"],
              short: ["tall", "towering", "giant"],
              old: ["young", "youthful", "teenage"],
              young: ["old", "elderly", "aged", "ancient"],
              thin: ["fat", "heavy", "obese", "large"],
              fat: ["thin", "slim", "slender", "skinny"],
              blonde: ["brunette", "dark-haired", "black-haired", "redhead"],
              brunette: ["blonde", "fair-haired", "redhead"],
            };

            const traitOpposites = opposites[traitLower] || [];
            for (const opp of traitOpposites) {
              if (contentLower.includes(opp)) {
                // Check if it's near the character's name
                const nameIdx = contentLower.indexOf(normalizeForCompare(character.name));
                const oppIdx = contentLower.indexOf(opp);
                if (Math.abs(nameIdx - oppIdx) < 200) {
                  flags.push({
                    type: "character",
                    severity: "error",
                    description: `Character "${character.name}" is described as "${trait}" in story bible but "${opp}" appears near their name in this chapter.`,
                    suggestion: `Verify the description of ${character.name} matches the story bible trait "${trait}".`,
                  });
                }
              }
            }
          }
        }
      }

      // Check for characters mentioned but not in the story bible.
      // The pattern is Unicode-aware: [A-Z][a-z]{2,} never matched a name like
      // "Jörg" or "Émile", so those characters were silently skipped here.
      const words = content.normalize("NFC").match(CAPITALIZED_WORD_PATTERN) || [];
      const capitalizedWords = [...new Set(words)];
      const knownNames = new Set(
        bible.characters.flatMap((c) => [
          normalizeForCompare(c.name),
          ...c.aliases.map((a) => normalizeForCompare(a)),
        ])
      );
      const commonWords = new Set([
        "the", "and", "but", "for", "not", "you", "all", "can", "had", "her",
        "was", "one", "our", "out", "are", "has", "his", "how", "its", "may",
        "new", "now", "old", "see", "way", "who", "did", "get", "let", "say",
        "she", "too", "use", "chapter", "scene", "part", "then", "than",
        "that", "this", "with", "have", "from", "they", "been", "said",
        "each", "make", "like", "long", "look", "many", "some", "them",
        "into", "time", "very", "when", "come", "just", "know", "take",
        "people", "could", "would", "about", "after", "before", "where",
        "should", "still", "their", "there", "these", "those", "being",
        "first", "never", "other", "right", "think", "which", "while",
        "back", "down", "even", "here", "much", "only", "over", "such",
        "well", "what", "will", "also", "more", "must", "most", "went",
      ]);

      for (const word of capitalizedWords) {
        if (
          !knownNames.has(normalizeForCompare(word)) &&
          !commonWords.has(normalizeForCompare(word)) &&
          word.length > 2
        ) {
          // Could be an unregistered character
          const isLikelyName =
            content.includes(`${word} said`) ||
            content.includes(`${word} asked`) ||
            content.includes(`${word} replied`) ||
            content.includes(`${word} whispered`) ||
            content.includes(`${word} shouted`);

          if (isLikelyName) {
            flags.push({
              type: "character",
              severity: "warning",
              description: `"${word}" appears to be a character (used with dialogue tags) but is not in the story bible.`,
              suggestion: `Add "${word}" to the story bible using book_character_add.`,
            });
          }
        }
      }

      // Check for setting references
      for (const setting of bible.settings) {
        if (contentLower.includes(normalizeForCompare(setting.name))) {
          // Setting is referenced — good
        }
      }

      // Check open plot threads that should be referenced
      const chapterOrder = chapter.order;
      for (const thread of bible.plotThreads) {
        if (thread.status === "open") {
          const openedChapter = registry.chapters.find(
            (c) => c.id === thread.openedIn
          );
          if (
            openedChapter &&
            chapterOrder - openedChapter.order > 5 &&
            !contentLower.includes(normalizeForCompare(thread.title))
          ) {
            flags.push({
              type: "plot_thread",
              severity: "warning",
              description: `Open plot thread "${thread.title}" (opened in ${thread.openedIn}) hasn't been referenced in ${chapterOrder - openedChapter.order} chapters.`,
              suggestion: `Consider weaving in the "${thread.title}" plot thread or resolving it.`,
            });
          }
        }
      }

      let summary: string;
      const errorCount = flags.filter((f) => f.severity === "error").length;
      const warningCount = flags.filter((f) => f.severity === "warning").length;

      if (flags.length === 0) {
        summary = "No continuity issues detected.";
      } else {
        summary = `Found ${errorCount} error(s) and ${warningCount} warning(s).`;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ flags, summary }, null, 2),
          },
        ],
      };
    }
  );
}
