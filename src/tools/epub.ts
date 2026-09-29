import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import JSZip from "jszip";
import {
  getRegistry,
  getAuthorProfile,
  getMetadata,
  readChapterFile,
  updateMetadata,
} from "../storage/filestore";
import { ContributorRole } from "../storage/schema";
import { MARC_RELATORS, rightsStatement } from "../publishing/metadata";
import { BookMCPError } from "../utils/errors";
import { countWords } from "../utils/wordcount";
import { escapeHtml, escapeXml, markdownToHtml } from "../utils/markdown";
import { selectChapters } from "../export/select";
import { isValidLanguageTag, labelsFor, Labels, projectLanguage } from "../lang";

// EPUB3 requires dcterms:modified to the second, with no fractional part.
function epubTimestamp(date: Date): string {
  return `${date.toISOString().split(".")[0]}Z`;
}

function xhtmlDocument(title: string, body: string, language: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(
    language
  )}" lang="${escapeXml(language)}">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body>
${body}
</body>
</html>`;
}

const STYLESHEET = `/* Deliberately restrained: a reading system's own typography and the
   reader's font-size preference should win. Only what the manuscript's
   structure needs is stated here. */
body {
  margin: 0 5%;
  line-height: 1.5;
  text-align: justify;
}
h1, h2, h3 {
  text-align: left;
  line-height: 1.2;
  margin: 2em 0 1em;
  page-break-after: avoid;
  break-after: avoid;
}
h1 { font-size: 1.6em; }
h2 { font-size: 1.3em; }
p { margin: 0; text-indent: 1.2em; }
/* The first paragraph of a chapter or section is not indented, which is the
   convention in printed fiction. */
