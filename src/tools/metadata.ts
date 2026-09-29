import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getCoverSpec, getMetadata, updateMetadata } from "../storage/filestore";
import { requireProject } from "../storage/chapters";
import { ContributorRole, PublishingMetadata } from "../storage/schema";
import { BookMCPError } from "../utils/errors";
import {
  checkIsbn,
  LIMITS,
  missingMetadata,
  rightsStatement,
  validateMetadata,
} from "../publishing/metadata";

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

const ROLES: [ContributorRole, ...ContributorRole[]] = [
  "editor",
  "translator",
  "illustrator",
  "cover_designer",
  "foreword",
  "other",
];

/** Everything a caller may learn about the metadata, beyond the fields. */
function report(metadata: PublishingMetadata | null) {
  const registry = requireProject();
  const spec = getCoverSpec();
  const notes: string[] = [];
  const blurb = spec?.backCover?.blurb;
  if (blurb && metadata?.description && blurb !== metadata.description) {
    notes.push(
      "The cover spec's back-cover blurb differs from the description here. The description is the one the exports use; re-run book_cover_create_spec without a blurb to take it over."
    );
  }
  return {
    title: registry.title,
    metadata: metadata ?? {},
    rights: rightsStatement(metadata, registry),
    problems: metadata ? validateMetadata(metadata, registry.title) : [],
    missing: missingMetadata(metadata),
    ...(notes.length ? { notes } : {}),
  };
}

export function registerMetadataTools(server: McpServer): void {
  server.tool(
    "book_metadata_set",
    `Set the book's publishing metadata: subtitle, series, description (the blurb — the one copy the cover spec and the exports use), keywords (KDP takes ${LIMITS.keywords}), categories (KDP takes ${LIMITS.categories}), an ISBN per edition, publisher, publication date, copyright and contributors. Every field is optional and replaces what was there; an empty string or list clears it. Values KDP would reject — an eighth keyword, an ISBN with a wrong check digit — are refused.`,
    {
      subtitle: z.string().optional().describe("Subtitle"),
      seriesName: z.string().optional().describe('Series the book belongs to ("" removes the series)'),
      seriesNumber: z.number().optional().describe("Position in the series"),
      description: z
        .string()
        .optional()
        .describe(`The book's description / back-cover blurb (up to ${LIMITS.descriptionLength} characters)`),
      keywords: z.array(z.string()).optional().describe(`Search keywords or phrases, up to ${LIMITS.keywords}`),
      categories: z
        .array(z.string())
        .optional()
        .describe(`Store categories or BISAC/Thema codes, up to ${LIMITS.categories}`),
      isbnEbook: z.string().optional().describe("ISBN of the e-book edition"),
      isbnPaperback: z.string().optional().describe("ISBN of the paperback"),
      isbnHardcover: z.string().optional().describe("ISBN of the hardcover"),
      publisher: z.string().optional().describe("Publisher or imprint"),
      publicationDate: z.string().optional().describe("Publication date, YYYY-MM-DD"),
      copyrightHolder: z.string().optional().describe("Copyright holder (default: the author)"),
      copyrightYear: z.number().optional().describe("Copyright year (default: the publication year)"),
      contributors: z
        .array(z.object({ name: z.string(), role: z.enum(ROLES) }))
        .optional()
        .describe("Editors, translators, illustrators, cover designers"),
    },
    async (input) => {
      if (Object.values(input).every((v) => v === undefined)) {
        throw new BookMCPError("Nothing to set: pass at least one field.");
      }
      const registry = requireProject();

      const metadata = await updateMetadata((m) => {
        const text = (value: string | undefined, apply: (v: string | undefined) => void) => {
          if (value !== undefined) apply(value.trim() || undefined);
        };
        const list = (value: string[] | undefined, apply: (v: string[] | undefined) => void) => {
          if (value !== undefined) {
            const cleaned = value.map((v) => v.trim()).filter(Boolean);
            apply(cleaned.length ? cleaned : undefined);
          }
        };

        text(input.subtitle, (v) => (m.subtitle = v));
        text(input.description, (v) => (m.description = v));
        text(input.publisher, (v) => (m.publisher = v));
        text(input.publicationDate, (v) => (m.publicationDate = v));
        list(input.keywords, (v) => (m.keywords = v));
        list(input.categories, (v) => (m.categories = v));

        if (input.seriesName !== undefined) {
          m.series = input.seriesName.trim()
            ? { name: input.seriesName.trim(), ...(m.series?.number ? { number: m.series.number } : {}) }
            : undefined;
        }
        if (input.seriesNumber !== undefined) {
          if (!m.series) throw new BookMCPError("Name the series (seriesName) before giving a number.");
          m.series.number = input.seriesNumber;
        }

        const isbn = { ...(m.isbn ?? {}) };
        const setIsbn = (edition: "ebook" | "paperback" | "hardcover", value: string | undefined) => {
          if (value === undefined) return;
          if (!value.trim()) delete isbn[edition];
          else isbn[edition] = checkIsbn(value).normalized;
        };
        setIsbn("ebook", input.isbnEbook);
        setIsbn("paperback", input.isbnPaperback);
        setIsbn("hardcover", input.isbnHardcover);
        m.isbn = Object.keys(isbn).length ? isbn : undefined;

        if (input.copyrightHolder !== undefined || input.copyrightYear !== undefined) {
          const copyright = { ...(m.copyright ?? {}) };
          if (input.copyrightHolder !== undefined) {
            copyright.holder = input.copyrightHolder.trim() || undefined;
          }
          if (input.copyrightYear !== undefined) copyright.year = input.copyrightYear;
          m.copyright = copyright.holder || copyright.year ? copyright : undefined;
        }
        if (input.contributors !== undefined) {
          const contributors = input.contributors
            .map((c) => ({ name: c.name.trim(), role: c.role }))
            .filter((c) => c.name);
          m.contributors = contributors.length ? contributors : undefined;
        }

        // Refused as a whole: a half-applied change would leave the file in a
        // state nobody asked for.
        const problems = validateMetadata(m, registry.title);
        if (problems.length) {
          throw new BookMCPError(`Metadata not saved:\n- ${problems.join("\n- ")}`);
        }
      });

      return jsonResult({ message: "Metadata saved.", ...report(metadata) });
    }
  );

  server.tool(
    "book_metadata_get",
    "The book's publishing metadata, the copyright line it produces, anything a store would reject, and what is still missing before publishing.",
    {},
    async () => jsonResult(report(getMetadata()))
  );
}
