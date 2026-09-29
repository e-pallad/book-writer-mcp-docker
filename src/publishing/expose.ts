// The exposé: what an agency or a publisher reads before deciding whether to
// read the book. Title and facts, the pitch, the premise, the plot with its
// ending, the cast, comparable titles, the author — and a sample. Written from
// what the project already knows; what it does not know is marked, not left
// out, so the author sees what to add.

import {
  AuthorProfile,
  Character,
  ChapterMeta,
  Concept,
  Outline,
  PublishingMetadata,
  Registry,
  StoryBible,
} from "../storage/schema";
import { normaliseThemes } from "../storage/bible";
import { chaptersInOrder } from "../storage/chapters";

export interface ExposeInput {
  registry: Registry;
  concept: Concept | null;
  metadata: PublishingMetadata | null;
  bible: StoryBible | null;
  outline: Outline | null;
  profile: AuthorProfile | null;
  language: string;
  extent: { normPages: number; words: number };
  /** "the first 3 chapters, about 31 Normseiten", when a sample is attached. */
  sample?: string;
}

interface Words {
  expose: string;
  facts: {
    author: string;
    genre: string;
    extent: string;
    extentPlanned: (target: number) => string;
    audience: string;
    status: string;
    finished: string;
    inProgress: (final: number, total: number) => string;
    series: string;
  };
  pitch: string;
  premise: string;
  question: string;
  thesis: string;
  promise: string;
  themes: string;
  synopsis: string;
  synopsisNote: string;
  cast: string;
  comparable: string;
  usp: string;
  author: string;
  sample: string;
  missing: (what: string, how: string) => string;
  roles: Record<Character["role"], string>;
  chapter: string;
  chapterSynopsis: string;
}

const DE: Words = {
  expose: "Exposé",
  facts: {
    author: "Autor·in",
    genre: "Genre",
    extent: "Umfang",
    extentPlanned: (t) => `geplant ca. ${t.toLocaleString("de-DE")} Wörter`,
    audience: "Zielgruppe",
    status: "Stand",
    finished: "Manuskript abgeschlossen",
    inProgress: (f, t) => `in Arbeit (${f} von ${t} Kapiteln abgeschlossen)`,
    series: "Reihe",
  },
  pitch: "Pitch",
  premise: "Prämisse",
  question: "Zentrale Frage",
  thesis: "Kernthese",
  promise: "Was die Leser·innen mitnehmen",
  themes: "Themen",
  synopsis: "Inhalt",
  synopsisNote:
    "Aus den Kapitelzusammenfassungen zusammengestellt. Ein Exposé erzählt den Inhalt als zusammenhängenden Text, mit dem Ende — hier überarbeiten.",
  cast: "Figuren",
  comparable: "Vergleichstitel",
  usp: "Was dieses Buch besonders macht",
  author: "Zur Person",
  sample: "Leseprobe",
  missing: (what, how) => `[TODO: ${what} fehlt — ${how}]`,
  roles: { protagonist: "Hauptfigur", antagonist: "Gegenspieler·in", supporting: "Nebenfigur", minor: "Randfigur" },
  chapter: "Kapitel",
  chapterSynopsis: "Zusammenfassung",
};

const EN: Words = {
  expose: "Book Proposal",
  facts: {
    author: "Author",
    genre: "Genre",
    extent: "Length",
    extentPlanned: (t) => `planned c. ${t.toLocaleString("en-US")} words`,
    audience: "Readership",
    status: "Status",
    finished: "Manuscript complete",
    inProgress: (f, t) => `in progress (${f} of ${t} chapters final)`,
    series: "Series",
  },
  pitch: "Pitch",
  premise: "Premise",
  question: "Central question",
  thesis: "Core argument",
  promise: "What the reader takes away",
  themes: "Themes",
  synopsis: "Synopsis",
  synopsisNote:
    "Assembled from the chapter synopses. A synopsis tells the whole story as continuous prose, ending included — rework it here.",
  cast: "Characters",
  comparable: "Comparable titles",
  usp: "What sets it apart",
  author: "About the author",
  sample: "Sample",
  missing: (what, how) => `[TODO: ${what} missing — ${how}]`,
  roles: { protagonist: "Protagonist", antagonist: "Antagonist", supporting: "Supporting", minor: "Minor" },
  chapter: "Chapter",
  chapterSynopsis: "Synopsis",
};

function wordsFor(language: string): Words {
  return language.toLowerCase().startsWith("de") ? DE : EN;
}

function firstSentences(text: string, count = 2): string {
  const sentences = text.trim().match(/[^.!?…]+[.!?…]+(?:\s|$)|[^.!?…]+$/gu) ?? [];
  return sentences.slice(0, count).join("").trim();
}

/** The synopsis: each chapter's own synopsis, else its outline entry's. */
function synopsisLines(input: ExposeInput, w: Words): { lines: string[]; missing: number } {
  const planned = new Map<string, string>();
  for (const act of input.outline?.acts ?? []) {
    for (const entry of act.chapters) {
      if (entry.chapterId && entry.synopsis.trim()) planned.set(entry.chapterId, entry.synopsis.trim());
    }
  }
  let missing = 0;
  const chapters: ChapterMeta[] = chaptersInOrder(input.registry);
  const lines = chapters.map((chapter, index) => {
    const text = chapter.synopsis.trim() || planned.get(chapter.id) || "";
    if (!text) missing++;
    return `- **${w.chapter} ${index + 1} – ${chapter.title}:** ${
      text || w.missing(w.chapterSynopsis, `book_chapter_update synopsis=…`)
    }`;
  });
  return { lines, missing };
}

