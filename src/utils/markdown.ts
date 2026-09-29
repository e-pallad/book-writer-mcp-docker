// The small markdown subset the manuscript tools render: headings, emphasis,
// scene breaks, block quotes and paragraphs. Parsed once into blocks and
// inline nodes, then rendered as HTML (the preview, the EPUB export) or
// flattened into styled runs (the DOCX export), so no two outputs can drift
// into reading the same chapter differently.

/** Escapes text for use as HTML/XML character data. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Escapes text for use inside an XML attribute or a metadata element, where
 * quotes and apostrophes matter too. A book titled `The "Good" Son` would
 * otherwise close the attribute early and produce an unparseable package
 * document.
 */
export function escapeXml(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// ---------------------------------------------------------------------------
// Scene breaks

// A line on its own that separates two scenes. Printed books mark it with an
// ornament, manuscripts with "#" (Standard Manuscript Format) or "* * *", and
// writers type whatever their last word processor taught them. All of these
// mean the same thing, and none of them is emphasis: "***" used to reach the
// italic rule and come out as <em>*</em>.
const SCENE_BREAK_PATTERNS = [
  /^(?:\*[ \t]*){3,}$/, // ***  * * *
  /^(?:-[ \t]*){3,}$/, // ---  - - -
  /^(?:_[ \t]*){3,}$/, // ___
  /^(?:~[ \t]*){3,}$/, // ~ ~ ~  (not "~~~" alone, which some editors use for code)
  /^#$/, // Standard Manuscript Format
  /^(?:⁂|∗ ∗ ∗|•[ \t]*•[ \t]*•|◆|❧|✻)$/,
];

/** Whether one line, on its own, marks a scene break. */
export function isSceneBreakLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  // "~~~" without spaces opens a fenced code block in most editors.
  if (/^~{3,}$/.test(trimmed)) return false;
  return SCENE_BREAK_PATTERNS.some((pattern) => pattern.test(trimmed));
}

// ---------------------------------------------------------------------------
// Blocks

export type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "sceneBreak" }
  | { type: "blockquote"; blocks: Block[] };

// Up to three spaces of indent, one to six "#", then the text. "#" alone is a
// scene break, not an empty heading, which is why the text is required.
const HEADING = /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const QUOTE = /^[ \t]{0,3}>[ \t]?(.*)$/;

/**
 * Splits markdown into blocks. A heading, a scene break or a quote line ends
 * the paragraph before it even without a blank line in between, because that
 * is how they are typed in practice.
 */
export function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let quote: string[] | null = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ type: "paragraph", text: paragraph.join("\n") });
      paragraph = [];
    }
  };
  const flushQuote = () => {
    if (quote) {
      blocks.push({ type: "blockquote", blocks: parseBlocks(quote.join("\n")) });
      quote = null;
    }
  };

  for (const line of lines) {
    const quoted = QUOTE.exec(line);
    if (quoted) {
      flushParagraph();
      (quote ??= []).push(quoted[1]);
      continue;
    }
    // A blank line inside a quote only ends it when the next line is not
    // quoted too; until then it separates paragraphs within the quote.
    if (!line.trim()) {
      if (quote) {
        quote.push("");
      } else {
        flushParagraph();
      }
      continue;
    }
    flushQuote();

    if (isSceneBreakLine(line)) {
      flushParagraph();
      blocks.push({ type: "sceneBreak" });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({
        type: "heading",
        level: heading[1].length,
        text: heading[2],
      });
      continue;
    }

    paragraph.push(line.trim() ? line.replace(/^[ \t]+/, "") : line);
  }

  flushParagraph();
  flushQuote();

  // Trailing blank quote lines leave an empty paragraph-less quote; drop it.
  return blocks.filter(
    (block) => block.type !== "blockquote" || block.blocks.length > 0
  );
}

// ---------------------------------------------------------------------------
// Inline

export type InlineNode =
  | { kind: "text"; text: string }
  | { kind: "strong" | "em"; children: InlineNode[] }
  | { kind: "br" };

