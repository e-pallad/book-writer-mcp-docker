// Builds the .docx. Chapter markdown goes through the same parser as the
// preview and the EPUB, and comes out as real Word formatting: italic and bold
// runs, heading styles, scene breaks and indented quotes — not the literal
// asterisks and hashes the export used to write.
//
// Three layouts: a book to read, and the two manuscript formats a book is
// submitted in — the German Normseite and the Standard Manuscript Format of
// English-language publishing.

import {
  AlignmentType,
  Document,
  Footer,
  Header,
  HeadingLevel,
  IParagraphOptions,
  LineRuleType,
  Packer,
  PageNumber,
  Paragraph,
  TabStopType,
  TextRun,
} from "docx";
import { Block, inlineRuns, parseBlocks } from "../utils/markdown";
import { AssembledBook, chapterEntry, partEntry } from "./assemble";
import { RenderedMatter } from "./matter";
import { NORMSEITE } from "./normseite";

export type DocxPreset = "book" | "normseite" | "standard_manuscript";

export interface DocxLayout {
  preset: DocxPreset;
  fontFamily: string;
  /** Points. */
  fontSize: number;
  /** Line pitch in twips, and whether it is exact or a multiple. */
  line: number;
  lineRule: "auto" | "exact";
  includeTableOfContents: boolean;
  /** Page numbers in the footer (the book layout; manuscripts put them in the header). */
  includePageNumbers: boolean;
  page: {
    width: number;
    height: number;
    margin: { top: number; right: number; bottom: number; left: number; header: number; footer: number };
  };
  /** Running head on every page after the first: text, then the page number. */
  runningHead?: string;
  firstLineIndent: number;
  sceneBreak: string;
  /** Space above a chapter's opening, in twips. */
  chapterSink: number;
  /** Points. */
  headingSize: number;
  headingBold: boolean;
  /** Space below a chapter title, in twips — whole lines for a manuscript. */
  headingAfter: number;
  /** Printed after the last chapter ("END"). */
  endMark?: string;
  /** A manuscript's cover sheet: contact block and extent. */
  coverSheet?: { contact: string[]; extent: string };
  /**
   * Word's widow and orphan control moves lines to the next page, which
   * would break a Normseite's fixed 30 lines.
   */
  widowControl: boolean;
}

// Word measures in twentieths of a point ("twips"): 1440 to the inch.
const INCH = 1440;
const QUOTE_INDENT = 720;

const A4 = { width: 11906, height: 16838 };
const LETTER = { width: 12240, height: 15840 };

export interface LayoutRequest {
  preset: DocxPreset;
  fontFamily?: string;
  fontSize?: number;
  lineSpacing?: "single" | "double";
  includeTableOfContents?: boolean;
  includePageNumbers?: boolean;
  /** For the manuscript cover sheet. */
  contact?: string[];
  extent?: string;
  runningHead?: string;
}

/**
 * The layout for a preset. The book layout takes the caller's font and
 * spacing; the manuscript formats are fixed, because that is what makes them
 * the format — only the Standard Manuscript Format's face may be Courier or
 * Times.
 */
export function layoutFor(request: LayoutRequest): DocxLayout {
  if (request.preset === "normseite") {
    return {
      preset: "normseite",
      fontFamily: "Courier New",
      fontSize: 12,
      line: NORMSEITE.lineTwips,
      lineRule: "exact",
      includeTableOfContents: false,
      includePageNumbers: false,
      page: {
        ...A4,
        margin: {
          top: NORMSEITE.marginTop,
          bottom: NORMSEITE.marginBottom,
          left: NORMSEITE.marginLeft,
          right: NORMSEITE.marginRight,
          header: 709,
          footer: 709,
        },
      },
      runningHead: request.runningHead,
      firstLineIndent: NORMSEITE.indentTwips,
      sceneBreak: "*",
      chapterSink: NORMSEITE.lineTwips * NORMSEITE.chapterSinkLines,
      headingSize: 12,
      headingBold: true,
      headingAfter: NORMSEITE.lineTwips,
      coverSheet: { contact: request.contact ?? [], extent: request.extent ?? "" },
      widowControl: false,
    };
  }

  if (request.preset === "standard_manuscript") {
    return {
      preset: "standard_manuscript",
      fontFamily: request.fontFamily ?? "Times New Roman",
      fontSize: 12,
      line: 480,
      lineRule: "auto",
      includeTableOfContents: false,
      includePageNumbers: false,
      page: {
        ...LETTER,
        margin: { top: INCH, bottom: INCH, left: INCH, right: INCH, header: 720, footer: 720 },
      },
      runningHead: request.runningHead,
      firstLineIndent: INCH / 2,
      sceneBreak: "#",
      // A chapter opens about a third of the way down the page.
      chapterSink: Math.round(INCH * 2.5),
      headingSize: 12,
      headingBold: false,
      headingAfter: 0,
      endMark: "END",
      coverSheet: { contact: request.contact ?? [], extent: request.extent ?? "" },
      widowControl: true,
    };
  }

  const fontSize = request.fontSize ?? 12;
  return {
    preset: "book",
    fontFamily: request.fontFamily ?? "Times New Roman",
    fontSize,
    line: (request.lineSpacing ?? "double") === "double" ? 480 : 240,
    lineRule: "auto",
    includeTableOfContents: request.includeTableOfContents ?? true,
    includePageNumbers: request.includePageNumbers ?? true,
    page: {
      ...A4,
      margin: { top: INCH, bottom: INCH, left: INCH, right: INCH, header: 708, footer: 708 },
    },
    firstLineIndent: 360, // a quarter inch, the usual book indent
    sceneBreak: "* * *",
    chapterSink: 2000,
    headingSize: fontSize + 4,
    headingBold: true,
    headingAfter: 400,
    widowControl: true,
  };
}

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

