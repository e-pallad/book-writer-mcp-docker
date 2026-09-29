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
import { Block, inlineRuns, parseBlocks } from "../utils/markdown";
import { AssembledBook, chapterEntry, partEntry } from "./assemble";
import { RenderedMatter } from "./matter";

export interface DocxLayout {
  fontFamily: string;
  /** Points. */
  fontSize: number;
  lineSpacing: "single" | "double";
  includeTableOfContents: boolean;
  includePageNumbers: boolean;
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

/** A page of its own for a piece of front or back matter. */
function matterParagraphs(section: RenderedMatter, line: number): Paragraph[] {
  const blocks = parseBlocks(section.markdown);
  if (section.heading) {
    return [
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        pageBreakBefore: true,
        spacing: { before: 2000, after: 400 },
        children: runs(section.heading),
      }),
      ...chapterBody(blocks, line),
    ];
  }

  // A dedication is centred a third of the way down; an epigraph set in from
  // both sides; the copyright page plain. None has a heading.
  const texts = blocks.flatMap((b) =>
    b.type === "blockquote" ? quotedTexts(b.blocks) : b.type === "sceneBreak" ? [] : [b.text]
  );
  return texts.map(
    (text, index) =>
      new Paragraph({
        ...(index === 0 ? { pageBreakBefore: true } : {}),
        ...(section.type === "dedication"
          ? { alignment: AlignmentType.CENTER, spacing: { before: index === 0 ? 3000 : 0, after: 120 } }
          : section.type === "epigraph"
          ? {
              indent: { left: QUOTE_INDENT * 2, right: QUOTE_INDENT },
              spacing: { before: index === 0 ? 3000 : 0, after: 120 },
            }
          : { spacing: { after: 200 } }),
        children: runs(text),
      })
  );
}

export async function buildDocx(book: AssembledBook, layout: DocxLayout): Promise<Buffer> {
  const line = layout.lineSpacing === "double" ? 480 : 240;
  const halfPoints = layout.fontSize * 2;
  const headingRun = { font: layout.fontFamily, bold: true, color: "000000" };

  const children: Paragraph[] = [];

  // Title page.
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 4000 },
      children: [new TextRun({ text: book.title, bold: true, size: halfPoints + 16 })],
    }),
    ...(book.subtitle
      ? [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 240 },
            children: [new TextRun({ text: book.subtitle, size: halfPoints + 6 })],
          }),
        ]
      : []),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 400 },
      children: [
        new TextRun({
          text: `${book.labels.by} ${book.author}`,
          size: halfPoints + 4,
        }),
      ],
    })
  );

  for (const section of book.front.filter((s) => s.beforeContents)) {
    children.push(...matterParagraphs(section, line));
  }

  if (layout.includeTableOfContents) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        pageBreakBefore: true,
        children: [new TextRun(book.labels.contents)],
      })
    );
    const entry = (text: string, indent = false) =>
      new Paragraph({
        spacing: { line },
        ...(indent ? { indent: { left: QUOTE_INDENT } } : {}),
        children: runs(text),
      });
    for (const section of book.front.filter((s) => !s.beforeContents && s.heading)) {
      children.push(entry(section.navTitle));
    }
    const inParts = book.body.some((item) => item.kind === "part");
    let insidePart = false;
    for (const item of book.body) {
      if (item.kind === "part") {
        children.push(entry(partEntry(item)));
        insidePart = true;
      } else {
        children.push(entry(chapterEntry(item), inParts && insidePart && Boolean(item.chapter.part)));
      }
    }
    for (const section of book.back.filter((s) => s.heading)) {
      children.push(entry(section.navTitle));
    }
  }

  for (const section of book.front.filter((s) => !s.beforeContents)) {
    children.push(...matterParagraphs(section, line));
  }

  for (const item of book.body) {
    if (item.kind === "part") {
      // A part page: the label and the title, centred, alone on the page.
      children.push(
        ...(item.label
          ? [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                pageBreakBefore: true,
                spacing: { before: 4000, after: 240 },
                children: [new TextRun({ text: item.label, size: halfPoints + 4 })],
              }),
            ]
          : []),
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          alignment: AlignmentType.CENTER,
          ...(item.label ? {} : { pageBreakBefore: true, spacing: { before: 4000 } }),
          children: runs(item.title),
        })
      );
      continue;
    }

    // The chapter's number above its title, the page break on whichever
    // comes first.
    if (item.label) {
      children.push(
        new Paragraph({
          pageBreakBefore: true,
          alignment: AlignmentType.CENTER,
          spacing: { before: 1600, after: 120 },
          children: [new TextRun({ text: item.label })],
        })
      );
    }
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        ...(item.label
          ? { alignment: AlignmentType.CENTER, spacing: { after: 400 } }
          : { pageBreakBefore: true, spacing: { before: 2000, after: 400 } }),
        children: runs(item.heading),
      })
    );
    children.push(...chapterBody(parseBlocks(item.body), line));
  }

  for (const section of book.back) {
    children.push(...matterParagraphs(section, line));
  }

  const doc = new Document({
    creator: book.author,
    title: book.title,
    styles: {
      default: {
        document: {
          run: {
            font: layout.fontFamily,
            size: halfPoints,
            language: { value: wordLanguage(book.language) },
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
        footers: layout.includePageNumbers
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
