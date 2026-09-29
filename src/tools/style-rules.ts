// The prose half of book_style_check: the passage against the style guide.
// Kept apart from the tool registration so it can be type-checked and tested
// on its own; see tsconfig.typecheck.json for why that matters here.

import { StyleGuide } from "../storage/schema";
import { LanguageRules } from "../lang/types";
import { wholeWordRegExp } from "../utils/text";
import { narrationOnly } from "./voice";

export interface StyleViolation {
  rule: string;
  excerpt: string;
  suggestion: string;
}

export type PointOfView = "first" | "second" | "third";

// A style guide's POV is free text, and an author writes it in their own
// language: "first person", "Ich-Erzähler", "personaler Erzähler (Er/Sie)".
// Every vocabulary is tried, whatever the book's language, since the guide may
// well be written in a different one from the manuscript.
const POV_PATTERNS: [PointOfView, RegExp][] = [
  ["first", /first[- ]person|1st[- ]person|ich[- ]?(?:erz[äa]hl|perspektive|form)|erste[rn]? person/i],
  ["second", /second[- ]person|2nd[- ]person|du[- ]?(?:erz[äa]hl|perspektive|form)|zweite[rn]? person/i],
  ["third", /third[- ]person|3rd[- ]person|(?:er|sie)[-/ ]?(?:erz[äa]hl|perspektive|form)|dritte[rn]? person|personale[rn]? erz[äa]hl|auktoriale[rn]? erz[äa]hl|omniscient|close third/i],
];

export function classifyPov(pov: string): PointOfView | null {
  for (const [kind, pattern] of POV_PATTERNS) {
    if (pattern.test(pov)) return kind;
  }
  return null;
}

// Checks that only make sense with rules for the passage's language.
export const LANGUAGE_DEPENDENT_STYLE_CHECKS = ["tense", "pointOfView", "passiveVoice"];

// More than this many passive constructions in one passage is worth a note.
const PASSIVE_THRESHOLD = 3;

function matches(text: string, pattern: RegExp): string[] {
  const global = pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
  return text.match(global) ?? [];
}

/**
 * Judges a passage against the style guide as prose.
 *
 * Tense and point of view read the narration only: dialogue is blanked out
 * first, because a character in a past-tense third-person book says "I think"
 * without breaking anything.
 */
export function checkStyle(
  passage: string,
  guide: StyleGuide,
  rules: LanguageRules | null
): { violations: StyleViolation[]; skipped: string[] } {
  const violations: StyleViolation[] = [];
  const skipped: string[] = [];
  const narration = narrationOnly(passage);

  if (!rules) {
    skipped.push(...LANGUAGE_DEPENDENT_STYLE_CHECKS);
  } else {
    // Tense
    if (guide.tense === "past") {
      const found = matches(narration, rules.presentTense);
      if (found.length) {
        violations.push({
          rule: "Tense: should be past tense",
          excerpt: found.slice(0, 3).join(", "),
          suggestion: "Convert present tense verbs to past tense.",
        });
      }
    } else if (guide.tense === "present") {
      const found = matches(narration, rules.pastTense);
      if (found.length) {
        violations.push({
          rule: "Tense: should be present tense",
          excerpt: found.slice(0, 3).join(", "),
          suggestion: "Convert past tense verbs to present tense.",
        });
      }
    }

    // Passive voice
    const passive = matches(passage, rules.passive);
    if (passive.length > PASSIVE_THRESHOLD) {
      violations.push({
        rule: "Excessive passive voice detected",
        excerpt: passive.slice(0, 3).join(", "),
        suggestion: "Rewrite in active voice where possible.",
      });
    }

    // Point of view
    const pov = classifyPov(guide.pov);
    if (pov === "first") {
      const found = matches(narration, rules.thirdPersonThought);
      if (found.length) {
        violations.push({
          rule: "POV: first person narration shouldn't use third-person internal thoughts",
          excerpt: found.slice(0, 3).join(", "),
          suggestion: "Rewrite internal thoughts from first person perspective.",
        });
      }
    } else if (pov === "third") {
      const found = matches(narration, rules.firstPersonThought);
      if (found.length) {
        violations.push({
          rule: "POV: third person narration shouldn't use first-person internal thoughts",
          excerpt: found.slice(0, 3).join(", "),
          suggestion: "Rewrite from third person perspective.",
        });
      }
    }
  }

  // Things to avoid are the author's own words, so they are matched literally
  // whatever the language.
  for (const avoidance of guide.thingsToAvoid) {
    // Unicode-aware boundaries: \b would never match a term that starts or
    // ends with a non-ASCII letter, so "Übertreibung" went unflagged.
    const found = passage.normalize("NFC").match(wholeWordRegExp(avoidance));
    if (found) {
      violations.push({
        rule: `Avoid: "${avoidance}"`,
        excerpt: found[0],
        suggestion: `Remove or rephrase to avoid "${avoidance}".`,
      });
    }
  }

  return { violations, skipped };
}
