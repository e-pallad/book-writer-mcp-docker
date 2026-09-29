// The copy edit's two consistency checks: one spelling for each word the style
// sheet names, and one kind of quotation mark.

import { Stylesheet } from "../storage/schema";
import { findText, snippetAt } from "../utils/match";
import { toNFC } from "../utils/text";

export interface VariantHit {
  preferred: string;
  variant: string;
  count: number;
  examples: { chapterId: string; paragraph: number; context: string }[];
}

const EXAMPLES = 3;

export function checkStylesheet(
  sheet: Stylesheet,
  chapters: { id: string; text: string }[]
): VariantHit[] {
  const hits: VariantHit[] = [];
  for (const entry of sheet.entries) {
    for (const variant of entry.variants) {
      let count = 0;
      const examples: VariantHit["examples"] = [];
      for (const chapter of chapters) {
        const text = toNFC(chapter.text);
        const matches = findText(text, variant, {
          wholeWord: true,
          caseSensitive: entry.caseSensitive !== false,
        });
        count += matches.length;
        for (const match of matches) {
          if (examples.length >= EXAMPLES) break;
          const s = snippetAt(text, match.index, match.text.length, 30);
          examples.push({ chapterId: chapter.id, paragraph: s.paragraph, context: `${s.before}${s.match}${s.after}` });
        }
      }
      if (count) hits.push({ preferred: entry.preferred, variant, count, examples });
    }
  }
  return hits.sort((a, b) => b.count - a.count);
}

export interface QuoteReport {
  /** Pairs or marks found, by convention. */
  found: Record<string, number>;
  /** More than one double-quote convention in the same book. */
  mixed: boolean;
  /** Typewriter quotes and apostrophes in a book that should have typographic ones. */
  typewriter: { quotes: number; apostrophes: number };
  expected: string;
  hints: string[];
}

const CONVENTIONS: { name: string; pattern: RegExp }[] = [
  { name: "„…“ (German)", pattern: /„[^“„\n]*“/g },
  { name: "»…« (German guillemets)", pattern: /»[^«»\n]*«/g },
  { name: "«…» (French/Swiss guillemets)", pattern: /«[^«»\n]*»/g },
  { name: "“…” (English)", pattern: /“[^”“\n]*”/g },
  { name: "\"…\" (typewriter)", pattern: /"[^"\n]*"/g },
];

export function checkQuotes(texts: string[], language: string): QuoteReport {
  const all = toNFC(texts.join("\n\n"));
  const german = language.toLowerCase().startsWith("de");
  const found: Record<string, number> = {};
  for (const { name, pattern } of CONVENTIONS) {
    const count = (all.match(pattern) ?? []).length;
    if (count) found[name] = count;
  }
  const typographic = Object.keys(found).filter((n) => !n.includes("typewriter"));
  const mixed = Object.keys(found).length > 1;
  const quotes = found['"…" (typewriter)'] ?? 0;
  // A straight apostrophe between letters: "don't", "geht's".
  const apostrophes = (all.match(/(?<=\p{L})'(?=\p{L})/gu) ?? []).length;

  const expected = german ? "„…“ or »…«" : "“…” (or ‘…’ in British style)";
  const hints: string[] = [];
  if (mixed) {
    hints.push(
      `More than one kind of quotation mark: ${Object.entries(found)
        .map(([n, c]) => `${n} ×${c}`)
        .join(", ")}. Choose one — ${expected} — and replace the rest with book_replace_text.`
    );
  }
  if (quotes && typographic.length === 0) {
    hints.push(`Only typewriter quotes ("…"). Printed books set ${expected}.`);
  }
  if (apostrophes) {
    hints.push(`${apostrophes} typewriter apostrophe(s) (') — printed books use ’.`);
  }
  return { found, mixed, typewriter: { quotes, apostrophes }, expected, hints };
}
