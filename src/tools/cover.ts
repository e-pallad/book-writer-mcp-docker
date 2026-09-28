import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as fs from "fs";
import * as path from "path";
import {
  getCoverSpec,
  writeCoverSpec,
  getRegistry,
  getAiDisclosure,
} from "../storage/filestore";
import { POLICY_SOURCE_URL } from "./ai-disclosure-policy";
import { BookMCPError } from "../utils/errors";

// Kindle Direct Publishing (KDP) cover specifications
// Source: https://kdp.amazon.com/en_US/help/topic/G200645690
const KDP_SPECS = {
  kindle: {
    widthInches: 6,
    heightInches: 9,
    dpi: 300,
    widthPixels: 1800,
    heightPixels: 2700,
    bleedInches: 0,
    minWidthPixels: 625,
    minHeightPixels: 1000,
    maxWidthPixels: 10000,
    maxHeightPixels: 10000,
    idealRatio: 1.6,
    maxFileSizeMB: 50,
    formats: ["JPEG", "TIFF"],
    colorSpace: "sRGB",
  },
  paperback: {
    widthInches: 6,
    heightInches: 9,
    dpi: 300,
    widthPixels: 1800,
    heightPixels: 2700,
    bleedInches: 0.125,
    minSpineWidth: 0.06, // 24 pages minimum
    formats: ["PDF"],
    colorSpace: "sRGB or CMYK",
    trimSizes: [
      "5 x 8", "5.06 x 7.81", "5.25 x 8", "5.5 x 8.5",
      "6 x 9", "6.14 x 9.21", "6.69 x 9.61",
      "7 x 10", "7.44 x 9.69", "7.5 x 9.25",
      "8 x 10", "8.25 x 6", "8.25 x 8.25",
      "8.5 x 8.5", "8.5 x 11",
    ],
  },
  hardcover: {
    widthInches: 6.14,
    heightInches: 9.21,
    dpi: 300,
    widthPixels: 1842,
    heightPixels: 2763,
    bleedInches: 0.125,
    wrapInches: 0.59, // cover wrap for case laminate
    formats: ["PDF"],
    colorSpace: "sRGB or CMYK",
    trimSizes: [
      "5.5 x 8.5", "6 x 9", "6.14 x 9.21",
      "6.69 x 9.61", "7 x 10", "7.44 x 9.69",
      "8.25 x 11", "8.5 x 11",
    ],
  },
};

function calculateSpineWidth(pageCount: number, paperType: "white" | "cream" = "white"): number {
  // KDP spine width formula
  const pagesPerInch = paperType === "white" ? 0.002252 : 0.0025;
  return pageCount * pagesPerInch;
}

function estimatePageCount(wordCount: number): number {
  // ~250 words per page for standard fiction formatting
  return Math.ceil(wordCount / 250);
}

