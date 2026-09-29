// Prose analysis for the line edit: the habits an editor marks in the margin —
// filler words, a word used twice in quick succession, sentences that all run
// the same length or one that runs on for a page, walls of paragraph. Hints,
// not errors: every one of these is sometimes exactly right.

import { LanguageRules } from "../lang/types";
import { narrationOnly } from "../tools/voice";
import { condense } from "../utils/match";
import { paragraphNumberAt, splitParagraphs, toNFC } from "../utils/text";
import { countWords } from "../utils/wordcount";
import { parseBlocks, plainText } from "../utils/markdown";

export interface ProseReport {
  words: number;
  fillers: { word: string; count: number; perThousand: number }[];
  repetitions: { word: string; closeRepeats: number; example: { paragraph: number; context: string } }[];
  sentences: {
    count: number;
    averageWords: number;
    spread: number;
    longest: { words: number; paragraph: number; excerpt: string }[];
    /** Many sentences, all near the same length. */
    monotonous: boolean;
  };
  paragraphs: { count: number; averageWords: number; long: { paragraph: number; words: number }[] };
  /** Share of words spoken in dialogue. */
  dialogueShare: number;
  adverbs?: { count: number; perThousand: number; top: string[] };
  hints: string[];
}

// Two uses of a word closer than this many words apart read as an echo.
const ECHO_WINDOW = 30;
const LONG_PARAGRAPH = 180;
// Short words count too: "Tür" twice in two lines is an echo. The stop words
// keep the function words out.
const MIN_WORD = 3;

interface Token {
  word: string;
  index: number;
}

function tokens(text: string): Token[] {
  return [...text.matchAll(/[\p{L}][\p{L}\p{M}'’-]*/gu)].map((m) => ({
    word: m[0],
    index: m.index ?? 0,
  }));
}

function phrasePattern(phrase: string): RegExp {
  const body = phrase
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, "giu");
}

