// The small markdown subset the manuscript tools render: headings, emphasis,
// horizontal rules and paragraphs. Shared by the HTML preview and the EPUB
// export so the two cannot drift into rendering the same chapter differently.

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

export interface MarkdownOptions {
  /**
   * Close void elements as `<hr />` and `<br />`. EPUB content documents are
   * XHTML, where the HTML spelling is a parse error rather than a nicety.
   */
  xhtml?: boolean;
}

export function markdownToHtml(md: string, options: MarkdownOptions = {}): string {
  const hr = options.xhtml ? "<hr />" : "<hr>";
  const br = options.xhtml ? "<br />" : "<br>";

  let html = escapeHtml(md);

  // Process headers in descending specificity to avoid partial matches
  html = html.replace(/^---$/gm, hr);
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");

  html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

  const blocks = html.split(/\n\n+/);
  html = blocks
    .map((block) => {
      block = block.trim();
      if (!block) return "";
      if (/^<(h[1-3]|hr)/.test(block)) return block;
      return `<p>${block.replace(/\n/g, br)}</p>`;
    })
    .join("\n");

  return html;
}

/**
 * Strips the leading `# Heading` from a chapter, for the places that supply
 * their own title markup and would otherwise show it twice.
 */
export function stripLeadingHeading(md: string): string {
  return md.replace(/^[ \t]{0,3}#[ \t]+.*(?:\r?\n)+/, "");
}
