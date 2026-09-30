import { Character, VoiceProfile } from "../storage/schema";
import { escapeRegExp, normalizeForCompare, wholeWordRegExp } from "../utils/text";
import { LanguageRules } from "../lang/types";
import { en } from "../lang/en";

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
//
// Guillemets point either way: German sets »so«, French and Swiss «so». Which
// one a passage uses is decided by whichever mark comes first, because reading
// German »…« with the French pairing captures the narration *between* two
// lines of speech and treats it as dialogue.
function quotePairs(text: string): [string, string][] {
  const firstGuillemet = text.search(/[«»]/);
  const guillemets: [string, string] =
    firstGuillemet !== -1 && text[firstGuillemet] === "»" ? ["»", "«"] : ["«", "»"];
  return [
    ['"', '"'],
    ["“", "”"], // “ ”
    ["‘", "’"], // ‘ ’
    guillemets,
    ["„", "“"], // „ “
    ["‚", "‘"], // ‚ ‘
  ];
}

interface QuotedSpan {
  start: number;
  /** Index of the closing mark. */
  end: number;
  open: string;
  close: string;
}

/**
 * The quoted runs of a passage, using the first quoting convention that finds
 * any. One convention per passage: a book is consistent about it, and mixing
 * pairings is what produces spans that cover narration.
 */
function quotedSpans(text: string): QuotedSpan[] {
  for (const pair of quotePairs(text)) {
    const spans = spansFor(text, pair);
    if (spans.length) return spans;
  }
  return [];
}

function spansFor(text: string, [open, close]: [string, string]): QuotedSpan[] {
  const spans: QuotedSpan[] = [];
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
      spans.push({ start, end, open, close });
    }
    index = end + 1;
  }
  return spans;
}

/**
 * The passage with every line of dialogue blanked out, offsets preserved.
 *
 * Tense and point-of-view rules are about the narration. Speech is exempt —
 * a character in a past-tense, third-person novel says "I think" in the
 * present and in the first person all the time — so those checks read this.
 */
export function narrationOnly(passage: string): string {
  const text = passage.normalize("NFC");
  // Every convention, not just the first that matches: blanking a little too
  // much here costs nothing, while speech left in the narration is exactly
  // what produces a false tense or POV finding.
  const units = text.split("");
  for (const pair of quotePairs(text)) {
    for (const span of spansFor(text, pair)) {
      for (let i = span.start; i <= span.end; i++) units[i] = " ";
    }
  }
  return units.join("");
}

/**
 * Pulls quoted speech out of a passage, with the speaker when a dialogue tag
 * names one.
 *
 * Deliberately conservative: prose is not parseable, so a line whose speaker
 * cannot be identified is returned with `speaker` unset rather than guessed
 * at. book_style_check only attributes a line to the character under review
 * when the tag says so, or when there is no tag at all and the caller has
 * named whose voice to check.
 *
 * `rules` supply the verbs of speech. With none (a language this server has no
 * rules for) no tag is recognised and every speaker stays unknown.
 */
export function extractDialogue(
  passage: string,
  rules: LanguageRules | null = en
): DialogueLine[] {
  const text = passage.normalize("NFC");
  return quotedSpans(text).map(({ start, end, open, close }) => ({
    text: text.slice(start + 1, end),
    raw: text.slice(start, end + 1),
    speaker: rules ? speakerNear(text, start, end, open, close, rules) : undefined,
  }));
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
  close: string,
  rules: LanguageRules
): string | undefined {
  const rawBefore = text.slice(Math.max(0, start - 60), start);
  const rawAfter = text.slice(end + 1, end + 61);

  const before = truncateAtQuote(rawBefore, open, close, "last");
  const after = truncateAtQuote(rawAfter, open, close, "first");

  for (const source of [after, before]) {
    const name = speakerTagIn(source, rules);
    if (name) return name;
  }
  return undefined;
}

/**
 * The name in a dialogue tag — "Mara said", "said Mara", "sagte Mara" — or
 * undefined. A capitalised word straight after a determiner is a noun, not a
 * name: German capitalises every noun, and "Die Frau sagte" is not a
 * character called Frau.
 */
export function speakerTagIn(source: string, rules: LanguageRules): string | undefined {
  const notNames = new Set(rules.notNames.map((w) => w.toLowerCase()));
  // "Kell said" is preferred over "said Kell" when a window holds both.
  for (const pattern of tagPatterns(rules)) {
    for (const match of source.matchAll(pattern)) {
      if (!notNames.has(match[1].toLowerCase())) return match[1];
    }
  }
  return undefined;
}

/** Every name a dialogue tag gives in a text, in order, repeats included. */
export function speakerTagsIn(text: string, rules: LanguageRules): string[] {
  const notNames = new Set(rules.notNames.map((w) => w.toLowerCase()));
  const found: { at: number; name: string }[] = [];
  for (const pattern of tagPatterns(rules)) {
    for (const match of text.matchAll(pattern)) {
      if (!notNames.has(match[1].toLowerCase())) {
        found.push({ at: match.index ?? 0, name: match[1] });
      }
    }
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.name);
}

// "<Name> said" and "said <Name>". The name is a capitalised word that does
// not follow a determiner, allowing for up to two adjectives in between —
// "die alte Frau sagte" names nobody.
function tagPatterns(rules: LanguageRules): RegExp[] {
  const verbs = alternation(rules.speechVerbs);
  const name = "(?<![\\p{L}])(\\p{Lu}[\\p{L}'’-]+)";
  const determiners = rules.determiners.length
    ? `(?<!(?<![\\p{L}])(?:${alternation(rules.determiners)})\\s+(?:\\p{Ll}[\\p{L}-]*\\s+){0,2})`
    : "";
  const inverted = rules.invertedSubjectPronouns?.length
    ? `(?!\\s+(?:${rules.invertedSubjectPronouns.join("|")})(?![\\p{L}]))`
    : "";
  return [
    new RegExp(`${determiners}${name}\\s+(?:${verbs})(?![\\p{L}])${inverted}`, "gu"),
    new RegExp(`(?<![\\p{L}])(?:${verbs})\\s+${name}`, "gu"),
  ];
}

// Words as a regex alternation that also accepts a capitalised first letter,
// for a tag or an article at the start of a sentence ("Said Kell", "Die Frau").
// Not the i flag: with it, \p{Lu} matches lowercase letters too, and "he said"
// would read as a speaker called "he".
function alternation(words: string[]): string {
  return words
    .map((word) => {
      const first = word[0];
      return `[${escapeRegExp(first.toLowerCase())}${escapeRegExp(first.toUpperCase())}]${escapeRegExp(word.slice(1))}`;
    })
    .join("|");
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
