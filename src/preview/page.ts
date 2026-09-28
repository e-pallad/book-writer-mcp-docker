// The reader page, shared by the one-off book_preview export and the live
// preview server so both render a chapter identically.

import { escapeHtml, markdownToHtml } from "../utils/markdown";

export interface ReaderPageOptions {
  /**
   * Reload the page every N seconds via a meta refresh. The live server sets
   * it; the one-off export leaves it off. A meta refresh rather than a script,
   * so a saved page carries no executable code.
   */
  refreshSeconds?: number;
}

export function buildReaderPage(
  title: string,
  author: string,
  content: string,
  wordCount: number,
  options: ReaderPageOptions = {}
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} — Preview</title>
  ${
    options.refreshSeconds
      ? `<meta http-equiv="refresh" content="${options.refreshSeconds}" />`
      : ""
  }
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=Source+Serif+4:ital,wght@0,300;0,400;0,600;1,300;1,400&display=swap');

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      background: #f5f1eb;
      color: #2c2c2c;
      font-family: 'Source Serif 4', 'Georgia', serif;
      font-size: 18px;
      line-height: 1.8;
      -webkit-font-smoothing: antialiased;
    }

    .book {
      max-width: 640px;
      margin: 0 auto;
      padding: 60px 40px 120px;
      background: #fffdf8;
      min-height: 100vh;
      box-shadow: 0 0 60px rgba(0,0,0,0.08);
    }

    h1 {
      font-family: 'Playfair Display', 'Georgia', serif;
      font-size: 2em;
      font-weight: 700;
      margin: 2em 0 0.6em;
      line-height: 1.25;
      color: #1a1a1a;
      letter-spacing: -0.01em;
    }

    h1:first-child {
      font-size: 2.4em;
      margin-top: 1em;
      text-align: center;
      border-bottom: 2px solid #c9b99a;
      padding-bottom: 0.5em;
      margin-bottom: 1em;
    }

    h2 {
      font-family: 'Playfair Display', 'Georgia', serif;
      font-size: 1.4em;
      font-weight: 700;
      margin: 2.5em 0 0.8em;
      color: #1a1a1a;
      letter-spacing: 0.02em;
    }

    h3 {
      font-family: 'Playfair Display', 'Georgia', serif;
      font-size: 1.15em;
      font-weight: 700;
      margin: 2em 0 0.6em;
      color: #333;
    }

    p {
      margin-bottom: 1.2em;
      text-align: justify;
      hyphens: auto;
    }

    /* Drop cap on the first paragraph after each chapter heading */
    h1 + p::first-letter,
    h2 + p::first-letter {
      font-family: 'Playfair Display', serif;
      font-size: 3.2em;
      float: left;
      line-height: 0.8;
      margin: 0.05em 0.1em 0 0;
      color: #6b4c2a;
    }

    em { font-style: italic; }
    strong { font-weight: 600; }

    hr {
      border: none;
      text-align: center;
      margin: 2.5em 0;
    }
    hr::after {
      content: '\\2022  \\2022  \\2022';
      color: #c9b99a;
      font-size: 1.2em;
      letter-spacing: 0.5em;
    }

    .timestamp {
      text-align: center;
      color: #999;
      font-size: 0.75em;
      font-family: system-ui, sans-serif;
      padding: 20px 0;
      border-top: 1px solid #e8e2d8;
      margin-top: 60px;
    }

    .word-count {
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: #2c2c2c;
      color: #f5f1eb;
      font-family: system-ui, sans-serif;
      font-size: 12px;
      padding: 8px 14px;
      border-radius: 20px;
      opacity: 0.7;
    }

    @media (max-width: 700px) {
      .book { padding: 40px 24px 100px; }
      body { font-size: 16px; }
      h1:first-child { font-size: 1.8em; }
    }
  </style>
</head>
<body>
  <div class="book">
    ${content}
    <div class="timestamp">Generated: ${new Date().toLocaleString()}</div>
  </div>
  <div class="word-count">${wordCount.toLocaleString()} words</div>
</body>
</html>`;
}
