// Builds the .docx manuscript. Chapter markdown goes through the same parser as
// the preview and the EPUB, and comes out as real Word formatting: italic and
// bold runs, heading styles, centred scene breaks and indented quotes — not as
// the literal asterisks and hashes the export used to write.

import {
  AlignmentType,
  Document,
  Footer,
  HeadingLevel,
  IParagraphOptions,
  Packer,
  PageNumber,
  Paragraph,
  TextRun,
} from "docx";
import { Block, inlineRuns, parseBlocks, stripLeadingHeading } from "../utils/markdown";

export interface DocxChapter {
  title: string;
  /** Position in the book, for the table of contents. */
  order: number;
  markdown: string;
}

export interface DocxOptions {
  title: string;
  subtitle?: string;
  author: string;
  chapters: DocxChapter[];
  fontFamily: string;
  /** Points. */
  fontSize: number;
  lineSpacing: "single" | "double";
  includeTableOfContents: boolean;
  includePageNumbers: boolean;
  /** Heading of the contents page. */
  contentsLabel?: string;
  /** Word before the author's name on the title page. */
  byLabel?: string;
  /**
   * BCP 47 tag the text is marked with, so Word spell-checks and hyphenates it
   * in the right language rather than the reader's default.
   */
  language?: string;
}

// Word measures in twentieths of a point ("twips"): 1440 to the inch.
const INDENT_FIRST_LINE = 360; // a quarter inch, the usual book indent
const QUOTE_INDENT = 720;

function runs(text: string): TextRun[] {
  return inlineRuns(text).map(
    (run) =>
      new TextRun({
        text: run.text,
        ...(run.bold ? { bold: true } : {}),
        ...(run.italic ? { italics: true } : {}),
        ...(run.breakBefore ? { break: 1 } : {}),
      })
  );
}

/** The paragraphs of a quote, with any quote nested inside it flattened in. */
function quotedTexts(blocks: Block[]): string[] {
  return blocks.flatMap((block) => {
    if (block.type === "blockquote") return quotedTexts(block.blocks);
    if (block.type === "sceneBreak") return [];
    return [block.text];
  });
}

/**
 * Turns one chapter's blocks into paragraphs.
 *
 * Printed prose indents the first line of every paragraph except the first one
 * after a heading, a scene break or a quote — that one starts flush, which is
 * what tells the eye a new section has begun.
 */
function chapterBody(blocks: Block[], line: number): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  let flush = true;

  const body = (text: string, extra: Partial<IParagraphOptions> = {}) =>
    new Paragraph({
      spacing: { line, after: 0 },
      ...(flush ? {} : { indent: { firstLine: INDENT_FIRST_LINE } }),
      ...extra,
      children: runs(text),
    });

  for (const block of blocks) {
    switch (block.type) {
      case "paragraph":
        paragraphs.push(body(block.text));
        flush = false;
        break;
      case "heading":
        paragraphs.push(
          new Paragraph({
            heading: block.level <= 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
            children: runs(block.text),
          })
        );
        flush = true;
        break;
      case "sceneBreak":
        paragraphs.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { line, before: 240, after: 240 },
            children: [new TextRun("* * *")],
          })
        );
        flush = true;
        break;
      case "blockquote":
        for (const text of quotedTexts(block.blocks)) {
          paragraphs.push(
            new Paragraph({
              spacing: { line, before: 120, after: 120 },
              indent: { left: QUOTE_INDENT, right: QUOTE_INDENT },
              children: runs(text),
            })
          );
        }
        flush = true;
        break;
    }
  }

  return paragraphs;
}

// Word wants a region: "de" alone is not a proofing language, "de-DE" is.
const DEFAULT_REGIONS: Record<string, string> = {
  de: "DE",
  en: "US",
  fr: "FR",
  es: "ES",
  it: "IT",
  nl: "NL",
  pt: "PT",
};

function wordLanguage(tag: string): string {
  const [language, region] = tag.trim().split(/[-_]/);
  const lower = language.toLowerCase();
  if (region && /^[A-Za-z]{2}$/.test(region)) return `${lower}-${region.toUpperCase()}`;
  return DEFAULT_REGIONS[lower] ? `${lower}-${DEFAULT_REGIONS[lower]}` : lower;
}

export async function buildDocx(options: DocxOptions): Promise<Buffer> {
  const line = options.lineSpacing === "double" ? 480 : 240;
  const halfPoints = options.fontSize * 2;
  const headingRun = { font: options.fontFamily, bold: true, color: "000000" };

  const children: Paragraph[] = [];

  // Title page.
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 4000 },
      children: [new TextRun({ text: options.title, bold: true, size: halfPoints + 16 })],
    }),
    ...(options.subtitle
      ? [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 240 },
            children: [new TextRun({ text: options.subtitle, size: halfPoints + 6 })],
          }),
        ]
      : []),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 400 },
      children: [
        new TextRun({
          text: `${options.byLabel ?? "by"} ${options.author}`,
          size: halfPoints + 4,
        }),
      ],
    })
  );

  if (options.includeTableOfContents) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        pageBreakBefore: true,
        children: [new TextRun(options.contentsLabel ?? "Table of Contents")],
      })
    );
    for (const chapter of options.chapters) {
      children.push(
        new Paragraph({
          spacing: { line },
          children: [new TextRun(`${chapter.order}. ${chapter.title}`)],
        })
      );
    }
  }

  for (const chapter of options.chapters) {
    // The chapter's own "# Title" line is replaced by the registry title,
    // which is the one a rename keeps current.
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        pageBreakBefore: true,
        spacing: { before: 2000, after: 400 },
        children: runs(chapter.title),
      })
    );
    children.push(...chapterBody(parseBlocks(stripLeadingHeading(chapter.markdown)), line));
  }

  const doc = new Document({
    creator: options.author,
    title: options.title,
    styles: {
      default: {
        document: {
          run: {
            font: options.fontFamily,
            size: halfPoints,
            ...(options.language ? { language: { value: wordLanguage(options.language) } } : {}),
          },
        },
        // Word's built-in heading styles are blue sans-serif; a manuscript's
        // headings are the body face, in black. These override the built-in
        // ones in place rather than adding a second "Heading1" beside them.
        heading1: {
          run: { ...headingRun, size: halfPoints + 8 },
          paragraph: { spacing: { after: 400 }, keepNext: true },
        },
        heading2: {
          run: { ...headingRun, size: halfPoints + 4 },
          paragraph: { spacing: { before: 360, after: 240 }, keepNext: true },
        },
        heading3: {
          run: { ...headingRun, size: halfPoints + 2 },
          paragraph: { spacing: { before: 240, after: 120 }, keepNext: true },
        },
      },
    },
    sections: [
      {
        footers: options.includePageNumbers
          ? {
              default: new Footer({
                children: [
                  new Paragraph({
                    alignment: AlignmentType.CENTER,
                    children: [new TextRun({ children: [PageNumber.CURRENT] })],
                  }),
                ],
              }),
            }
          : {},
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
}