h1 + p, h2 + p, h3 + p, hr + p { text-indent: 0; }
hr {
  border: 0;
  border-top: 1px solid currentColor;
  width: 15%;
  margin: 2em auto;
  opacity: 0.5;
}
.titlepage { text-align: center; margin-top: 25%; }
.titlepage h1 { text-align: center; margin-bottom: 0.5em; }
.titlepage .subtitle { font-size: 1.2em; margin: 0 0 1.5em; text-indent: 0; }
.titlepage .series { font-variant: small-caps; margin: 0 0 1em; text-indent: 0; }
.titlepage .author { font-size: 1.1em; margin: 0; text-indent: 0; }
.titlepage .genre { font-style: italic; opacity: 0.75; text-indent: 0; }
blockquote { margin: 1em 2em; }
blockquote p { text-indent: 0; }
blockquote p + p { text-indent: 1.2em; }
nav ol { list-style: none; padding-left: 0; }
nav li { margin: 0.4em 0; }
`;

interface BookMetadata {
  title: string;
  author: string;
  language: string;
  identifier: string;
  modified: string;
  genre: string;
  description?: string;
  subtitle?: string;
  series?: { name: string; number?: number };
  publisher?: string;
  date?: string;
  rights?: string;
  subjects: string[];
  contributors: { name: string; role: ContributorRole }[];
}

// The metadata block beyond the required identifier, title and language. EPUB
// 3 refines a title with its type, which is how a reading system tells a
// subtitle from a second title, and places a book in a series with
// belongs-to-collection.
function optionalMetadata(meta: BookMetadata): string[] {
  const lines: string[] = [];
  if (meta.subtitle) {
    lines.push(
      '<meta refines="#title" property="title-type">main</meta>',
      `<dc:title id="subtitle">${escapeHtml(meta.subtitle)}</dc:title>`,
      '<meta refines="#subtitle" property="title-type">subtitle</meta>'
    );
  }
  if (meta.series) {
    lines.push(
      `<meta property="belongs-to-collection" id="series">${escapeHtml(meta.series.name)}</meta>`,
      '<meta refines="#series" property="collection-type">series</meta>'
    );
    if (meta.series.number !== undefined) {
      lines.push(`<meta refines="#series" property="group-position">${meta.series.number}</meta>`);
    }
  }
  meta.contributors.forEach((contributor, index) => {
    const id = `contributor-${index + 1}`;
    lines.push(
      `<dc:contributor id="${id}">${escapeHtml(contributor.name)}</dc:contributor>`,
      `<meta refines="#${id}" property="role" scheme="marc:relators">${MARC_RELATORS[contributor.role]}</meta>`
    );
  });
  if (meta.publisher) lines.push(`<dc:publisher>${escapeHtml(meta.publisher)}</dc:publisher>`);
  if (meta.date) lines.push(`<dc:date>${escapeHtml(meta.date)}</dc:date>`);
  if (meta.rights) lines.push(`<dc:rights>${escapeHtml(meta.rights)}</dc:rights>`);
  for (const subject of meta.subjects) lines.push(`<dc:subject>${escapeHtml(subject)}</dc:subject>`);
  if (meta.description) lines.push(`<dc:description>${escapeHtml(meta.description)}</dc:description>`);
  return lines;
}

function buildPackageDocument(
  meta: BookMetadata,
  chapters: { id: string; href: string }[]
): string {
  const manifest = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />',
    '<item id="css" href="style.css" media-type="text/css" />',
    '<item id="titlepage" href="titlepage.xhtml" media-type="application/xhtml+xml" />',
    '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml" />',
    ...chapters.map(
      (c) =>
        `<item id="${c.id}" href="${c.href}" media-type="application/xhtml+xml" />`
    ),
  ];

  const spine = [
    '<itemref idref="titlepage" />',
    '<itemref idref="nav" />',
    ...chapters.map((c) => `<itemref idref="${c.id}" />`),
  ];

  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="${escapeXml(
    meta.language
  )}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">${escapeHtml(meta.identifier)}</dc:identifier>
    <dc:title id="title">${escapeHtml(meta.title)}</dc:title>
    <dc:language>${escapeHtml(meta.language)}</dc:language>
    <dc:creator id="author">${escapeHtml(meta.author)}</dc:creator>
    <meta refines="#author" property="role" scheme="marc:relators">aut</meta>
    <meta property="dcterms:modified">${meta.modified}</meta>
${optionalMetadata(meta)
  .map((line) => `    ${line}\n`)
  .join("")}  </metadata>
  <manifest>
    ${manifest.join("\n    ")}
  </manifest>
  <spine toc="ncx">
    ${spine.join("\n    ")}
  </spine>
</package>`;
}

