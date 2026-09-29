import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getStoryBible,
  readChapterFile,
  updateOutlineIfPresent,
  updateRegistry,
  updateStoryBible,
  updateTimeline,
} from "../storage/filestore";
import { ChapterMeta, Registry } from "../storage/schema";
import { requireProject } from "../storage/chapters";
import { resolveCharacter } from "../storage/bible";
import { snapshotIfChanged } from "../storage/history";
import { saveChapterContent } from "../storage/writing-log";
import { selectChapters } from "../export/select";
import { BookMCPError } from "../utils/errors";
import { escapeRegExp, normalizeForCompare, toNFC } from "../utils/text";
import { findText, MatchOptions, snippetAt, spliceMatches } from "../utils/match";
import { findPlaceholders } from "../utils/placeholders";

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

const chaptersSchema = z
  .array(z.string())
  .optional()
  .describe("Chapter ids or titles to search (default: every chapter, whatever its status)");

function chaptersToSearch(registry: Registry, refs?: string[]): ChapterMeta[] {
  return selectChapters(registry, refs, { includeAll: true });
}

// Replies stay small: a word that occurs four hundred times in a novel would
// otherwise return a snippet for every one.
const DEFAULT_MAX_RESULTS = 50;

// ---------------------------------------------------------------------------
// Renaming inside free text

interface Rename {
  from: string;
  to: string;
}

/** Applies whole-word renames to a string, returning the text and the count. */
function renameIn(text: string, renames: Rename[]): { text: string; count: number } {
  let result = text;
  let count = 0;
  for (const { from, to } of renames) {
    const matches = findText(result, from, { wholeWord: true, caseSensitive: true });
    if (matches.length) {
      result = spliceMatches(toNFC(result), matches, to);
      count += matches.length;
    }
  }
  return { text: result, count };
}

/**
 * Forms of a name the whole-word rename cannot safely handle: the name with
 * letters stuck to its end, like the German genitive "Maras" or "Maraschino".
 * "Mara's" is fine — the apostrophe ends the word — and is renamed.
 */
