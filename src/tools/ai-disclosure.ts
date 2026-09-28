import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getAiDisclosure,
  getAuthorProfile,
  getRegistry,
  writeAiDisclosure,
} from "../storage/filestore";
import { AiDisclosure } from "../storage/schema";
import {
  AiUse,
  CONTENT_TYPES,
  CONTENT_TYPE_LABELS,
  DEFINITIONS,
  DISCLOSURE_RULE,
  POLICY_SOURCE_URL,
  POLICY_VERIFIED_ON,
  POLICY_VERSION,
  kdpAnswerFor,
  readerFacingNote,
  requiresDisclosure,
} from "./ai-disclosure-policy";

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

// Offered as three explicit choices rather than free text. Which side of the
// line a book falls on is a compliance decision, and guessing it from a phrase
// like "AI-assisted drafting" is exactly the wrong place to be clever: the
// same phrase is used by authors who mean an AI wrote the draft and by authors
// who mean it fixed their commas.
const useSchema = z
  .enum(["none", "ai_generated", "ai_assisted"])
  .describe(
    'How this was produced. "ai_generated": an AI tool created it from your prompts — still AI-generated however heavily you edited it afterwards. "ai_assisted": you created it and AI only brainstormed, outlined, edited, refined or error-checked. "none": no AI involved.'
  );

export function registerAiDisclosureTools(server: McpServer): void {
  server.tool(
    "book_ai_disclosure_generate",
    [
      "Work out what you must declare to Amazon KDP about AI use in this book, and record it against the project.",
      "",
      "Amazon distinguishes AI-GENERATED content — text, images or translations an AI tool created from your prompts — from AI-ASSISTED content, which you created and AI only helped you refine. Editing AI-generated content, however heavily, does not make it AI-assisted; what matters is which of you produced it.",
      "Only AI-generated content must be declared, separately for text, images and translations, in the KDP publishing form when you publish a new book and again whenever you edit and republish. AI-assisted content is not declared at all. The declaration is for Amazon's internal use and does not appear in the book or on the product page.",
      "",
      `Checked against ${POLICY_SOURCE_URL} on ${POLICY_VERIFIED_ON}. Amazon can change this; every response repeats that date so you can confirm the page still says the same before you publish.`,
    ].join("\n"),
    {
      text: useSchema.describe(
        'How the book\'s prose was produced. "ai_generated" if an AI tool drafted it, even if you rewrote it heavily afterwards.'
      ),
      images: useSchema
        .optional()
        .default("none")
        .describe(
          "How the cover and any interior artwork were produced. Amazon asks about cover and interior images together."
        ),
      translations: useSchema
        .optional()
        .default("none")
        .describe("How any translation of this book was produced."),
      notes: z
        .string()
        .optional()
        .default("")
        .describe(
          "Your own record of which tools were used and how — kept with the project, never sent anywhere."
        ),
      authorName: z
        .string()
        .optional()
        .describe(
          "Name for the optional reader-facing note (defaults to the author profile, then the project author)."
        ),
    },
    async ({ text, images, translations, notes, authorName }) => {
      const uses: Record<"text" | "images" | "translations", AiUse> = {
        text,
        images,
        translations,
      };
      const required = requiresDisclosure(uses);

      const registry = getRegistry();
      const profile = getAuthorProfile();
      const name =
        authorName?.trim() || profile?.name?.trim() || registry?.author || "the author";

      const disclosure: AiDisclosure = {
        text,
        images,
        translations,
        notes,
        disclosureRequired: required,
        recordedAt: new Date().toISOString(),
        policyVersion: POLICY_VERSION,
        policyVerifiedOn: POLICY_VERIFIED_ON,
      };
      await writeAiDisclosure(disclosure);

      const generated = CONTENT_TYPES.filter((t) => uses[t] === "ai_generated");
      const assisted = CONTENT_TYPES.filter((t) => uses[t] === "ai_assisted");

      return jsonResult({
        message: required
          ? `This book has AI-generated ${generated
              .map((t) => t)
              .join(" and ")}, which must be declared to KDP.`
          : "Nothing here has to be declared to KDP.",
        disclosureRequired: required,
        classification: CONTENT_TYPES.map((type) => ({
          contentType: type,
          label: CONTENT_TYPE_LABELS[type],
          use: uses[type],
          mustDeclare: uses[type] === "ai_generated",
          definition:
            uses[type] === "none" ? "No AI was involved." : DEFINITIONS[uses[type] as Exclude<AiUse, "none">],
        })),
        whatToDoInKdp: {
          steps: CONTENT_TYPES.map((type) => kdpAnswerFor(type, uses[type])),
          where: DISCLOSURE_RULE.where,
          when: DISCLOSURE_RULE.generated,
          visibility: DISCLOSURE_RULE.visibility,
          ...(assisted.length ? { note: DISCLOSURE_RULE.assisted } : {}),
          ...(required ? { risk: DISCLOSURE_RULE.risk } : {}),
        },
        // Separate from the KDP obligation on purpose: Amazon does not want
        // this in the book, but some authors want to tell readers anyway, and
        // other retailers and jurisdictions ask for different things.
        optionalReaderFacingNote: {
          required: false,
          explanation:
            "Amazon does not ask for a disclosure inside the book, and adding one is not part of KDP compliance. This is here only if you want to tell readers, or if another retailer or jurisdiction asks for it.",
          text: readerFacingNote(uses, name),
        },
        policy: {
          source: POLICY_SOURCE_URL,
          verifiedOn: POLICY_VERIFIED_ON,
          caveat:
            "Amazon updates this policy without notice. Confirm the page above still matches before you publish, rather than relying on this date.",
        },
        recordedAt: disclosure.recordedAt,
      });
    }
  );

  server.tool(
    "book_ai_disclosure_get",
    "Retrieve the AI content disclosure recorded for this project, if any.",
    {},
    async () => {
      const disclosure = getAiDisclosure();
      if (!disclosure) {
        return jsonResult({
          recorded: false,
          message:
            "No AI disclosure has been recorded for this project. Run book_ai_disclosure_generate to work out what KDP needs and record it.",
          policy: { source: POLICY_SOURCE_URL, verifiedOn: POLICY_VERIFIED_ON },
        });
      }

      const stale = disclosure.policyVerifiedOn !== POLICY_VERIFIED_ON;
      return jsonResult({
        recorded: true,
        disclosure,
        policy: {
          source: POLICY_SOURCE_URL,
          verifiedOn: POLICY_VERIFIED_ON,
          ...(stale
            ? {
                warning: `This was recorded against the policy as read on ${disclosure.policyVerifiedOn}, but the server now carries a reading from ${POLICY_VERIFIED_ON}. Re-run book_ai_disclosure_generate to refresh it.`,
              }
            : {}),
        },
      });
    }
  );
}
