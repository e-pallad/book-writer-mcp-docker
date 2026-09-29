// The book as its exports lay it out: front matter, the body in parts and
// chapters, back matter. Assembled once, so the Markdown, the DOCX, the EPUB
// and the preview agree on what comes where, what a chapter is called and
// which number it carries.

import {
  getAuthorProfile,
  getMatter,
  getMetadata,
  getStoryBible,
  readChapterFile,
} from "../storage/filestore";
import { ChapterMeta, PublishingMetadata, Registry } from "../storage/schema";
import { labelsFor, projectLanguage } from "../lang";
import { Labels } from "../lang/types";
import { leadingHeadingText, stripLeadingHeading } from "../utils/markdown";
import { chaptersInOrder } from "../storage/chapters";
import { RenderedMatter, renderMatter } from "./matter";

export interface PartItem {
  kind: "part";
  /** 1-based, across the whole book. */
  number: number;
  /** "Erster Teil", or null when the part's own title already says so. */
  label: string | null;
  title: string;
}

export interface ChapterItem {
  kind: "chapter";
  chapter: ChapterMeta;
  /** "Kapitel 3", or null when chapters are not numbered (or this one is not). */
  label: string | null;
  /** The chapter's own heading line when it has one, else its title. */
  heading: string;
  /** The chapter without its heading line. */
  body: string;
}

export interface AssembledBook {
  title: string;
  subtitle?: string;
  author: string;
  genre: string;
  language: string;
  labels: Labels;
  metadata: PublishingMetadata | null;
  front: RenderedMatter[];
  body: (PartItem | ChapterItem)[];
  back: RenderedMatter[];
  /** How many chapters made it in — an empty chapter file is skipped. */
  chapterCount: number;
  warnings: string[];
}

export interface AssembleOptions {
  /** Leave out the front and back matter — a draft export of chapters only. */
  includeMatter?: boolean;
  /** Overrides the project language, for labels. */
  language?: string;
  /** The author's name to print, when it differs from the registry's. */
  author?: string;
}

// A part title that already names itself ("Teil 1: Die Stadt", "Book Two")
// gets no generated label on top of its own.
const SELF_LABELLED_PART = /^(?:teil|part|buch|book)\b|^[IVXLC]+\.?\s/i;

/**
 * The number each chapter carries: its position among the numbered chapters
 * of the whole book, so a selection exports "Kapitel 7" as chapter 7 and a
 * prologue marked unnumbered does not push everything after it up by one.
 */
function chapterNumbers(registry: Registry): Map<string, number> {
  const numbers = new Map<string, number>();
  let n = 0;
  for (const chapter of chaptersInOrder(registry)) {
    if (chapter.numbered === false) continue;
    numbers.set(chapter.id, ++n);
  }
  return numbers;
}

export function assembleBook(
  registry: Registry,
  chapters: ChapterMeta[],
  options: AssembleOptions = {}
): AssembledBook {
  const language = options.language ?? projectLanguage().tag;
  const labels = labelsFor(language);
  const metadata = getMetadata();
  const warnings: string[] = [];

  let front: RenderedMatter[] = [];
  let back: RenderedMatter[] = [];
  if (options.includeMatter !== false) {
    const rendered = renderMatter(getMatter(), {
      registry,
      metadata,
      bible: getStoryBible(),
      profile: getAuthorProfile(),
      labels,
    });
    front = rendered.sections.filter((s) => s.position === "front");
    back = rendered.sections.filter((s) => s.position === "back");
    warnings.push(...rendered.warnings);
  }

  const style = registry.chapterNumbering ?? "none";
  const numbers = chapterNumbers(registry);
  const body: (PartItem | ChapterItem)[] = [];
  let currentPart: string | null = null;
  let partCount = 0;
  let chapterCount = 0;

  for (const chapter of chapters) {
    const markdown = readChapterFile(chapter.filename);
    if (!markdown.trim()) {
      warnings.push(
        `Chapter "${chapter.title}" (${chapter.filename}) is missing or empty on disk and was skipped.`
      );
      continue;
    }

    const part = chapter.part?.trim() || null;
    if (part && part !== currentPart) {
      partCount++;
      body.push({
        kind: "part",
        number: partCount,
        label: SELF_LABELLED_PART.test(part) ? null : labels.part(partCount),
        title: part,
      });
    }
    currentPart = part;

    const number = numbers.get(chapter.id);
    const ownHeading = leadingHeadingText(markdown);
    body.push({
      kind: "chapter",
      chapter,
      label: style !== "none" && number !== undefined ? labels.chapter(number, style) : null,
      heading: ownHeading ?? chapter.title,
      body: ownHeading === null ? markdown : stripLeadingHeading(markdown),
    });
    chapterCount++;
  }

  return {
    title: registry.title,
    subtitle: metadata?.subtitle,
    author: options.author ?? registry.author,
    genre: registry.genre,
    language,
    labels,
    metadata,
    front,
    body,
    back,
    chapterCount,
    warnings,
  };
}

/** A chapter's name as a contents entry: "Kapitel 3: Der Kai" or "Der Kai". */
export function chapterEntry(item: ChapterItem): string {
  return item.label ? `${item.label}: ${item.heading}` : item.heading;
}

/** A part's name as a contents entry. */
export function partEntry(item: PartItem): string {
  return item.label ? `${item.label}: ${item.title}` : item.title;
}

/**
 * The whole book as one Markdown document — the Markdown export and the
 * preview. Every piece is followed by a rule, which the preview draws as its
 * ornament between chapters.
 */
export function bookToMarkdown(book: AssembledBook, options: { titleBlock?: boolean } = {}): string {
  const pieces: string[] = [];

  if (options.titleBlock !== false) {
    const title = [`# ${book.title}`];
    if (book.subtitle) title.push(`*${book.subtitle}*`);
    title.push(`**${book.labels.by === "by" ? "By" : capitalise(book.labels.by)} ${book.author}**`);
    if (book.genre) title.push(`*${book.genre}*`);
    pieces.push(title.join("\n\n"));
  }

  const matter = (section: RenderedMatter) =>
    section.heading ? `# ${section.heading}\n\n${section.markdown.trim()}` : section.markdown.trim();

  for (const section of book.front) pieces.push(matter(section));

  for (const item of book.body) {
    if (item.kind === "part") {
      pieces.push(item.label ? `# ${item.label}\n\n## ${item.title}` : `# ${item.title}`);
    } else {
      pieces.push(`# ${chapterEntry(item)}\n\n${item.body.trim()}`);
    }
  }

  for (const section of book.back) pieces.push(matter(section));

  return pieces.map((piece) => `${piece}\n\n---\n\n`).join("");
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