class Builder {
  readonly paragraphs: Paragraph[] = [];

  constructor(
    private readonly book: AssembledBook,
    private readonly layout: DocxLayout
  ) {}

  private add(options: IParagraphOptions): void {
    const pitch = {
      line: this.layout.line,
      lineRule: this.layout.lineRule === "exact" ? LineRuleType.EXACT : LineRuleType.AUTO,
    };
    this.paragraphs.push(
      new Paragraph({
        ...options,
        ...(this.layout.widowControl ? {} : { widowControl: false }),
        spacing: { ...pitch, after: 0, ...(options.spacing ?? {}) },
      })
    );
  }

  /** An empty line at the body's pitch — manuscripts count in lines. */
  private blankLine(): void {
    this.add({ children: [] });
  }

  /**
   * One chapter's blocks. Printed prose indents the first line of every
   * paragraph except the first after a heading, a scene break or a quote —
   * that one starts flush, which tells the eye a new section has begun.
   * Manuscripts indent every paragraph.
   */
  body(blocks: Block[]): void {
    const manuscript = this.layout.preset !== "book";
    let flush = !manuscript;

    for (const block of blocks) {
      switch (block.type) {
        case "paragraph":
          this.add({
            ...(flush ? {} : { indent: { firstLine: this.layout.firstLineIndent } }),
            children: runs(block.text),
          });
          flush = false;
          break;
        case "heading":
          this.add({
            heading: block.level <= 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
            // A manuscript keeps to its line grid: one blank line above.
            ...(manuscript ? { spacing: { before: this.layout.line } } : {}),
            children: runs(block.text),
          });
          flush = !manuscript;
          break;
        case "sceneBreak":
          if (manuscript) this.blankLine();
          this.add({
            alignment: AlignmentType.CENTER,
            ...(manuscript ? {} : { spacing: { before: 240, after: 240 } }),
            children: [new TextRun(this.layout.sceneBreak)],
          });
          if (manuscript) this.blankLine();
          flush = !manuscript;
          break;
        case "blockquote":
          for (const text of quotedTexts(block.blocks)) {
            this.add({
              ...(manuscript ? {} : { spacing: { before: 120, after: 120 } }),
              indent: { left: QUOTE_INDENT, right: QUOTE_INDENT },
              children: runs(text),
            });
          }
          flush = !manuscript;
          break;
      }
    }
  }

