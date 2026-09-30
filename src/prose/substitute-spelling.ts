// Umlauts and ß typed as two letters: "ueber" for "über", "Strasse" for
// "Straße". It happens when text comes in through a keyboard, a tool or a
// model that avoided non-ASCII letters, and it is easy to miss in a long
// manuscript because every such word is still readable.
//
// German is full of legitimate "ue", "ae", "oe" and "ss" — Feuer, Michael,
// Poet, muss, Wasser — so this is a heuristic, tuned to report few false
// alarms rather than every possible case:
//
// - "ae", "oe", "ue" count only after a consonant at the start of a syllable:
//   never after a vowel (Feuer, Bauer, neue) or a "q" (Quelle), never at the
//   end of a word (Oboe, Statue), and "ue" not in the Latin endings -uell,
//   -uett, -uenz or a final -uel (aktuell, Duett, Kongruenz, Samuel) — while
//   Mueller and Huette are still reported.
// - "ss" counts only where the spelling rules require ß: after ei, ai, eu, äu
//   or ie (heiss, schliesslich, Preussen), after "au" only in aussen/ausser
//   and at the end of a word (draussen, Strauss) — "aus" + s-word (aussehen,
//   Aussage) is a compound, not a misspelling — and in a few common words
//   with a long vowel (Strasse, gross, Fuss, Spass). After a short vowel ss is
//   correct (muss, dass, Wasser) and never reported. Words in capitals are
//   skipped: STRASSE is the correct way to write Straße in capitals.
// - Anything covered by an exclusion is skipped. Exclusions match inside a
//   word, so "Michael" also covers "Michaels" and "Michaelskirche".

import { toNFC } from "../utils/text";

export interface SubstituteSpelling {
  /** Offset of the word in the text as scanned (NFC). */
  index: number;
  word: string;
  /** The word with each reported pair turned into its letter. */
  suggestion: string;
}

/** Words and word parts that are spelled correctly with ue/ae/oe/ss. */
export const DEFAULT_EXCLUSIONS: readonly string[] = [
  // Names
  "Michael", "Raphael", "Rafael", "Raffael", "Nathanael", "Israel", "Ismael",
  "Manuel", "Samuel", "Gael", "Noel", "Joel", "Goethe", "Phoebe", "Caesar",
  // Loanwords and technical terms
  "aero", "Paella", "Maestro", "Poet", "Poem", "Poesie", "Oboe", "Aloe",
  "Koeffizient", "Koexist", "Koedukation", "Oeuvre", "Statue", "Guerilla",
  "Guerrilla", "Blue", "Suez", "Puerto", "Pueblo",
  // Compounds: a part ending in a vowel or s, the next starting with e or s
  "zuerst", "zueinander", "zuerkenn", "zuerteil", "Autoe", "Kinoe", "Videoe",
  "Fotoe", "diesseit", "Preiss", "Kreiss",
  // Named in the request that brought this check in; the rules cover it too
  "Feuer",
  // Correct with ss next to a long-vowel word the list below reports
  "Fussel",
];

const VOWELS = "aeiouyäöü";
const LETTER_FOR: Record<string, string> = { ae: "ä", oe: "ö", ue: "ü", ss: "ß" };
const DIPHTHONGS = ["ei", "ai", "eu", "äu", "ie"];

// Common words with a long vowel before ß, written with ss. Matched inside a
// word, so "gross" also finds "grossartig" and "Grossstadt".
const LONG_VOWEL_SS = [
  "strasse", "gross", "groess", "fuss", "fuess", "gruss", "gruess", "spass",
  "suess", "gemaess", "maessig", "bloss", "stoss", "stoess",
];

/** Positions of "ae", "oe", "ue" and "ss" in a lower-cased word that look substituted. */
function suspectPairs(lower: string): number[] {
  const found = new Set<number>();

  for (let at = 0; at + 1 < lower.length; at++) {
    const pair = lower.slice(at, at + 2);
    const prev = at > 0 ? lower[at - 1] : "";
    const rest = lower.slice(at + 2);

    if (pair === "ae" || pair === "oe" || pair === "ue") {
      // "Diaet" is Diät, while "Radioempfang" is two words run together.
      const blocking = pair === "ae" ? VOWELS.replace("i", "") : VOWELS;
      if (prev && (blocking.includes(prev) || prev === "q")) continue;
      if (rest === "") continue;
      if (pair === "ue") {
        // aktuell, Duett — but Mueller and Huette are Müller and Hütte.
        if (/^(?:ll|tt)/.test(rest) && "tnxsdv".includes(prev || "-")) continue;
        if (rest.startsWith("nz") || rest === "l" || rest === "ls") continue;
      }
      found.add(at);
      continue;
    }

    if (pair === "ss") {
      const before = lower.slice(Math.max(0, at - 2), at);
      if (before === "au") {
        if (rest === "" || /^e[nr]/.test(rest)) found.add(at);
      } else if (DIPHTHONGS.includes(before)) {
        if (rest === "" || VOWELS.includes(rest[0]) || rest[0] === "l" || /^t(?:e|$)/.test(rest)) {
          found.add(at);
        }
      }
    }
  }

  for (const stem of LONG_VOWEL_SS) {
    for (let from = lower.indexOf(stem); from !== -1; from = lower.indexOf(stem, from + 1)) {
      const at = from + stem.lastIndexOf("ss");
      found.add(at);
    }
  }

  // "sss" in a compound (Grossstadt) must not report the same ß twice.
  const sorted = [...found].sort((a, b) => a - b);
  return sorted.filter((at, i) => i === 0 || at >= sorted[i - 1] + 2);
}

/** Whether an exclusion covers the pair at `at`. */
function excluded(lower: string, at: number, exclusions: string[]): boolean {
  return exclusions.some((stem) => {
    for (let from = lower.indexOf(stem); from !== -1; from = lower.indexOf(stem, from + 1)) {
      if (from <= at && at + 2 <= from + stem.length) return true;
    }
    return false;
  });
}

function withLetters(word: string, pairs: number[]): string {
  let result = "";
  let cursor = 0;
  for (const at of pairs) {
    const pair = word.slice(at, at + 2).toLowerCase();
    const letter = LETTER_FOR[pair];
    const upper = word[at] !== word[at].toLowerCase();
    result += word.slice(cursor, at) + (upper && pair !== "ss" ? letter.toUpperCase() : letter);
    cursor = at + 2;
  }
  return result + word.slice(cursor);
}

/** Prepared exclusions: the defaults plus the caller's, lower-cased. */
export function exclusionList(extra: string[] = []): string[] {
  return [...DEFAULT_EXCLUSIONS, ...extra]
    .map((e) => toNFC(e).trim().toLowerCase())
    .filter(Boolean);
}

/** Every word in `text` that looks like it has an umlaut or ß spelled out. */
export function findSubstituteSpellings(
  text: string,
  exclusions: string[] = exclusionList()
): SubstituteSpelling[] {
  const hits: SubstituteSpelling[] = [];
  for (const match of toNFC(text).matchAll(/\p{L}+/gu)) {
    const word = match[0];
    const lower = word.toLowerCase();
    const capitals = word === word.toUpperCase() && word.length > 1;

    const pairs = suspectPairs(lower).filter(
      (at) =>
        !(capitals && lower.slice(at, at + 2) === "ss") && !excluded(lower, at, exclusions)
    );
    if (pairs.length) {
      hits.push({ index: match.index ?? 0, word, suggestion: withLetters(word, pairs) });
    }
  }
  return hits;
}
