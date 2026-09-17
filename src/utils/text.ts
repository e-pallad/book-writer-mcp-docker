// Helpers for handling text that is not plain ASCII. Umlauts, accents and
// other non-ASCII letters reach every text field of a book project, so the
// rules here are applied wherever text is stored, compared or matched.

// The same visible character can be stored in more than one way: "ö" is a
// single code point on Linux/Windows but "o" + a combining diaeresis on macOS.
// Everything is folded to NFC on the way in so the two spellings compare equal.
export function toNFC(value: string): string {
  return value.normalize("NFC");
}

// Case-insensitive comparison that also ignores the composition difference
// above. Use this instead of a bare toLowerCase() for any user-supplied name.
export function normalizeForCompare(value: string): string {
  return toNFC(value).toLowerCase();
}

// Letters that carry no diacritic to strip, so NFKD alone would drop them.
const TRANSLITERATIONS: Record<string, string> = {
  ß: "ss",
  æ: "ae",
  Æ: "ae",
  œ: "oe",
  Œ: "oe",
  ø: "o",
  Ø: "o",
  đ: "d",
  Đ: "d",
  ð: "d",
  Ð: "d",
  ł: "l",
  Ł: "l",
  þ: "th",
  Þ: "th",
  ı: "i",
};

// Builds an ASCII file-name fragment: "Über Öl und Käse" -> "uber-ol-und-kase".
// Returns "" when a title has no ASCII-representable letters at all (e.g. one
// written entirely in Cyrillic or Japanese); callers fall back to the chapter
// id so two such titles cannot collide on one filename.
export function slugify(value: string): string {
  return toNFC(value)
    .replace(/[ßæÆœŒøØđĐðÐłŁþÞı]/g, (char) => TRANSLITERATIONS[char] ?? char)
    .normalize("NFKD") // splits "ä" into "a" + combining diaeresis
    .replace(/[̀-ͯ]/g, "") // drops the diacritic, keeps the letter
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A word character for boundary purposes, Unicode-aware: JavaScript's \b only
// knows [A-Za-z0-9_], so /\bÜbertreibung\b/ never matches — "Ü" is not a word
// character to \b, so no boundary exists between it and the preceding space.
const WORD_CHAR = "[\\p{L}\\p{N}_]";

// Matches `term` as a whole word, including terms that start or end with a
// non-ASCII letter.
export function wholeWordRegExp(term: string, flags = "giu"): RegExp {
  return new RegExp(
    `(?<!${WORD_CHAR})${escapeRegExp(toNFC(term))}(?!${WORD_CHAR})`,
    flags
  );
}

// Capitalized words, Unicode-aware: /[A-Z][a-z]{2,}/ skips "Jörg" and "Émile"
// because the accented letters fall outside the ASCII ranges.
export const CAPITALIZED_WORD_PATTERN = /\p{Lu}[\p{Ll}\p{M}]{2,}/gu;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  auml: "ä",
  ouml: "ö",
  uuml: "ü",
  Auml: "Ä",
  Ouml: "Ö",
  Uuml: "Ü",
  szlig: "ß",
  agrave: "à",
  aacute: "á",
  acirc: "â",
  atilde: "ã",
  aring: "å",
  ccedil: "ç",
  egrave: "è",
  eacute: "é",
  ecirc: "ê",
  euml: "ë",
  igrave: "ì",
  iacute: "í",
  icirc: "î",
  iuml: "ï",
  ntilde: "ñ",
  ograve: "ò",
  oacute: "ó",
  ocirc: "ô",
  otilde: "õ",
  oslash: "ø",
  ugrave: "ù",
  uacute: "ú",
  ucirc: "û",
  yacute: "ý",
  Agrave: "À",
  Aacute: "Á",
  Acirc: "Â",
  Atilde: "Ã",
  Aring: "Å",
  Ccedil: "Ç",
  Egrave: "È",
  Eacute: "É",
  Ecirc: "Ê",
  Euml: "Ë",
  Ntilde: "Ñ",
  Ograve: "Ò",
  Oacute: "Ó",
  Ocirc: "Ô",
  Otilde: "Õ",
  Oslash: "Ø",
  Ugrave: "Ù",
  Uacute: "Ú",
  Ucirc: "Û",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  bdquo: "„",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  euro: "€",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
};

// Text scraped out of HTML attributes arrives entity-encoded, so a profile
// would otherwise be stored as "Gesch&auml;ftsf&uuml;hrer".
export function decodeHtmlEntities(value: string): string {
  return toNFC(
    value
      .replace(/&#x([0-9a-f]+);/gi, (_match, hex) =>
        String.fromCodePoint(parseInt(hex, 16))
      )
      .replace(/&#(\d+);/g, (_match, dec) =>
        String.fromCodePoint(parseInt(dec, 10))
      )
      .replace(/&([a-z]+);/gi, (match, name) => NAMED_ENTITIES[name] ?? match)
  );
}