export function registerCoverTools(server: McpServer): void {
  // book_cover_kdp_specs
  server.tool(
    "book_cover_kdp_specs",
    "Get Kindle Direct Publishing cover specifications for ebook, paperback, or hardcover. Returns dimensions, DPI, bleed, file format requirements, and trim sizes.",
    {
      format: z
        .enum(["kindle", "paperback", "hardcover", "all"])
        .describe("Publishing format to get specs for"),
      pageCount: z
        .number()
        .optional()
        .describe("Page count for spine width calculation (paperback/hardcover)"),
      trimSize: z
        .string()
        .optional()
        .describe("Trim size for paperback/hardcover (e.g. '6 x 9')"),
    },
    async ({ format, pageCount, trimSize }) => {
      const registry = getRegistry();
      const estimatedPages = pageCount || (registry
        ? estimatePageCount(registry.chapters.reduce((sum, c) => sum + c.wordCount, 0))
        : 200);

      const spineWidth = calculateSpineWidth(estimatedPages);

      const result: Record<string, unknown> = {};

      if (format === "all" || format === "kindle") {
        result.kindle = {
          ...KDP_SPECS.kindle,
          notes: "eBook cover is front only. No spine or back cover needed.",
        };
      }

      if (format === "all" || format === "paperback") {
        const spec = KDP_SPECS.paperback;
        const [w, h] = (trimSize || "6 x 9").split(" x ").map(Number);
        const fullWidth = w + spineWidth + w + spec.bleedInches * 2;
        const fullHeight = h + spec.bleedInches * 2;
        result.paperback = {
          ...spec,
          trimSize: trimSize || "6 x 9",
          estimatedPageCount: estimatedPages,
          spineWidthInches: Math.round(spineWidth * 1000) / 1000,
          fullCoverWidthInches: Math.round(fullWidth * 1000) / 1000,
          fullCoverHeightInches: Math.round(fullHeight * 1000) / 1000,
          fullCoverWidthPixels: Math.round(fullWidth * spec.dpi),
          fullCoverHeightPixels: Math.round(fullHeight * spec.dpi),
          notes: "Full cover = back cover + spine + front cover + bleed on all edges.",
        };
      }

      if (format === "all" || format === "hardcover") {
        const spec = KDP_SPECS.hardcover;
        const [w, h] = (trimSize || "6.14 x 9.21").split(" x ").map(Number);
        const fullWidth = w + spineWidth + w + spec.bleedInches * 2 + spec.wrapInches * 2;
        const fullHeight = h + spec.bleedInches * 2 + spec.wrapInches * 2;
        result.hardcover = {
          ...spec,
          trimSize: trimSize || "6.14 x 9.21",
          estimatedPageCount: estimatedPages,
          spineWidthInches: Math.round(spineWidth * 1000) / 1000,
          fullCoverWidthInches: Math.round(fullWidth * 1000) / 1000,
          fullCoverHeightInches: Math.round(fullHeight * 1000) / 1000,
          fullCoverWidthPixels: Math.round(fullWidth * spec.dpi),
          fullCoverHeightPixels: Math.round(fullHeight * spec.dpi),
          notes: "Hardcover includes wrap area for case laminate binding.",
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // book_cover_create_spec
  server.tool(
    "book_cover_create_spec",
    "Create a cover design specification for your book. Captures mood, colors, typography, imagery direction, and generates a design brief suitable for AI image generation or a human designer. Includes KDP-compliant dimensions.",
    {
      targetPlatform: z
        .enum(["kindle", "paperback", "hardcover", "all"])
        .default("all")
        .describe("Target publishing platform"),
      mood: z.string().describe("Overall mood/feeling (e.g. 'dark and brooding', 'whimsical and light', 'epic and sweeping')"),
      colorPalette: z
        .array(z.string())
        .describe("Color palette (e.g. ['deep navy', 'gold accents', 'muted cream'])"),
      typography: z
        .object({
          titleFont: z.string().describe("Title font style (e.g. 'bold serif', 'hand-lettered', 'modern sans-serif')"),
          subtitleFont: z.string().optional().describe("Subtitle font style"),
          authorFont: z.string().describe("Author name font style"),
        })
        .describe("Typography direction"),
      imagery: z
        .string()
        .describe("Visual imagery direction (e.g. 'silhouette of a figure in fog', 'abstract geometric patterns', 'photographic landscape')"),
      style: z
        .string()
        .describe("Design style (e.g. 'minimalist', 'illustrated', 'photographic', 'typographic', 'mixed media')"),
      subtitle: z.string().optional().describe("Book subtitle"),
      referenceCovers: z
        .array(z.string())
        .optional()
        .default([])
        .describe("Reference book covers for inspiration (e.g. ['The Great Gatsby - Scribner edition', 'Project Hail Mary'])"),
      blurb: z.string().optional().describe("Back cover blurb (for paperback/hardcover)"),
      authorBio: z.string().optional().default("").describe("Author bio for back cover"),
      testimonials: z
        .array(z.string())
        .optional()
        .default([])
        .describe("Testimonial quotes for back cover"),
    },
    async (input) => {
      const registry = getRegistry();
      if (!registry)
        throw new BookMCPError("No book project found. Run book_init first.");

      const totalWords = registry.chapters.reduce((sum, c) => sum + c.wordCount, 0);
      const pageCount = estimatePageCount(totalWords);
      const spineWidth = calculateSpineWidth(pageCount);

      const platform = input.targetPlatform;
      const baseSpec = platform === "hardcover"
        ? KDP_SPECS.hardcover
        : platform === "paperback"
          ? KDP_SPECS.paperback
          : KDP_SPECS.kindle;

      const spec = {
        title: registry.title,
        subtitle: input.subtitle,
        authorName: registry.author,
        genre: registry.genre,
        targetPlatform: input.targetPlatform,
        dimensions: {
          widthInches: baseSpec.widthInches,
          heightInches: baseSpec.heightInches,
          dpi: baseSpec.dpi,
          widthPixels: baseSpec.widthPixels,
          heightPixels: baseSpec.heightPixels,
          bleedInches: baseSpec.bleedInches,
        },
        design: {
          mood: input.mood,
          colorPalette: input.colorPalette,
          typography: input.typography,
          imagery: input.imagery,
          style: input.style,
          referenceCovers: input.referenceCovers,
        },
        backCover: (input.targetPlatform !== "kindle" && input.blurb)
          ? {
              blurb: input.blurb,
              authorBio: input.authorBio || "",
              barcodePlacement: "bottom-right" as const,
              testimonials: input.testimonials,
            }
          : undefined,
        spine: input.targetPlatform !== "kindle"
          ? {
              text: `${registry.title}  |  ${registry.author}`,
              widthInches: spineWidth,
            }
          : undefined,
      };

      await writeCoverSpec(spec);

      // Generate an AI image generation prompt
      const aiPrompt = generateCoverPrompt(spec, registry.genre);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                message: "Cover specification created and saved.",
                spec,
                estimatedPageCount: pageCount,
                spineWidthInches: Math.round(spineWidth * 1000) / 1000,
                aiImagePrompt: aiPrompt,
                designBrief: generateDesignBrief(spec),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // book_cover_get_spec
  server.tool(
    "book_cover_get_spec",
    "Retrieve the current cover design specification",
    {},
    async () => {
      const spec = getCoverSpec();
      if (!spec)
        throw new BookMCPError("No cover spec found. Use book_cover_create_spec first.");

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(spec, null, 2) },
        ],
      };
    }
  );

  // book_cover_generate_prompt
  server.tool(
    "book_cover_generate_prompt",
    "Generate an AI image generation prompt from the cover spec, optimized for tools like DALL-E, Midjourney, or Stable Diffusion",
    {
      tool: z
        .enum(["dalle", "midjourney", "stable-diffusion", "generic"])
        .default("generic")
        .describe("Target AI image tool"),
      variant: z
        .enum(["front-cover", "full-wrap", "ebook-only"])
        .default("front-cover")
        .describe("Which cover variant to generate"),
    },
    async ({ tool, variant }) => {
      const spec = getCoverSpec();
      if (!spec)
        throw new BookMCPError("No cover spec found. Use book_cover_create_spec first.");

      let prompt = "";

      const baseDescription = [
        `Book cover for "${spec.title}" by ${spec.authorName}.`,
        `Genre: ${spec.genre}.`,
        `Mood: ${spec.design.mood}.`,
        `Style: ${spec.design.style}.`,
        `Colors: ${spec.design.colorPalette.join(", ")}.`,
        `Imagery: ${spec.design.imagery}.`,
        `Typography: bold ${spec.design.typography.titleFont} title.`,
      ].join(" ");

      if (tool === "midjourney") {
        prompt = `${baseDescription} --ar 2:3 --style raw --v 6`;
        if (variant === "full-wrap") {
          prompt = `Full book cover wrap design, front and back with spine. ${baseDescription} --ar 3:2 --style raw --v 6`;
        }
      } else if (tool === "dalle") {
        prompt = `Professional ${spec.design.style} book cover design. ${baseDescription} High resolution, print quality. Do not include any text on the cover.`;
      } else if (tool === "stable-diffusion") {
        prompt = `(masterpiece, best quality, professional book cover design:1.3), ${spec.design.style} style, ${spec.design.mood} mood, ${spec.design.imagery}, color palette: ${spec.design.colorPalette.join(", ")}, ${spec.genre} genre, print quality, 300dpi`;
      } else {
        prompt = baseDescription;
      }

      const dimensions = variant === "full-wrap" && spec.spine
        ? {
            note: "Full wrap includes back cover + spine + front cover",
            spineWidth: spec.spine.widthInches,
            totalWidth: spec.dimensions.widthInches * 2 + (spec.spine?.widthInches || 0) + spec.dimensions.bleedInches * 2,
            totalHeight: spec.dimensions.heightInches + spec.dimensions.bleedInches * 2,
          }
        : {
            width: spec.dimensions.widthPixels,
            height: spec.dimensions.heightPixels,
            dpi: spec.dimensions.dpi,
          };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                tool,
                variant,
                prompt,
                dimensions,
                notes: [
                  "Generate the image WITHOUT text — add title/author text in a design tool afterward.",
                  "Ensure the focal point is in the upper 2/3 of the image (title placement area).",
                  spec.design.referenceCovers?.length
                    ? `Reference covers for style inspiration: ${spec.design.referenceCovers.join(", ")}`
                    : null,
                ].filter(Boolean),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // book_cover_checklist
  server.tool(
    "book_cover_checklist",
    "Get a KDP publishing readiness checklist for your cover files",
    {
      format: z
        .enum(["kindle", "paperback", "hardcover"])
        .describe("Publishing format to check"),
    },
    async ({ format }) => {
      const spec = getCoverSpec();
      const registry = getRegistry();

      const checklist: { item: string; status: "ready" | "needed" | "optional"; details: string }[] = [];

      // Common checks
      checklist.push({
        item: "Cover spec created",
        status: spec ? "ready" : "needed",
        details: spec ? "Cover design spec on file" : "Run book_cover_create_spec first",
      });

      checklist.push({
        item: "Book title finalized",
        status: registry?.title ? "ready" : "needed",
        details: registry?.title || "Set via book_init",
      });

      checklist.push({
        item: "Author name set",
        status: registry?.author ? "ready" : "needed",
        details: registry?.author || "Set via book_init",
      });

      // KDP asks about AI-generated content at publishing time, for the cover
      // artwork as much as the prose, so it belongs on the readiness list.
      const aiDisclosure = getAiDisclosure();
      if (!aiDisclosure) {
        checklist.push({
          item: "AI content disclosure",
          status: "needed",
          details: `Not yet worked out for this project. KDP asks you to declare AI-generated text, images and translations when you publish — cover art included. Run book_ai_disclosure_generate. Policy: ${POLICY_SOURCE_URL}`,
        });
      } else if (aiDisclosure.disclosureRequired) {
        const generated = (["text", "images", "translations"] as const).filter(
          (type) => aiDisclosure[type] === "ai_generated"
        );
        checklist.push({
          item: "AI content disclosure",
          status: "ready",
          details: `Recorded: declare AI-generated ${generated.join(
            " and "
          )} in the KDP publishing form. Re-declare whenever you edit and republish.`,
        });
      } else {
        checklist.push({
          item: "AI content disclosure",
          status: "ready",
          details:
            "Recorded: nothing here counts as AI-generated, so there is nothing to declare to KDP.",
        });
      }

      if (format === "kindle") {
        checklist.push(
          {
            item: "Front cover image",
            status: "needed",
            details: `Required: JPEG or TIFF, minimum 625x1000px, ideal 1800x2700px (${KDP_SPECS.kindle.dpi} DPI), max 50MB, sRGB color space`,
          },
          {
            item: "Height:Width ratio",
            status: "needed",
            details: "Ideal ratio 1.6:1 (e.g. 1800x2700)",
          },
          {
            item: "No bleed required",
            status: "ready",
            details: "eBook covers don't need bleed area",
          }
        );
      }

      if (format === "paperback") {
        const pages = registry
          ? estimatePageCount(registry.chapters.reduce((s, c) => s + c.wordCount, 0))
          : 0;
        const spine = calculateSpineWidth(pages);

        checklist.push(
          {
            item: "Full cover PDF",
            status: "needed",
            details: `Required: single PDF with back + spine (${Math.round(spine * 1000) / 1000}") + front, 300 DPI, 0.125" bleed on all edges`,
          },
          {
            item: "ISBN barcode",
            status: "needed",
            details: "KDP provides free ISBN or use your own. Barcode auto-placed on back cover.",
          },
          {
            item: "Spine text",
            status: pages >= 100 ? "ready" : "optional",
            details: pages >= 100
              ? `${pages} pages — spine wide enough for text`
              : `${pages} pages — spine may be too narrow for text (need ~100+ pages)`,
          },
          {
            item: "Back cover blurb",
            status: spec?.backCover?.blurb ? "ready" : "needed",
            details: "Synopsis/hook text for back cover",
          }
        );
      }

      if (format === "hardcover") {
        checklist.push(
          {
            item: "Full cover PDF with wrap",
            status: "needed",
            details: `Required: PDF with 0.59" wrap area on all edges for case laminate, 300 DPI, 0.125" bleed`,
          },
          {
            item: "ISBN barcode",
            status: "needed",
            details: "Required for hardcover distribution",
          },
          {
            item: "Back cover blurb",
            status: spec?.backCover?.blurb ? "ready" : "needed",
            details: "Synopsis/hook text for back cover",
          }
        );
      }

      const readyCount = checklist.filter((c) => c.status === "ready").length;
      const neededCount = checklist.filter((c) => c.status === "needed").length;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                format,
                checklist,
                summary: `${readyCount} ready, ${neededCount} items needed`,
                publishReady: neededCount === 0,
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

function generateCoverPrompt(spec: { title: string; genre: string; design: { mood: string; style: string; colorPalette: string[]; imagery: string; typography: { titleFont: string } } }, genre: string): string {
  return [
    `Professional book cover for "${spec.title}".`,
    `Genre: ${genre}.`,
    `${spec.design.style} design style.`,
    `Mood: ${spec.design.mood}.`,
    `Imagery: ${spec.design.imagery}.`,
    `Color palette: ${spec.design.colorPalette.join(", ")}.`,
    "Print quality, 300 DPI. Do not include any text — text will be added separately.",
  ].join(" ");
}

function generateDesignBrief(spec: { title: string; authorName: string; genre: string; targetPlatform: string; design: { mood: string; style: string; colorPalette: string[]; typography: { titleFont: string; subtitleFont?: string; authorFont: string }; imagery: string; referenceCovers?: string[] }; dimensions: { widthPixels: number; heightPixels: number; dpi: number }; backCover?: { blurb: string; authorBio: string } }): string {
  const lines = [
    `# Cover Design Brief: "${spec.title}"`,
    `**Author:** ${spec.authorName}`,
    `**Genre:** ${spec.genre}`,
    `**Format:** ${spec.targetPlatform}`,
    "",
    "## Visual Direction",
    `**Mood:** ${spec.design.mood}`,
    `**Style:** ${spec.design.style}`,
    `**Imagery:** ${spec.design.imagery}`,
    `**Colors:** ${spec.design.colorPalette.join(", ")}`,
    "",
    "## Typography",
    `**Title:** ${spec.design.typography.titleFont}`,
    spec.design.typography.subtitleFont ? `**Subtitle:** ${spec.design.typography.subtitleFont}` : null,
    `**Author Name:** ${spec.design.typography.authorFont}`,
    "",
    "## Technical Specs",
    `**Dimensions:** ${spec.dimensions.widthPixels} x ${spec.dimensions.heightPixels}px at ${spec.dimensions.dpi} DPI`,
    "",
    spec.design.referenceCovers?.length
      ? `## Reference Covers\n${spec.design.referenceCovers.map((r) => `- ${r}`).join("\n")}`
      : null,
    spec.backCover
      ? `## Back Cover\n**Blurb:** ${spec.backCover.blurb}\n**Author Bio:** ${spec.backCover.authorBio}`
      : null,
  ];

  return lines.filter(Boolean).join("\n");
}
