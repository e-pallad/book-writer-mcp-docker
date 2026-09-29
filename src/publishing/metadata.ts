// Checking the publishing metadata against what stores accept. The limits are
// KDP's, since that is where most of the books this server helps with end up;
// they are stated in each message so an author publishing elsewhere can judge.

import { ContributorRole, PublishingMetadata, Registry } from "../storage/schema";
import { isIsoDate } from "../utils/date";

export const LIMITS = {
  keywords: 7,
  keywordLength: 50,
  categories: 3,
  descriptionLength: 4000,
  titleAndSubtitleLength: 200,
};

export interface IsbnCheck {
  valid: boolean;
  /** Digits only (and a final X for ISBN-10). */
  normalized: string;
  kind: "isbn-10" | "isbn-13" | null;
}

/** Strips "urn:isbn:", "ISBN", spaces and hyphens, then checks the check digit. */
export function checkIsbn(value: string): IsbnCheck {
  const normalized = value
    .trim()
    .replace(/^urn:isbn:/i, "")
    .replace(/^isbn(?:-1[03])?:?/i, "")
    .replace(/[\s-]/g, "")
    .toUpperCase();

  if (/^\d{13}$/.test(normalized)) {
    const sum = [...normalized].reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
    return { valid: sum % 10 === 0, normalized, kind: "isbn-13" };
  }
  if (/^\d{9}[\dX]$/.test(normalized)) {
    const sum = [...normalized].reduce(
      (acc, d, i) => acc + (d === "X" ? 10 : Number(d)) * (10 - i),
      0
    );
    return { valid: sum % 11 === 0, normalized, kind: "isbn-10" };
  }
  return { valid: false, normalized, kind: null };
}

/** Problems that make the metadata unusable as it stands. */
export function validateMetadata(metadata: PublishingMetadata, title: string): string[] {
  const problems: string[] = [];

  const keywords = metadata.keywords ?? [];
  if (keywords.length > LIMITS.keywords) {
    problems.push(`${keywords.length} keywords; KDP takes ${LIMITS.keywords}.`);
  }
  for (const keyword of keywords) {
    if (keyword.length > LIMITS.keywordLength) {
      problems.push(`Keyword "${keyword}" is ${keyword.length} characters; KDP takes ${LIMITS.keywordLength} per keyword.`);
    }
  }
  const lowered = keywords.map((k) => k.toLowerCase());
  const repeated = lowered.filter((k, i) => lowered.indexOf(k) !== i);
  if (repeated.length) problems.push(`Keywords repeated: ${[...new Set(repeated)].join(", ")}.`);

  const categories = metadata.categories ?? [];
  if (categories.length > LIMITS.categories) {
    problems.push(`${categories.length} categories; KDP takes ${LIMITS.categories}.`);
  }

  if (metadata.description && metadata.description.length > LIMITS.descriptionLength) {
    problems.push(
      `The description is ${metadata.description.length} characters; KDP takes ${LIMITS.descriptionLength}.`
    );
  }

  const combined = title.length + (metadata.subtitle?.length ?? 0);
  if (combined > LIMITS.titleAndSubtitleLength) {
    problems.push(
      `Title and subtitle together are ${combined} characters; KDP takes ${LIMITS.titleAndSubtitleLength}.`
    );
  }

  for (const [edition, value] of Object.entries(metadata.isbn ?? {})) {
    if (!value) continue;
    const check = checkIsbn(value);
    if (!check.valid) {
      problems.push(
        check.kind
          ? `The ${edition} ISBN ${value} fails its check digit — probably a typo.`
          : `The ${edition} ISBN "${value}" is neither 10 nor 13 digits.`
      );
    }
  }
  const isbns = Object.values(metadata.isbn ?? {})
    .filter((v): v is string => Boolean(v))
    .map((v) => checkIsbn(v).normalized);
  if (new Set(isbns).size !== isbns.length) {
    problems.push("Two editions share one ISBN. Each edition needs its own.");
  }

  if (metadata.publicationDate && !isIsoDate(metadata.publicationDate)) {
    problems.push(`Publication date "${metadata.publicationDate}" is not a YYYY-MM-DD date.`);
  }
  if (metadata.series?.number !== undefined && !(metadata.series.number > 0)) {
    problems.push("A series number has to be positive.");
  }
  if (metadata.copyright?.year !== undefined && !Number.isInteger(metadata.copyright.year)) {
    problems.push("The copyright year has to be a whole year.");
  }

  return problems;
}

export interface MissingItem {
  field: string;
  why: string;
}

/** What is still missing before the book can go to a store. */
export function missingMetadata(metadata: PublishingMetadata | null): MissingItem[] {
  const missing: MissingItem[] = [];
  if (!metadata?.description) {
    missing.push({ field: "description", why: "The store page and the back cover need it." });
  }
  if (!metadata?.keywords?.length) {
    missing.push({ field: "keywords", why: "Readers find a book by them; KDP takes seven." });
  }
  if (!metadata?.categories?.length) {
    missing.push({ field: "categories", why: "Stores shelve a book by them; KDP takes three." });
  }
  return missing;
}

/** "© 2026 A. Autorin" — from the metadata, else the author and this year. */
export function rightsStatement(
  metadata: PublishingMetadata | null,
  registry: Registry,
  now = new Date()
): string {
  const holder = metadata?.copyright?.holder?.trim() || registry.author;
  const year =
    metadata?.copyright?.year ??
    (metadata?.publicationDate ? Number(metadata.publicationDate.slice(0, 4)) : now.getUTCFullYear());
  return `© ${year} ${holder}`;
}

/** MARC relator codes, which EPUB uses for a contributor's role. */
export const MARC_RELATORS: Record<ContributorRole, string> = {
  editor: "edt",
  translator: "trl",
  illustrator: "ill",
  cover_designer: "cov",
  foreword: "aui",
  other: "ctb",
};