function sentencesOf(prose: string): string[] {
  // Split after end punctuation (and closing quotes) followed by space and an
  // uppercase letter or a quote — rough, but abbreviations like "z. B." are
  // followed by lowercase and survive.
  return prose
    .split(/(?<=[.!?…][»«“”"’)]*)\s+(?=[\p{Lu}„»«“"‚‘(])/u)
    .map((s) => s.trim())
    .filter((s) => /[\p{L}]/u.test(s));
}

export function analyzeProse(
  markdown: string,
  rules: LanguageRules,
  names: string[] = []
): ProseReport {
  const text = toNFC(markdown);
  // The prose without markup: headings, emphasis and scene breaks are not text.
  const blocks = parseBlocks(text);
  const prose = blocks
    .flatMap((b) =>
      b.type === "paragraph" ? [plainText(b.text)] : b.type === "blockquote" ? b.blocks.flatMap((x) => ("text" in x ? [plainText(x.text)] : [])) : []
    )
    .join("\n\n");
  const words = countWords(prose);
  const perThousand = (n: number) => (words ? Math.round((n / words) * 10000) / 10 : 0);
  const hints: string[] = [];

  // Filler words.
  const fillers = rules.fillerWords
    .map((word) => ({ word, count: (prose.match(phrasePattern(word)) ?? []).length }))
    .filter((f) => f.count > 0)
    .map((f) => ({ ...f, perThousand: perThousand(f.count) }))
    .sort((a, b) => b.count - a.count);
  const fillerTotal = fillers.reduce((sum, f) => sum + f.count, 0);
  if (perThousand(fillerTotal) > 15) {
    hints.push(
      `Filler words make up ${perThousand(fillerTotal)} per thousand words — most often ${fillers
        .slice(0, 3)
        .map((f) => `"${f.word}"`)
        .join(", ")}. Try each sentence without them.`
    );
  }

  // Echoes: the same content word again within a few lines.
  const stop = new Set(rules.stopWords.map((w) => w.toLowerCase()));
  const skip = new Set(names.flatMap((n) => n.toLowerCase().split(/\s+/)));
  const seen = new Map<string, number>();
  const echoes = new Map<string, { count: number; at: number }>();
  tokens(prose).forEach((token, position) => {
    const key = token.word.toLowerCase();
    if (key.length < MIN_WORD || stop.has(key) || skip.has(key)) return;
    const last = seen.get(key);
    if (last !== undefined && position - last <= ECHO_WINDOW) {
      const entry = echoes.get(key) ?? { count: 0, at: token.index };
      entry.count++;
      echoes.set(key, entry);
    }
    seen.set(key, position);
  });
  const repetitions = [...echoes]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10)
    .map(([word, entry]) => ({
      word,
      closeRepeats: entry.count,
      example: {
        paragraph: paragraphNumberAt(prose, entry.at),
        context: condense(prose.slice(Math.max(0, entry.at - 60), entry.at + 40)),
      },
    }));
  if (repetitions.length && repetitions[0].closeRepeats >= 3) {
    hints.push(
      `"${repetitions[0].word}" comes back within ${ECHO_WINDOW} words ${repetitions[0].closeRepeats} times. An echo is fine on purpose; by accident it shows.`
    );
  }

  // Sentences.
  const sentences = sentencesOf(prose);
  const lengths = sentences.map((s) => countWords(s));
  const average = lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0;
  const spread = lengths.length
    ? Math.sqrt(lengths.reduce((sum, n) => sum + (n - average) ** 2, 0) / lengths.length)
    : 0;
  const longest = sentences
    .map((s, i) => ({ s, words: lengths[i] }))
    .filter((x) => x.words >= rules.longSentence)
    .sort((a, b) => b.words - a.words)
    .slice(0, 5)
    .map((x) => ({
      words: x.words,
      paragraph: paragraphNumberAt(prose, prose.indexOf(x.s)),
      excerpt: condense(x.s, 100),
    }));
  const monotonous = lengths.length >= 12 && spread < 3.5;
  if (monotonous) {
    hints.push(
      `The sentences run to about ${Math.round(average)} words each, with little variation. A short one after long ones — or the reverse — gives prose its rhythm.`
    );
  }
  if (longest.length) {
    hints.push(
      `${longest.length} sentence(s) of ${rules.longSentence}+ words; the longest has ${longest[0].words}. Read it aloud.`
    );
  }

  // Paragraphs.
  const paragraphs = splitParagraphs(prose).filter((p) => p.text.trim());
  const paragraphWords = paragraphs.map((p) => countWords(p.text));
  const long = paragraphs
    .map((p, i) => ({ paragraph: p.index, words: paragraphWords[i] }))
    .filter((p) => p.words > LONG_PARAGRAPH);
  if (long.length) {
    hints.push(`${long.length} paragraph(s) over ${LONG_PARAGRAPH} words — on a phone screen, a wall.`);
  }

  // Dialogue: what the narration leaves out when speech is blanked.
  const narrated = countWords(narrationOnly(prose));
  const dialogueShare = words ? Math.round(((words - narrated) / words) * 100) / 100 : 0;

  // Adverbs, where the language marks them.
  let adverbs: ProseReport["adverbs"];
  if (rules.adverbSuffix) {
    const suffix = rules.adverbSuffix;
    const found = tokens(prose)
      .map((t) => t.word.toLowerCase())
      .filter((w) => w.length > suffix.length + 3 && w.endsWith(suffix) && !stop.has(w));
    const counts = new Map<string, number>();
    for (const w of found) counts.set(w, (counts.get(w) ?? 0) + 1);
    adverbs = {
      count: found.length,
      perThousand: perThousand(found.length),
      top: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([w]) => w),
    };
    if (adverbs.perThousand > 20) {
      hints.push(`Adverbs in -${suffix}: ${adverbs.perThousand} per thousand words. A stronger verb often does the work of verb and adverb.`);
    }
  }

  return {
    words,
    fillers: fillers.slice(0, 12),
    repetitions,
    sentences: {
      count: sentences.length,
      averageWords: Math.round(average * 10) / 10,
      spread: Math.round(spread * 10) / 10,
      longest,
      monotonous,
    },
    paragraphs: {
      count: paragraphs.length,
      averageWords: paragraphWords.length
        ? Math.round((paragraphWords.reduce((a, b) => a + b, 0) / paragraphWords.length) * 10) / 10
        : 0,
      long,
    },
    dialogueShare,
    ...(adverbs ? { adverbs } : {}),
    hints,
  };
}