function inflectedForms(text: string, name: string): Map<string, number> {
  const forms = new Map<string, number>();
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(toNFC(name))}[\\p{L}]+`, "gu");
  for (const match of toNFC(text).matchAll(pattern)) {
    forms.set(match[0], (forms.get(match[0]) ?? 0) + 1);
  }
  return forms;
}

export function registerBookEditTools(server: McpServer): void {
  // book_todo_list
  server.tool(
    "book_todo_list",
    "List the placeholders left in the text while drafting — [TK], [TODO: …], [RECHERCHE: …], [PRÜFEN: …], [FIXME], [CHECK], [XXX] and a bare TK — with chapter, paragraph and context. Exports warn while any remain.",
    {
      chapters: chaptersSchema,
      kind: z
        .string()
        .optional()
        .describe('Only one kind, e.g. "RECHERCHE" or "TK"'),
    },
    async ({ chapters, kind }) => {
      const registry = requireProject();
      const wanted = kind?.trim().toUpperCase();
      const byKind: Record<string, number> = {};
      const results = chaptersToSearch(registry, chapters).flatMap((chapter) => {
        const found = findPlaceholders(readChapterFile(chapter.filename)).filter(
          (p) => !wanted || p.kind === wanted
        );
        for (const p of found) byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;
        return found.length
          ? [{ chapterId: chapter.id, title: chapter.title, status: chapter.status, placeholders: found }]
          : [];
      });
      const total = results.reduce((sum, r) => sum + r.placeholders.length, 0);
      return jsonResult({
        total,
        byKind,
        chapters: results,
        ...(total === 0 ? { message: "No placeholders left." } : {}),
      });
    }
  );

  // book_find
  server.tool(
    "book_find",
    "Find text across the whole book — every chapter, or the ones named — with chapter, paragraph number and context for each occurrence. Use it before a book-wide change, or to see how often a word is used.",
    {
      query: z.string().describe("Text to look for. Literal — no wildcards or regular expressions."),
      chapters: chaptersSchema,
      wholeWord: z
        .boolean()
        .optional()
        .default(false)
        .describe('Only whole words: "Mara" but not "Maraschino" (default: false)'),
      caseSensitive: z.boolean().optional().default(true).describe("Match case exactly (default: true)"),
      contextChars: z.number().optional().default(60).describe("Characters of context either side (default: 60)"),
      maxResults: z
        .number()
        .optional()
        .default(DEFAULT_MAX_RESULTS)
        .describe(`Occurrences to show; the counts always cover every match (default: ${DEFAULT_MAX_RESULTS})`),
    },
    async ({ query, chapters, wholeWord, caseSensitive, contextChars, maxResults }) => {
      if (!query) throw new BookMCPError("A search query cannot be empty.");
      const registry = requireProject();
      const options: MatchOptions = { wholeWord, caseSensitive };

      let shown = 0;
      let total = 0;
      const results = chaptersToSearch(registry, chapters).flatMap((chapter) => {
        const content = toNFC(readChapterFile(chapter.filename));
        const matches = findText(content, query, options);
        if (!matches.length) return [];
        total += matches.length;
        const visible = matches.slice(0, Math.max(0, maxResults - shown));
        shown += visible.length;
        return [
          {
            chapterId: chapter.id,
            title: chapter.title,
            matches: matches.length,
            occurrences: visible.map((m) => snippetAt(content, m.index, m.text.length, contextChars)),
          },
        ];
      });

      return jsonResult({
        query,
        totalMatches: total,
        chaptersWithMatches: results.length,
        results,
        ...(shown < total
          ? { truncated: `Showing ${shown} of ${total} occurrences; every count is complete.` }
          : {}),
        ...(total === 0
          ? {
              hint: caseSensitive
                ? "Nothing matched. The search is case-sensitive; try caseSensitive=false."
                : "Nothing matched.",
            }
          : {}),
      });
    }
  );

  // book_replace_text
  server.tool(
    "book_replace_text",
    "Replace text across the whole book, or the chapters named. Runs as a dry run unless dryRun=false, so the change can be reviewed first. Each changed chapter's previous text is filed in its history, so book_chapter_revert undoes the change chapter by chapter.",
    {
      oldText: z.string().describe("Text to replace. Literal — no wildcards or regular expressions."),
      newText: z.string().describe("What to put in its place (empty to delete)"),
      chapters: chaptersSchema,
      wholeWord: z
        .boolean()
        .optional()
        .default(false)
        .describe("Only whole words (default: false). Recommended for names and single words."),
      caseSensitive: z.boolean().optional().default(true).describe("Match case exactly (default: true)"),
      expectedCount: z
        .number()
        .optional()
        .describe(
          "The number of replacements you expect — from a dry run. If the book no longer matches it, nothing is written."
        ),
      dryRun: z
        .boolean()
        .optional()
        .default(true)
        .describe("Report what would change and write nothing (default: true)"),
    },
    async ({ oldText, newText, chapters, wholeWord, caseSensitive, expectedCount, dryRun }) => {
      if (!oldText) throw new BookMCPError("oldText cannot be empty — there would be nothing to find.");
      const options: MatchOptions = { wholeWord, caseSensitive };
      const replacement = toNFC(newText);

      const plan = (registry: Registry) =>
        chaptersToSearch(registry, chapters).flatMap((chapter) => {
          const content = toNFC(readChapterFile(chapter.filename));
          const matches = findText(content, oldText, options);
          return matches.length ? [{ chapter, content, matches }] : [];
        });

      const describe = (planned: ReturnType<typeof plan>) =>
        planned.map(({ chapter, content, matches }) => ({
          chapterId: chapter.id,
          title: chapter.title,
          matches: matches.length,
          // One example per chapter keeps a large change reviewable.
          example: snippetAt(content, matches[0].index, matches[0].text.length, 50),
          ...(new Set(matches.map((m) => m.text)).size > 1
            ? { variants: [...new Set(matches.map((m) => m.text))] }
            : {}),
        }));

      if (dryRun) {
        const planned = plan(requireProject());
        const total = planned.reduce((sum, p) => sum + p.matches.length, 0);
        return jsonResult({
          dryRun: true,
          wouldReplace: total,
          chapters: describe(planned),
          ...(total
            ? {
                next: `Run again with dryRun=false and expectedCount=${total} to apply it.`,
              }
            : { hint: "Nothing matched, so nothing would change." }),
        });
      }

      let planned!: ReturnType<typeof plan>;
      const saved: { chapterId: string; previousVersionSaved: string | null }[] = [];
      await updateRegistry((registry) => {
        planned = plan(registry);
        const total = planned.reduce((sum, p) => sum + p.matches.length, 0);
        if (expectedCount !== undefined && expectedCount !== total) {
          throw new BookMCPError(
            `Expected ${expectedCount} replacement(s) but the book now has ${total}. Nothing was written; run a dry run again.`
          );
        }
        for (const { chapter, content, matches } of planned) {
          const next = spliceMatches(content, matches, replacement);
          const snapshot = snapshotIfChanged(chapter.id, chapter.filename, next);
          saveChapterContent(registry, chapter, next);
          saved.push({ chapterId: chapter.id, previousVersionSaved: snapshot });
        }
        if (!planned.length) return false;
      });

      const total = planned.reduce((sum, p) => sum + p.matches.length, 0);
      return jsonResult({
        message: total
          ? `Replaced ${total} occurrence(s) in ${planned.length} chapter(s).`
          : "Nothing matched, so nothing was changed.",
        replaced: total,
        chapters: describe(planned).map((entry, i) => ({ ...entry, ...saved[i] })),
        ...(total ? { hint: "book_chapter_revert restores any one chapter to its previous version." } : {}),
      });
    }
  );

  // book_character_rename
  server.tool(
    "book_character_rename",
    "Rename a character everywhere: the story bible, the prose of every chapter, chapter and outline synopses, timeline events and other characters' notes. Whole-word and case-sensitive, so 'Mara' never touches 'Maraschino'. Forms the rename cannot safely handle — the German genitive 'Maras', for one — are reported, not guessed at. Each changed chapter's previous text is filed in its history.",
    {
      characterId: z.string().describe("Character id, name or alias"),
      newName: z.string().describe("The new full name"),
      renameParts: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "When old and new name have the same number of words, also rename each changed word on its own — 'Vance' to 'Reed' in 'Mara Vance' → 'Mara Reed'. A word another character's name shares is never renamed on its own. (default: true)"
        ),
      includeGenitive: z
        .boolean()
        .optional()
        .default(false)
        .describe("Also rename the name followed by -s ('Maras' → 'Reeds'), as German genitives are written (default: false)"),
      keepOldNameAsAlias: z
        .boolean()
        .optional()
        .default(false)
        .describe("Keep the old name as an alias (default: false)"),
      dryRun: z.boolean().optional().default(false).describe("Report what would change and write nothing"),
    },
    async ({ characterId, newName, renameParts, includeGenitive, keepOldNameAsAlias, dryRun }) => {
      const target = newName.trim();
      if (!target) throw new BookMCPError("The new name cannot be empty.");

      const bible = getStoryBible();
      if (!bible) throw new BookMCPError("No story bible found. Run book_init first.");
      const character = resolveCharacter(bible, characterId);
      const oldName = character.name;
      if (oldName === target) throw new BookMCPError(`The character is already called "${target}".`);

      const clash = bible.characters.find(
        (c) =>
          c.id !== character.id &&
          [c.name, ...c.aliases].some((n) => normalizeForCompare(n) === normalizeForCompare(target))
      );
      if (clash) {
        throw new BookMCPError(`"${target}" is already the name of ${clash.name} (${clash.id}).`);
      }

      // What gets renamed: the full name, then each changed word of it on its
      // own, unless another character answers to that word too.
      const renames: Rename[] = [{ from: oldName, to: target }];
      const skippedParts: string[] = [];
      const oldParts = oldName.split(/\s+/);
      const newParts = target.split(/\s+/);
      if (renameParts && oldParts.length > 1 && oldParts.length === newParts.length) {
        const othersWords = new Set(
          bible.characters
            .filter((c) => c.id !== character.id)
            .flatMap((c) => [c.name, ...c.aliases])
            .flatMap((n) => n.split(/\s+/))
            .map((w) => normalizeForCompare(w))
        );
        oldParts.forEach((part, i) => {
          if (part === newParts[i]) return;
          if (othersWords.has(normalizeForCompare(part))) {
            skippedParts.push(part);
            return;
          }
          renames.push({ from: part, to: newParts[i] });
        });
      }
      if (includeGenitive) {
        for (const { from, to } of [...renames]) renames.push({ from: `${from}s`, to: `${to}s` });
      }

      const registry = requireProject();
      const perChapter = registry.chapters
        .map((chapter) => {
          const content = toNFC(readChapterFile(chapter.filename));
          const { text, count } = renameIn(content, renames);
          return { chapter, content, next: text, count };
        })
        .filter((c) => c.count > 0);

      // Forms left alone, looked for in the text as it will be after the rename.
      const unreplaced = new Map<string, { count: number; chapters: string[] }>();
      for (const chapter of registry.chapters) {
        const planned = perChapter.find((c) => c.chapter.id === chapter.id);
        const text = planned ? planned.next : readChapterFile(chapter.filename);
        for (const { from } of renames) {
          for (const [form, count] of inflectedForms(text, from)) {
            const entry = unreplaced.get(form) ?? { count: 0, chapters: [] };
            entry.count += count;
            if (!entry.chapters.includes(chapter.id)) entry.chapters.push(chapter.id);
            unreplaced.set(form, entry);
          }
        }
      }

      const summary = {
        renames,
        chapters: perChapter.map((c) => ({
          chapterId: c.chapter.id,
          title: c.chapter.title,
          replaced: c.count,
        })),
        replacedInProse: perChapter.reduce((sum, c) => sum + c.count, 0),
        ...(skippedParts.length
          ? {
              skippedParts: skippedParts.map(
                (part) => `"${part}" on its own was left alone: another character's name contains it.`
              ),
            }
          : {}),
        ...(unreplaced.size
          ? {
              notReplaced: [...unreplaced].map(([form, entry]) => ({ form, ...entry })),
              notReplacedHint:
                "These forms carry the old name with letters attached — a genitive, a compound, another word. They were left alone; check them with book_find and change them with book_replace_text (or pass includeGenitive=true for -s genitives).",
            }
          : {}),
      };

      if (dryRun) return jsonResult({ dryRun: true, character: oldName, newName: target, ...summary });

      let elsewhere = 0;
      const applied: { chapterId: string; title: string; replaced: number }[] = [];
      await updateRegistry(async (current) => {
        // Recomputed under the lock, over the chapters as they are now: one
        // created or edited since the plan above is renamed like the rest.
        for (const chapter of current.chapters) {
          const content = toNFC(readChapterFile(chapter.filename));
          const { text, count } = renameIn(content, renames);
          if (!count) continue;
          snapshotIfChanged(chapter.id, chapter.filename, text);
          saveChapterContent(current, chapter, text);
          applied.push({ chapterId: chapter.id, title: chapter.title, replaced: count });
        }
        for (const chapter of current.chapters) {
          const renamed = renameIn(chapter.synopsis, renames);
          chapter.synopsis = renamed.text;
          elsewhere += renamed.count;
        }

        // Nested in the registry transaction, in the one order used anywhere:
        // registry, then story bible, then timeline, then outline.
        await updateStoryBible((b) => {
          const self = b.characters.find((c) => c.id === character.id);
          if (!self) throw new BookMCPError(`Character "${oldName}" disappeared while renaming.`);
          self.name = target;
          if (keepOldNameAsAlias && !self.aliases.includes(oldName)) self.aliases.push(oldName);

          const rename = (value: string) => {
            const r = renameIn(value, renames);
            elsewhere += r.count;
            return r.text;
          };
          for (const c of b.characters) {
            if (c.id !== character.id) {
              c.description = rename(c.description);
              c.backstory = rename(c.backstory);
              c.notes = rename(c.notes);
            }
            for (const rel of c.relationships) rel.nature = rename(rel.nature);
          }
          for (const t of b.plotThreads) {
            t.title = rename(t.title);
            t.summary = rename(t.summary);
          }
          for (const s of b.settings) {
            s.description = rename(s.description);
            s.notes = rename(s.notes);
          }
        });
        await updateTimeline((timeline) => {
          for (const event of timeline.events) {
            const e = renameIn(event.event, renames);
            const n = renameIn(event.notes, renames);
            event.event = e.text;
            event.notes = n.text;
            elsewhere += e.count + n.count;
          }
        });
        await updateOutlineIfPresent((outline) => {
          let changed = 0;
          for (const act of outline.acts) {
            for (const chapter of act.chapters) {
              const r = renameIn(chapter.synopsis, renames);
              chapter.synopsis = r.text;
              changed += r.count;
              chapter.scenes = chapter.scenes?.map((scene) => {
                const s = renameIn(scene, renames);
                changed += s.count;
                return s.text;
              });
            }
          }
          elsewhere += changed;
          return changed ? undefined : false;
        });
      });

      return jsonResult({
        message: `"${oldName}" is now "${target}".`,
        ...summary,
        chapters: applied,
        replacedInProse: applied.reduce((sum, c) => sum + c.replaced, 0),
        replacedElsewhere: elsewhere,
        ...(keepOldNameAsAlias ? { alias: `"${oldName}" kept as an alias.` } : {}),
        hint: "Each changed chapter's previous text was filed; book_chapter_revert restores it.",
      });
    }
  );
}