// Characters that a backslash turns back into plain text, so an author can
// write a literal asterisk.
const ESCAPABLE = /\\([\\*_#>`~\-])/g;
// Private-use code points stand in for escaped characters while the emphasis
// rules run, so an escaped "*" can never pair with a real one.
const ESCAPE_BASE = 0xe000;

const WORD = "[\\p{L}\\p{N}]";

// Ordered by delimiter length: at the same position the longer one wins, so
// "***x***" is bold-italic rather than italic around "**x**".
const EMPHASIS: { pattern: RegExp; wrap: ("strong" | "em")[] }[] = [
  { pattern: /\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/u, wrap: ["strong", "em"] },
  { pattern: /\*\*(?=\S)([\s\S]*?\S)\*\*/u, wrap: ["strong"] },
  { pattern: /\*(?=[^\s*])([\s\S]*?[^\s*])\*/u, wrap: ["em"] },
  // Underscores only at word edges: "snake_case_name" is not emphasis.
  { pattern: new RegExp(`(?<!${WORD})__(?=\\S)([\\s\\S]*?\\S)__(?!${WORD})`, "u"), wrap: ["strong"] },
  { pattern: new RegExp(`(?<!${WORD})_(?=[^\\s_])([\\s\\S]*?[^\\s_])_(?!${WORD})`, "u"), wrap: ["em"] },
];

function protectEscapes(text: string): { text: string; escaped: string[] } {
  const escaped: string[] = [];
  const protectedText = text.replace(ESCAPABLE, (_match, char: string) => {
    escaped.push(char);
    return String.fromCharCode(ESCAPE_BASE + escaped.length - 1);
  });
  return { text: protectedText, escaped };
}

function restoreEscapes(text: string, escaped: string[]): string {
  if (!escaped.length) return text;
  return text.replace(/[-]/g, (char) => {
    const index = char.charCodeAt(0) - ESCAPE_BASE;
    return escaped[index] ?? char;
  });
}

function textNodes(text: string, escaped: string[]): InlineNode[] {
  const nodes: InlineNode[] = [];
  const lines = restoreEscapes(text, escaped).split("\n");
  lines.forEach((line, index) => {
    if (index > 0) nodes.push({ kind: "br" });
    if (line) nodes.push({ kind: "text", text: line });
  });
  return nodes;
}

function parseEmphasis(text: string, escaped: string[]): InlineNode[] {
  const nodes: InlineNode[] = [];
  let rest = text;

  while (rest) {
    let best: { index: number; length: number; inner: string; wrap: ("strong" | "em")[] } | null = null;
    for (const { pattern, wrap } of EMPHASIS) {
      const match = pattern.exec(rest);
      if (!match) continue;
      if (!best || match.index < best.index) {
        best = { index: match.index, length: match[0].length, inner: match[1], wrap };
      }
    }

    if (!best) {
      nodes.push(...textNodes(rest, escaped));
      break;
    }

    if (best.index > 0) nodes.push(...textNodes(rest.slice(0, best.index), escaped));

    let inner: InlineNode[] = parseEmphasis(best.inner, escaped);
    for (const kind of [...best.wrap].reverse()) {
      inner = [{ kind, children: inner }];
    }
    nodes.push(...inner);
    rest = rest.slice(best.index + best.length);
  }

  return nodes;
}

/** Parses emphasis and line breaks inside one paragraph or heading. */
export function parseInline(text: string): InlineNode[] {
  const { text: protectedText, escaped } = protectEscapes(text);
  return parseEmphasis(protectedText, escaped);
}

export interface StyledRun {
  text: string;
  bold: boolean;
  italic: boolean;
  /** A line break before this run's text. */
  breakBefore: boolean;
}

/**
 * Flattens inline nodes into runs of uniformly styled text — the shape a word
 * processor wants, where bold and italic are properties of a run rather than
 * nested elements.
 */
export function inlineRuns(text: string): StyledRun[] {
  const runs: StyledRun[] = [];
  let pendingBreak = false;

  const walk = (nodes: InlineNode[], bold: boolean, italic: boolean) => {
    for (const node of nodes) {
      if (node.kind === "br") {
        pendingBreak = true;
      } else if (node.kind === "text") {
        runs.push({ text: node.text, bold, italic, breakBefore: pendingBreak });
        pendingBreak = false;
      } else {
        walk(node.children, bold || node.kind === "strong", italic || node.kind === "em");
      }
    }
  };
  walk(parseInline(text), false, false);

  if (pendingBreak) runs.push({ text: "", bold: false, italic: false, breakBefore: true });
  return runs;
}

/** The text of a block with the markdown markup removed. */
export function plainText(text: string): string {
  return inlineRuns(text)
    .map((run) => (run.breakBefore ? "\n" : "") + run.text)
    .join("");
}

// ---------------------------------------------------------------------------
// HTML

export interface MarkdownOptions {
  /**
   * Close void elements as `<hr />` and `<br />`. EPUB content documents are
   * XHTML, where the HTML spelling is a parse error rather than a nicety.
   */
  xhtml?: boolean;
}

function inlineHtml(nodes: InlineNode[], br: string): string {
  return nodes
    .map((node) => {
      if (node.kind === "br") return br;
      if (node.kind === "text") return escapeHtml(node.text);
      return `<${node.kind}>${inlineHtml(node.children, br)}</${node.kind}>`;
    })
    .join("");
}

function blocksHtml(blocks: Block[], options: MarkdownOptions): string {
  const hr = options.xhtml ? "<hr />" : "<hr>";
  const br = options.xhtml ? "<br />" : "<br>";

  return blocks
    .map((block) => {
      switch (block.type) {
        case "sceneBreak":
          return hr;
        case "heading": {
          // The reader and the EPUB style three levels; deeper ones are rare
          // in prose and read fine as the third.
          const level = Math.min(block.level, 3);
          return `<h${level}>${inlineHtml(parseInline(block.text), br)}</h${level}>`;
        }
        case "blockquote":
          return `<blockquote>\n${blocksHtml(block.blocks, options)}\n</blockquote>`;
        case "paragraph":
          return `<p>${inlineHtml(parseInline(block.text), br)}</p>`;
      }
    })
    .join("\n");
}

export function markdownToHtml(md: string, options: MarkdownOptions = {}): string {
  return blocksHtml(parseBlocks(md), options);
}

/** One line of inline markdown — a heading's text — as HTML. */
export function inlineMarkdownToHtml(text: string, options: MarkdownOptions = {}): string {
  return inlineHtml(parseInline(text), options.xhtml ? "<br />" : "<br>");
}

// The chapter's own "# Title" line, when the file opens with one.
const LEADING_HEADING = /^\s*[ \t]{0,3}#[ \t]+(.+?)[ \t]*#*[ \t]*(?:\r?\n|$)/;

/** The text of the heading a chapter file opens with, or null. */
export function leadingHeadingText(md: string): string | null {
  const match = LEADING_HEADING.exec(md);
  return match ? match[1] : null;
}

/**
 * Strips the leading `# Heading` from a chapter, for the places that supply
 * their own title markup and would otherwise show it twice.
 */
export function stripLeadingHeading(md: string): string {
  return md.replace(/^\s*[ \t]{0,3}#[ \t]+.*(?:\r?\n|$)(?:\r?\n)*/, "");
}