export interface Expose {
  markdown: string;
  /** Building blocks the exposé still lacks. */
  missing: string[];
}

export function buildExpose(input: ExposeInput): Expose {
  const w = wordsFor(input.language);
  const { registry, concept, metadata, bible, profile } = input;
  const missing: string[] = [];
  const need = (value: string | undefined, name: string, how: string): string => {
    if (value?.trim()) return value.trim();
    missing.push(name);
    return w.missing(name, how);
  };
  const nonfiction = concept?.bookType === "nonfiction";

  const out: string[] = [];
  out.push(`# ${w.expose}: ${registry.title}`);
  if (metadata?.subtitle) out.push(`*${metadata.subtitle}*`);

  // The facts at a glance.
  const final = registry.chapters.filter((c) => c.status === "final").length;
  const facts = [
    `**${w.facts.author}:** ${profile?.name?.trim() || registry.author}`,
    `**${w.facts.genre}:** ${registry.genre}`,
    `**${w.facts.extent}:** ${
      input.language.startsWith("de")
        ? `ca. ${input.extent.normPages} Normseiten (${input.extent.words.toLocaleString("de-DE")} Wörter)`
        : `c. ${input.extent.words.toLocaleString("en-US")} words`
    }${
      final === registry.chapters.length && final > 0 ? "" : `, ${w.facts.extentPlanned(registry.targetWordCount)}`
    }`,
    `**${w.facts.audience}:** ${need(concept?.targetAudience, w.facts.audience, "book_concept_set targetAudience=…")}`,
    `**${w.facts.status}:** ${
      final === registry.chapters.length && final > 0
        ? w.facts.finished
        : w.facts.inProgress(final, registry.chapters.length)
    }`,
  ];
  if (metadata?.series) {
    facts.push(
      `**${w.facts.series}:** ${metadata.series.name}${metadata.series.number ? ` (${metadata.series.number})` : ""}`
    );
  }
  out.push(facts.join("  \n"));

  out.push(`## ${w.pitch}`, need(concept?.logline, "Logline", "book_concept_set logline=…"));

  if (nonfiction) {
    out.push(`## ${w.thesis}`, need(concept?.coreThesis, w.thesis, "book_concept_set coreThesis=…"));
    out.push(`## ${w.promise}`, need(concept?.readerPromise, w.promise, "book_concept_set readerPromise=…"));
  } else {
    out.push(`## ${w.premise}`, need(concept?.premise, w.premise, "book_concept_set premise=…"));
    if (concept?.centralQuestion) out.push(`## ${w.question}`, concept.centralQuestion);
  }

  const themes = normaliseThemes(bible?.themes);
  if (themes.length) {
    out.push(
      `## ${w.themes}`,
      themes.map((t) => (t.description ? `- **${t.name}** — ${t.description}` : `- **${t.name}**`)).join("\n")
    );
  }

  const synopsis = synopsisLines(input, w);
  if (!registry.chapters.length) missing.push(w.synopsis);
  else if (synopsis.missing) missing.push(`${w.synopsis} (${synopsis.missing})`);
  out.push(`## ${w.synopsis}`, `*${w.synopsisNote}*`, synopsis.lines.join("\n") || w.missing(w.synopsis, "book_chapter_create"));

  if (!nonfiction) {
    const cast = (bible?.characters ?? [])
      .filter((c) => c.role !== "minor")
      .sort(
        (a, b) =>
          ["protagonist", "antagonist", "supporting"].indexOf(a.role) -
          ["protagonist", "antagonist", "supporting"].indexOf(b.role)
      );
    if (!cast.length) missing.push(w.cast);
    out.push(
      `## ${w.cast}`,
      cast.length
        ? cast
            .map((c) => `- **${c.name}** (${w.roles[c.role]}) — ${firstSentences(c.description)}`)
            .join("\n")
        : w.missing(w.cast, "book_character_add")
    );
  }

  const comps = concept?.comparableTitles ?? [];
  if (!comps.length) missing.push(w.comparable);
  out.push(
    `## ${w.comparable}`,
    comps.length
      ? comps
          .map((c) => `- *${c.title}* — ${c.author}${c.year ? ` (${c.year})` : ""}${c.why ? `: ${c.why}` : ""}`)
          .join("\n")
      : w.missing(w.comparable, "book_concept_set comparableTitles=[…]")
  );

  if (concept?.uniqueSellingPoint) out.push(`## ${w.usp}`, concept.uniqueSellingPoint);

  out.push(
    `## ${w.author}`,
    need(profile?.generatedIntro, w.author, "book_author_update_profile")
  );

  if (input.sample) out.push(`## ${w.sample}`, input.sample);

  return { markdown: `${out.join("\n\n")}\n`, missing };
}
