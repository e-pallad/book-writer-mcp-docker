import { Character, VoiceProfile } from "../storage/schema";
import { normalizeForCompare, wholeWordRegExp } from "../utils/text";

export interface VoiceViolation {
  rule: string;
  excerpt: string;
  suggestion: string;
}

export interface DialogueLine {
  /** The spoken words, without the surrounding quotation marks. */
  text: string;
  /** The line as it appears in the passage, quotes included. */
  raw: string;
  /** A speaker named by an adjacent dialogue tag, when there is one. */
  speaker?: string;
}

// Straight and curly quotes, plus the guillemets and low-9 quotes that German
// and French prose use. A passage is not required to be ASCII.
const QUOTE_PAIRS: [string, string][] = [
  ['"', '"'],
  ["“", "”"], // “ ”
  ["‘", "’"], // ‘ ’
  ["«", "»"], // « »
  ["„", "“"], // „ “
];

const SPEECH_VERBS = [
  "said", "says", "asked", "asks", "replied", "replies", "whispered",
  "whispers", "shouted", "shouts", "muttered", "mutters", "answered",
  "answers", "called", "calls", "added", "adds", "snapped", "snaps",
  "growled", "growls", "murmured", "murmurs", "breathed", "offered",
];

/**
 * Pulls quoted speech out of a passage, with the speaker when a dialogue tag
 * names one.
 *
 * Deliberately conservative: prose is not parseable, so a line whose speaker
 * cannot be identified is returned with `speaker` unset rather than guessed
 * at. book_style_check only attributes a line to the character under review
 * when the tag says so, or when there is no tag at all and the caller has
 * named whose voice to check.
 */
export function extractDialogue(passage: string): DialogueLine[] {
  const lines: DialogueLine[] = [];
  const text = passage.normalize("NFC");

  for (const [open, close] of QUOTE_PAIRS) {
    let index = 0;
    while (index < text.length) {
      const start = text.indexOf(open, index);
      if (start === -1) break;
      // A straight quote closes with the same character, so the search for the
      // closing mark starts after the opening one.
      const end = text.indexOf(close, start + 1);
      if (end === -1) break;

      const inner = text.slice(start + 1, end);
      // Skip an apostrophe caught as an opening single quote ("don't").
      if (inner.length > 1 && !/^\s*$/.test(inner)) {
        lines.push({
          text: inner,
          raw: text.slice(start, end + 1),
          speaker: speakerNear(text, start, end, open, close),
        });
      }
      index = end + 1;
    }
    if (lines.length) break; // One quoting convention per passage.
  }

  return lines;
}

// Looks for "<Name> said" / "said <Name>" in the 60 characters on either side
// of the quoted run — far enough to catch a tag, short enough not to pick up
// the next sentence's subject.
//
// Each window stops at the neighbouring quotation mark. Without that, an
// untagged line reads the *following* line's tag as its own: in
// `"Aye." "Furthermore," Vance said.` the lookahead from "Aye." would run
// straight through the second quote and attribute it to Vance.
function speakerNear(
  text: string,
  start: number,
  end: number,
  open: string,
  close: string
): string | undefined {
  const rawBefore = text.slice(Math.max(0, start - 60), start);
  const rawAfter = text.slice(end + 1, end + 61);

  const before = truncateAtQuote(rawBefore, open, close, "last");
  const after = truncateAtQuote(rawAfter, open, close, "first");

  const verbs = SPEECH_VERBS.join("|");
  const patterns = [
    new RegExp(`(\\p{Lu}[\\p{L}'’-]+)\\s+(?:${verbs})\\b`, "u"),
    new RegExp(`\\b(?:${verbs})\\s+(\\p{Lu}[\\p{L}'’-]+)`, "u"),
  ];

  for (const source of [after, before]) {
    for (const pattern of patterns) {
      const match = pattern.exec(source);
      if (match) return match[1];
    }
  }
  return undefined;
}