// EPUB3 readers use nav.xhtml, but a good many devices in the wild still read
// the EPUB2 NCX, and shipping both costs a few hundred bytes.
function buildNcx(meta: BookMetadata, chapters: { title: string; href: string }[]): string {
  const points = chapters
    .map(
      (c, index) => `    <navPoint id="navpoint-${index + 1}" playOrder="${index + 1}">
      <navLabel><text>${escapeHtml(c.title)}</text></navLabel>
      <content src="${c.href}" />
    </navPoint>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${escapeXml(meta.identifier)}" />
    <meta name="dtb:depth" content="1" />
    <meta name="dtb:totalPageCount" content="0" />
    <meta name="dtb:maxPageNumber" content="0" />
  </head>
  <docTitle><text>${escapeHtml(meta.title)}</text></docTitle>
  <navMap>
${points}
  </navMap>
</ncx>`;
}

function buildNavDocument(
  meta: BookMetadata,
  chapters: { title: string; href: string }[],
  labels: Labels
): string {
  const items = chapters
    .map((c) => `      <li><a href="${c.href}">${escapeHtml(c.title)}</a></li>`)
    .join("\n");

  return xhtmlDocument(
    labels.contents,
    `<nav epub:type="toc" id="toc">
    <h1>${escapeHtml(labels.contents)}</h1>
    <ol>
${items}
    </ol>
  </nav>
  <nav epub:type="landmarks" hidden="hidden">
    <h2>Landmarks</h2>
    <ol>
      <li><a epub:type="titlepage" href="titlepage.xhtml">${escapeHtml(labels.titlePage)}</a></li>
${chapters.length ? `      <li><a epub:type="bodymatter" href="${chapters[0].href}">${escapeHtml(labels.beginning)}</a></li>\n` : ""}    </ol>
  </nav>`,
    meta.language
  );
}

function buildTitlePage(meta: BookMetadata): string {
  return xhtmlDocument(
    meta.title,
    `<section epub:type="titlepage" class="titlepage">
    <h1>${escapeHtml(meta.title)}</h1>
${meta.subtitle ? `    <p class="subtitle">${escapeHtml(meta.subtitle)}</p>\n` : ""}${
      meta.series
        ? `    <p class="series">${escapeHtml(meta.series.name)}${
            meta.series.number !== undefined ? ` ${meta.series.number}` : ""
          }</p>\n`
        : ""
    }    <p class="author">${escapeHtml(meta.author)}</p>
${meta.genre ? `    <p class="genre">${escapeHtml(meta.genre)}</p>\n` : ""}  </section>`,
    meta.language
  );
}

export function registerEpubTools(server: McpServer): void {
  server.tool(
    "book_export_epub",
    "Compile the manuscript into a valid EPUB3 file, with a title page, a generated table of contents from the chapter titles, and the author taken from the author profile when one exists.",
    {
      outputPath: z
        .string()
        .optional()
        .describe("Output file path (default: ./manuscript.epub)"),
      includeChapters: z
        .array(z.string())
        .optional()
        .describe(
          "Chapter IDs or titles to include (default: all final + review chapters, or every chapter when none are marked ready)"
        ),
      language: z
        .string()
        .optional()
        .describe(
          'BCP 47 language tag for the book, e.g. "en", "en-GB", "de" (default: the project language set with book_init or book_project_update)'
        ),
      identifier: z
        .string()
        .optional()
        .describe(
          "Unique identifier — an ISBN as urn:isbn:9780000000000, or your own. A random UUID is generated when omitted."
        ),
      description: z
        .string()
        .optional()
        .describe("Blurb stored as the book's description (default: the description from book_metadata_set)"),
    },
    async ({ outputPath, includeChapters, language: languageOverride, identifier, description }) => {
      const registry = getRegistry();
      if (!registry)
        throw new BookMCPError("No book project found. Run book_init first.");

      const language = (languageOverride ?? projectLanguage().tag).trim();
      if (!isValidLanguageTag(language)) {
        throw new BookMCPError(`"${language}" is not a BCP 47 language tag.`);
      }
      const labels = labelsFor(language);

      const chapters = selectChapters(registry, includeChapters);
      if (chapters.length === 0) {
        throw new BookMCPError("No chapters to export.");
      }

      const outPath =
        outputPath ||
        path.join(process.env.BOOK_PROJECT_DIR || process.cwd(), "manuscript.epub");

      // The author profile is the more considered name when there is one; the
      // registry's author is what book_init was given in passing.
      const profile = getAuthorProfile();
      const author = profile?.name?.trim() || registry.author;

      // The identifier: one passed in, else the e-book's ISBN, else a UUID
      // kept in metadata.json — stable, so a reader's library recognises a
      // re-exported draft as the same book instead of adding a second copy.
      let published = getMetadata();
      let identifierSource: string;
      let bookId: string;
      if (identifier?.trim()) {
        bookId = identifier.trim();
        identifierSource = "the identifier parameter";
      } else if (published?.isbn?.ebook) {
        bookId = `urn:isbn:${published.isbn.ebook}`;
        identifierSource = "the e-book ISBN in metadata.json";
      } else {
        published = await updateMetadata((m) => {
          if (m.uuid) return false;
          m.uuid = randomUUID();
        });
        bookId = `urn:uuid:${published.uuid}`;
        identifierSource =
          "a stable UUID kept in metadata.json (set an e-book ISBN with book_metadata_set before publishing)";
      }

      const meta: BookMetadata = {
        title: registry.title,
        author,
        language,
        identifier: bookId,
        modified: epubTimestamp(new Date()),
        genre: registry.genre,
        description: description ?? published?.description,
        subtitle: published?.subtitle,
        series: published?.series,
        publisher: published?.publisher,
        date: published?.publicationDate,
        rights: published ? rightsStatement(published, registry) : undefined,
        subjects: [registry.genre, ...(published?.categories ?? [])].filter(Boolean),
        contributors: published?.contributors ?? [],
      };

      const warnings: string[] = [];
      const entries: { id: string; href: string; title: string }[] = [];
      const documents: { href: string; xhtml: string }[] = [];

      chapters.forEach((chapter, index) => {
        const markdown = readChapterFile(chapter.filename);
        if (!markdown.trim()) {
          warnings.push(
            `Chapter "${chapter.title}" (${chapter.filename}) is missing or empty on disk and was skipped.`
          );
          return;
        }

        // Sequential file names rather than the chapter's own: a chapter id is
        // safe, but a slug is not guaranteed to be a legal, unique href.
        const href = `chapter-${String(index + 1).padStart(3, "0")}.xhtml`;
        const body = markdownToHtml(markdown, { xhtml: true });

        // A chapter whose markdown carries no heading of its own still needs
        // one, or it is unreachable from the table of contents by sight.
        const hasHeading = /^<h1/m.test(body);
        const withHeading = hasHeading
          ? body
          : `<h1>${escapeHtml(chapter.title)}</h1>\n${body}`;

        entries.push({ id: `chapter-${index + 1}`, href, title: chapter.title });
        documents.push({
          href,
          xhtml: xhtmlDocument(chapter.title, withHeading, language),
        });
      });

      if (entries.length === 0) {
        throw new BookMCPError(
          "Every selected chapter is empty on disk, so there is nothing to export."
        );
      }

      const zip = new JSZip();

      // "mimetype" must be the first entry and must be stored uncompressed.
      // A reader identifies the file by reading it at a fixed offset, so a
      // deflated or misplaced mimetype makes the EPUB unrecognisable even
      // though the rest of the archive is perfectly good.
      zip.file("mimetype", "application/epub+zip", { compression: "STORE" });

      zip.file(
        "META-INF/container.xml",
        `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml" />
  </rootfiles>
</container>`
      );

      zip.file("OEBPS/style.css", STYLESHEET);
      zip.file("OEBPS/titlepage.xhtml", buildTitlePage(meta));
      zip.file("OEBPS/nav.xhtml", buildNavDocument(meta, entries, labels));
      zip.file("OEBPS/toc.ncx", buildNcx(meta, entries));
      zip.file("OEBPS/content.opf", buildPackageDocument(meta, entries));
      for (const document of documents) {
        zip.file(`OEBPS/${document.href}`, document.xhtml);
      }

      const buffer = await zip.generateAsync({
        type: "nodebuffer",
        mimeType: "application/epub+zip",
        compression: "DEFLATE",
        compressionOptions: { level: 9 },
      });

      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, buffer);

      const wordCount = chapters.reduce(
        (sum, chapter) => sum + countWords(readChapterFile(chapter.filename)),
        0
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                message: "Manuscript exported to EPUB3.",
                outputPath: outPath,
                fileSizeBytes: buffer.length,
                chaptersIncluded: entries.length,
                wordCount,
                metadata: {
                  title: meta.title,
                  author: meta.author,
                  authorSource: profile?.name?.trim()
                    ? "author-profile.json"
                    : "registry.json",
                  language: meta.language,
                  identifier: meta.identifier,
                  identifierSource,
                  ...(meta.subtitle ? { subtitle: meta.subtitle } : {}),
                  ...(meta.series ? { series: meta.series } : {}),
                  modified: meta.modified,
                },
                tableOfContents: entries.map((e, i) => ({
                  order: i + 1,
                  title: e.title,
                  href: e.href,
                })),
                ...(warnings.length ? { warnings } : {}),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
