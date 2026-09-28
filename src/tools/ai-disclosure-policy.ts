// Amazon's AI content policy, kept in one dated block.
//
// The requirement this file exists to serve is "do not hardcode stale
// wording". Wording cannot be fetched at run time — the server has no network
// egress by design, and a compliance answer that silently fails to a cached
// copy is worse than one that admits its age. So instead: every statement here
// carries the date it was verified and the page it came from, and every tool
// response repeats both, so the author always knows how old this is and where
// to confirm it.
//
// Re-verify against SOURCE_URL and bump POLICY_VERIFIED_ON when it changes.

export const POLICY_SOURCE_URL =
  "https://kdp.amazon.com/en_US/help/topic/G200672390";
export const POLICY_VERIFIED_ON = "2026-09-24";
export const POLICY_VERSION = "kdp-content-guidelines-ai";

export type AiUse = "none" | "ai_generated" | "ai_assisted";
export type ContentType = "text" | "images" | "translations";

export const CONTENT_TYPES: ContentType[] = ["text", "images", "translations"];

export const CONTENT_TYPE_LABELS: Record<ContentType, string> = {
  text: "Text",
  images: "Images (cover and interior artwork)",
  translations: "Translations",
};

/**
 * The distinction the whole policy turns on: who created the content, not how
 * much it was edited afterwards.
 */
export const DEFINITIONS: Record<Exclude<AiUse, "none">, string> = {
  ai_generated:
    "Content an AI-based tool created — text, images or translations produced from your prompts. Editing it afterwards, however heavily, does not change the classification: if the tool produced the content, it is AI-generated.",
  ai_assisted:
    "Content you created, where AI was only used to brainstorm, outline, edit, refine or error-check. If you wrote or made it and AI helped you improve it, it is AI-assisted.",
};

export const DISCLOSURE_RULE = {
  generated:
    "AI-generated content must be declared to Amazon when you publish a new book, and again whenever you edit and republish an existing one.",
  assisted:
    "AI-assisted content does not have to be declared. Amazon asks only about AI-generated content.",
  where:
    "The declaration is made in the KDP publishing form, in the AI content section, separately for text, images and translations. It does not go inside the book.",
  visibility:
    "What you declare is for Amazon's internal use. It is not shown on the product page, and Amazon states it does not affect royalties or search ranking.",
  risk:
    "Failing to declare AI-generated content breaches the KDP terms and can mean a blocked title or a suspended account.",
};

export function requiresDisclosure(uses: Record<ContentType, AiUse>): boolean {
  return CONTENT_TYPES.some((type) => uses[type] === "ai_generated");
}

/** What to select in the KDP form for one content type. */
export function kdpAnswerFor(type: ContentType, use: AiUse): string {
  const label = CONTENT_TYPE_LABELS[type];
  switch (use) {
    case "ai_generated":
      return `${label}: answer YES — this book contains AI-generated ${type}.`;
    case "ai_assisted":
      return `${label}: answer NO — AI-assisted ${type} is not AI-generated and is not declared.`;
    case "none":
      return `${label}: answer NO — no AI was involved.`;
  }
}

/**
 * Optional front matter for an author who wants to tell readers, which is a
 * separate question from what Amazon requires. Deliberately plain, and clearly
 * not presented as a KDP obligation.
 */

// "images" is plural, "text" and "translation" are not, so the verb has to
// follow the noun rather than the number of content types selected.
const NOUNS: Record<ContentType, { noun: string; plural: boolean }> = {
  text: { noun: "text", plural: false },
  images: { noun: "images", plural: true },
  translations: { noun: "translation", plural: false },
};

function phraseFor(types: ContentType[]): { phrase: string; plural: boolean } {
  const parts = types.map((type) => NOUNS[type]);
  const phrase = parts
    .map((part) => part.noun)
    .reduce((acc, noun, index) =>
      index === 0
        ? noun
        : index === parts.length - 1
        ? `${acc} and ${noun}`
        : `${acc}, ${noun}`
    );
  return { phrase, plural: parts.length > 1 || parts.some((p) => p.plural) };
}

export function readerFacingNote(
  uses: Record<ContentType, AiUse>,
  authorName: string
): string | null {
  const generated = CONTENT_TYPES.filter((t) => uses[t] === "ai_generated");
  const assisted = CONTENT_TYPES.filter((t) => uses[t] === "ai_assisted");
  if (generated.length === 0 && assisted.length === 0) return null;

  const sentences: string[] = [];

  if (generated.length) {
    const { phrase, plural } = phraseFor(generated);
    sentences.push(
      `The ${phrase} in this book ${
        plural ? "were" : "was"
      } generated with the assistance of artificial intelligence and reviewed by ${authorName}.`
    );
  }

  if (assisted.length) {
    const { phrase, plural } = phraseFor(assisted);
    sentences.push(
      `The ${phrase} ${
        plural ? "were" : "was"
      } created by ${authorName}, with AI-based tools used for editing and refinement.`
    );
  }

  return sentences.join(" ");
}