// Keeps the part of a window that belongs to this line: everything up to the
// next quotation mark ahead, or after the last one behind.
function truncateAtQuote(
  window: string,
  open: string,
  close: string,
  edge: "first" | "last"
): string {
  const marks = new Set([open, close]);
  if (edge === "first") {
    for (let i = 0; i < window.length; i++) {
      if (marks.has(window[i])) return window.slice(0, i);
    }
    return window;
  }
  for (let i = window.length - 1; i >= 0; i--) {
    if (marks.has(window[i])) return window.slice(i + 1);
  }
  return window;
}

function matchesCharacter(name: string, character: Character): boolean {
  const needle = normalizeForCompare(name);
  return (
    normalizeForCompare(character.name) === needle ||
    character.aliases.some((alias) => normalizeForCompare(alias) === needle) ||
    // "Mara Vance" tagged simply as "Mara".
    normalizeForCompare(character.name).split(/\s+/).includes(needle)
  );
}

// Words per sentence, averaged across a line of dialogue.
function averageSentenceLength(text: string): number {
  const sentences = text
    .split(/[.!?…]+[\s"'”’]*/u)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length === 0) return 0;

  const words = sentences.map(
    (sentence) => sentence.split(/\s+/).filter(Boolean).length
  );
  return words.reduce((sum, n) => sum + n, 0) / sentences.length;
}

// Expected words per sentence for each setting. The bands overlap on purpose:
// only a line well outside its band is worth reporting, since dialogue is
// naturally uneven and a single short retort inside a rambling character's
// speech means nothing.
const LENGTH_BANDS: Record<VoiceProfile["sentenceLength"], [number, number]> = {
  clipped: [0, 7],
  short: [0, 11],
  medium: [6, 20],
  long: [14, 40],
  rambling: [20, Infinity],
  varied: [0, Infinity],
};

/**
 * Checks dialogue attributed to `character` against their voice profile.
 *
 * `lines` should already be filtered to that character's speech; deciding who
 * is speaking is the caller's job, because only it knows whether an untagged
 * line belongs to the character under review.
 */
export function checkVoice(
  character: Character,
  lines: DialogueLine[]
): VoiceViolation[] {
  const profile = character.voiceProfile;
  if (!profile || lines.length === 0) return [];

  const violations: VoiceViolation[] = [];

  // 1. Things this character would never say, matched literally.
  for (const phrase of profile.neverSays) {
    const term = phrase.trim();
    if (!term) continue;

    for (const line of lines) {
      const found = wholeWordRegExp(term).exec(line.text.normalize("NFC"));
      if (found) {
        violations.push({
          rule: `Voice (${character.name}): would never say "${term}"`,
          excerpt: line.raw,
          suggestion: `"${term}" is on ${character.name}'s neverSays list. Rephrase it in their own register${
            profile.vocabulary ? ` (${profile.vocabulary})` : ""
          }.`,
        });
        break; // One report per phrase is enough.
      }
    }
  }

  // 2. Sentence length well outside the character's band.
  const [low, high] = LENGTH_BANDS[profile.sentenceLength] ?? [0, Infinity];
  if (high !== Infinity || low > 0) {
    for (const line of lines) {
      const average = averageSentenceLength(line.text);
      if (average === 0) continue;

      if (average > high) {
        violations.push({
          rule: `Voice (${character.name}): sentences run longer than their "${profile.sentenceLength}" register`,
          excerpt: line.raw,
          suggestion: `${character.name} speaks in ${profile.sentenceLength} sentences (about ${
            high === Infinity ? "any" : `${high} words or fewer`
          }); this line averages ${Math.round(average)}. Break it up or give the line to someone else.`,
        });
      } else if (average < low) {
        violations.push({
          rule: `Voice (${character.name}): sentences run shorter than their "${profile.sentenceLength}" register`,
          excerpt: line.raw,
          suggestion: `${character.name} speaks in ${profile.sentenceLength} sentences (about ${low} words or more); this line averages ${Math.round(
            average
          )}.`,
        });
      }
    }
  }

  // 3. Verbal tics, reported as an absence only when the character has them
  //    and none appears across a substantial run of dialogue. A single line is
  //    not evidence of anything.
  const tics = profile.verbalTics.map((t) => t.trim()).filter(Boolean);
  if (tics.length && lines.length >= 3) {
    const spoken = lines.map((l) => l.text.normalize("NFC")).join(" ");
    const present = tics.filter((tic) => wholeWordRegExp(tic).test(spoken));
    if (present.length === 0) {
      violations.push({
        rule: `Voice (${character.name}): none of their verbal tics appear`,
        excerpt: lines[0].raw,
        suggestion: `${character.name} is marked by ${tics
          .map((t) => `"${t}"`)
          .join(", ")}, none of which shows up across ${lines.length} lines of their dialogue here.`,
      });
    }
  }

  return violations;
}

/**
 * Splits a passage's dialogue into what the named character says and what
 * someone else does.
 *
 * A tagged line goes to whoever the tag names. An untagged line is treated as
 * the character's own, because book_style_check is called with a character in
 * mind and an author checking a passage means "this is their scene".
 */
export function attributeDialogue(
  character: Character,
  lines: DialogueLine[]
): { own: DialogueLine[]; others: DialogueLine[] } {
  const own: DialogueLine[] = [];
  const others: DialogueLine[] = [];

  for (const line of lines) {
    if (line.speaker === undefined || matchesCharacter(line.speaker, character)) {
      own.push(line);
    } else {
      others.push(line);
    }
  }

  return { own, others };
}

/**
 * Looks for a line attributed to this character that reads like another
 * character in the cast — the "wrong character's voice" case.
 *
 * Only reported when the other character's profile is a clearly better fit,
 * so two characters with similar voices do not produce noise.
 */
export function checkVoiceConfusion(
  character: Character,
  lines: DialogueLine[],
  cast: Character[]
): VoiceViolation[] {
  const profile = character.voiceProfile;
  if (!profile || lines.length === 0) return [];

  const violations: VoiceViolation[] = [];
  const others = cast.filter(
    (c) => c.id !== character.id && c.voiceProfile !== undefined
  );
  if (others.length === 0) return violations;

  for (const line of lines) {
    const own = countMismatches(profile, line);
    if (own === 0) continue;

    for (const other of others) {
      const theirs = countMismatches(other.voiceProfile!, line);
      // A strictly better fit, and the line has to actually carry one of the
      // other character's markers rather than merely not breaking their rules.
      if (theirs < own && carriesMarkerOf(other.voiceProfile!, line)) {
        violations.push({
          rule: `Voice (${character.name}): this line sounds like ${other.name}`,
          excerpt: line.raw,
          suggestion: `It fits ${other.name}'s voice profile better than ${character.name}'s. Either give the line to ${other.name} or rewrite it in ${character.name}'s register${
            profile.vocabulary ? ` (${profile.vocabulary})` : ""
          }.`,
        });
        break;
      }
    }
  }

  return violations;
}

function countMismatches(profile: VoiceProfile, line: DialogueLine): number {
  let mismatches = 0;
  const text = line.text.normalize("NFC");

  for (const phrase of profile.neverSays) {
    const term = phrase.trim();
    if (term && wholeWordRegExp(term).test(text)) mismatches++;
  }

  const [low, high] = LENGTH_BANDS[profile.sentenceLength] ?? [0, Infinity];
  const average = averageSentenceLength(text);
  if (average > 0 && (average > high || average < low)) mismatches++;

  return mismatches;
}

function carriesMarkerOf(profile: VoiceProfile, line: DialogueLine): boolean {
  const text = line.text.normalize("NFC");
  return profile.verbalTics.some((tic) => {
    const term = tic.trim();
    return term.length > 0 && wholeWordRegExp(term).test(text);
  });
}