  /** A page of its own for a piece of front or back matter. */
  matter(section: RenderedMatter): void {
    const blocks = parseBlocks(section.markdown);
    if (section.heading) {
      this.add({
        heading: HeadingLevel.HEADING_1,
        pageBreakBefore: true,
        spacing: { before: this.layout.chapterSink, after: 400 },
        children: runs(section.heading),
      });
      this.body(blocks);
      return;
    }

    // A dedication is centred a third of the way down; an epigraph set in from
    // both sides; the copyright page plain. None has a heading.
    const texts = blocks.flatMap((b) =>
      b.type === "blockquote" ? quotedTexts(b.blocks) : b.type === "sceneBreak" ? [] : [b.text]
    );
    texts.forEach((text, index) =>
      this.add({
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

  titlePage(): void {
    const { book, layout } = this;
    const halfPoints = layout.fontSize * 2;

    if (layout.coverSheet) {
      // A manuscript's cover sheet: who to contact, top left; how long it is,
      // top right; the title in the middle of the page.
      const sheet = layout.coverSheet;
      const contact = sheet.contact.length ? sheet.contact : [book.author];
      const textWidth = layout.page.width - layout.page.margin.left - layout.page.margin.right;
      contact.forEach((line, index) =>
        this.add(
          index === 0 && sheet.extent
            ? {
                tabStops: [{ type: TabStopType.RIGHT, position: textWidth }],
                children: [new TextRun(line), new TextRun(`\t${sheet.extent}`)],
              }
            : { children: [new TextRun(line)] }
        )
      );
      this.add({
        alignment: AlignmentType.CENTER,
        spacing: { before: layout.chapterSink * 2 },
        children: [new TextRun(book.title.toUpperCase())],
      });
      if (book.subtitle) this.add({ alignment: AlignmentType.CENTER, children: [new TextRun(book.subtitle)] });
      if (book.genre && layout.preset === "normseite") {
        this.add({ alignment: AlignmentType.CENTER, children: [new TextRun(book.genre)] });
      }
      this.blankLine();
      this.add({ alignment: AlignmentType.CENTER, children: [new TextRun(`${book.labels.by} ${book.author}`)] });
      return;
    }

    this.paragraphs.push(
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
        children: [new TextRun({ text: `${book.labels.by} ${book.author}`, size: halfPoints + 4 })],
      })
    );
  }

  contents(): void {
    const { book } = this;
    this.add({
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: true,
      children: [new TextRun(book.labels.contents)],
    });
    const entry = (text: string, indent = false) =>
      this.add({ ...(indent ? { indent: { left: QUOTE_INDENT } } : {}), children: runs(text) });

    for (const section of book.front.filter((s) => !s.beforeContents && s.heading)) {
      entry(section.navTitle);
    }
    let insidePart = false;
    for (const item of book.body) {
      if (item.kind === "part") {
        entry(partEntry(item));
        insidePart = true;
      } else {
        entry(chapterEntry(item), insidePart && Boolean(item.chapter.part));
      }
    }
    for (const section of book.back.filter((s) => s.heading)) entry(section.navTitle);
  }

  bodyMatter(): void {
    const { book, layout } = this;
    for (const item of book.body) {
      if (item.kind === "part") {
        // A part page: the label and the title, centred, alone on the page.
        if (item.label) {
          this.add({
            alignment: AlignmentType.CENTER,
            pageBreakBefore: true,
            spacing: { before: layout.chapterSink * 2, after: 240 },
            children: [new TextRun(item.label)],
          });
        }
        this.add({
          heading: HeadingLevel.HEADING_1,
          alignment: AlignmentType.CENTER,
          ...(item.label ? {} : { pageBreakBefore: true, spacing: { before: layout.chapterSink * 2 } }),
          children: runs(item.title),
        });
        continue;
      }

      // The chapter's number above its title, the page break on whichever
      // comes first.
      const centred = item.label !== null || layout.preset === "standard_manuscript";
      if (item.label) {
        this.add({
          pageBreakBefore: true,
          alignment: AlignmentType.CENTER,
          spacing: { before: layout.chapterSink, after: layout.preset === "book" ? 120 : 0 },
          children: [new TextRun(item.label)],
        });
      }
      this.add({
        heading: HeadingLevel.HEADING_1,
        ...(centred ? { alignment: AlignmentType.CENTER } : {}),
        ...(item.label
          ? { spacing: { after: layout.headingAfter } }
          : { pageBreakBefore: true, spacing: { before: layout.chapterSink, after: layout.headingAfter } }),
        children: runs(item.heading),
      });
      this.body(parseBlocks(item.body));
    }

    if (layout.endMark) {
      this.blankLine();
      this.add({ alignment: AlignmentType.CENTER, children: [new TextRun(layout.endMark)] });
    }
  }
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

export async function buildDocx(book: AssembledBook, layout: DocxLayout): Promise<Buffer> {
  const builder = new Builder(book, layout);
  const headingRun = { font: layout.fontFamily, bold: layout.headingBold, color: "000000" };

  builder.titlePage();
  for (const section of book.front.filter((s) => s.beforeContents)) builder.matter(section);
  if (layout.includeTableOfContents) builder.contents();
  for (const section of book.front.filter((s) => !s.beforeContents)) builder.matter(section);
  builder.bodyMatter();
  for (const section of book.back) builder.matter(section);

  // Manuscripts carry a running head with the page number on every page but
  // the cover sheet; the book layout numbers its pages in the footer.
  const runningHead = layout.runningHead
    ? new Header({
        children: [
          new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [
              new TextRun(`${layout.runningHead} / `),
              new TextRun({ children: [PageNumber.CURRENT] }),
            ],
          }),
        ],
      })
    : null;

  const doc = new Document({
    creator: book.author,
    title: book.title,
    styles: {
      default: {
        document: {
          run: {
            font: layout.fontFamily,
            size: layout.fontSize * 2,
            language: { value: wordLanguage(book.language) },
          },
        },
        // Word's built-in heading styles are blue sans-serif; a manuscript's
        // headings are the body face, in black. These override the built-in
        // ones in place rather than adding a second "Heading1" beside them.
        heading1: {
          run: { ...headingRun, size: layout.headingSize * 2 },
          paragraph: { spacing: { after: 400 }, keepNext: true },
        },
        heading2: {
          run: { ...headingRun, size: Math.max(layout.fontSize, layout.headingSize - 2) * 2 },
          paragraph: { spacing: { before: 360, after: 240 }, keepNext: true },
        },
        heading3: {
          run: { ...headingRun, size: Math.max(layout.fontSize, layout.headingSize - 3) * 2 },
          paragraph: { spacing: { before: 240, after: 120 }, keepNext: true },
        },
      },
    },
    sections: [
      {
        properties: {
          page: { size: { width: layout.page.width, height: layout.page.height }, margin: layout.page.margin },
          ...(runningHead ? { titlePage: true } : {}),
        },
        headers: runningHead ? { default: runningHead, first: new Header({ children: [] }) } : {},
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
        children: builder.paragraphs,
      },
    ],
  });

  return Packer.toBuffer(doc);
}
