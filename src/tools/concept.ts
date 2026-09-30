import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as fs from "fs";
import * as path from "path";
import {
  getAuthorProfile,
  getConcept,
  getMetadata,
  getOutline,
  getStoryBible,
  updateConcept,
} from "../storage/filestore";
import { chaptersInOrder, requireProject } from "../storage/chapters";
import { normaliseThemes } from "../storage/bible";
import { Concept } from "../storage/schema";
import { BookMCPError } from "../utils/errors";
import { projectLanguage } from "../lang";
import { assembleBook } from "../export/assemble";
import { measureExtent } from "../export/normseite";
import { buildDocx, layoutFor } from "../export/docx";
import { buildExpose } from "../publishing/expose";
import { briefSchema, writeReply } from "./brief";

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

const TEXT_FIELDS = [
  "premise",
  "logline",
  "centralQuestion",
  "targetAudience",
  "uniqueSellingPoint",
  "coreThesis",
  "readerPromise",
] as const;

/** Advice on the concept as it stands — a logline that is not one line, say. */
function review(concept: Concept | null): string[] {
  const advice: string[] = [];
  if (concept?.logline) {
    const words = concept.logline.split(/\s+/).filter(Boolean).length;
    const sentences = (concept.logline.match(/[.!?…](\s|$)/g) ?? []).length;
    if (words > 50 || sentences > 1) {
      advice.push(
        `The logline runs to ${words} words in ${Math.max(1, sentences)} sentence(s). A logline is one sentence, ideally under 35 words: who, wants what, against what.`
      );
    }
  }
  const comps = concept?.comparableTitles ?? [];
  if (comps.length > 5) {
    advice.push(`${comps.length} comparable titles; two or three well-chosen ones say more.`);
  }
  if (comps.some((c) => !c.why)) {
    advice.push("Say for each comparable title what it shares with this book — the comparison is the point, not the name.");
  }
  return advice;
}

function missingForExpose(concept: Concept | null): string[] {
  const nonfiction = concept?.bookType === "nonfiction";
  const required = nonfiction
    ? (["logline", "coreThesis", "readerPromise", "targetAudience"] as const)
    : (["logline", "premise", "targetAudience"] as const);
  return [
    ...required.filter((f) => !concept?.[f]),
    ...(concept?.comparableTitles?.length ? [] : ["comparableTitles"]),
  ];
}

export function registerConceptTools(server: McpServer): void {
  server.tool(
    "book_concept_set",
    "Set what the book is, before anything else: fiction or non-fiction, premise, logline (the book in one sentence), the central question, the readership, comparable titles and what sets it apart — for non-fiction the core argument and what the reader takes away. It is what an exposé is written from. Every field is optional and replaces what was there; an empty string clears it.",
    {
      bookType: z.enum(["fiction", "nonfiction"]).optional(),
      premise: z.string().optional().describe("The situation the book grows from: who wants what, and what is in the way"),
      logline: z.string().optional().describe("The book in one sentence"),
      centralQuestion: z.string().optional().describe("The question the reader keeps turning pages to have answered"),
      targetAudience: z.string().optional().describe("Who it is for"),
      comparableTitles: z
        .array(
          z.object({
            title: z.string(),
            author: z.string(),
            year: z.number().optional(),
            why: z.string().optional().describe("What it shares with this book"),
          })
        )
        .optional()
        .describe("Two or three recent books this one sits next to on the shelf"),
      uniqueSellingPoint: z.string().optional().describe("What this book has that the comparable titles do not"),
      coreThesis: z.string().optional().describe("Non-fiction: the claim the book makes"),
      readerPromise: z.string().optional().describe("Non-fiction: what the reader will know or be able to do afterwards"),
      brief: briefSchema,
    },
    async ({ brief, ...input }) => {
      if (Object.values(input).every((v) => v === undefined)) {
        throw new BookMCPError("Nothing to set: pass at least one field.");
      }
      requireProject();
      const concept = await updateConcept((c) => {
        if (input.bookType) c.bookType = input.bookType;
        for (const field of TEXT_FIELDS) {
          const value = input[field];
          if (value === undefined) continue;
          if (value.trim()) c[field] = value.trim();
          else delete c[field];
        }
        if (input.comparableTitles !== undefined) {
          const comps = input.comparableTitles.filter((t) => t.title.trim() && t.author.trim());
          if (comps.length) c.comparableTitles = comps;
          else delete c.comparableTitles;
        }
      });
      const advice = review(concept);
      return writeReply(
        brief,
        {
          message: "Concept saved.",
          concept,
          missingForExpose: missingForExpose(concept),
          ...(advice.length ? { advice } : {}),
        },
        { id: "concept", status: "updated" }
      );
    }
  );

  server.tool(
    "book_concept_get",
    "The book's concept, its themes from the story bible, and what an exposé still lacks",
    {},
    async () => {
      requireProject();
      const concept = getConcept();
      const advice = review(concept);
      return jsonResult({
        concept: concept ?? {},
        themes: normaliseThemes(getStoryBible()?.themes),
        missingForExpose: missingForExpose(concept),
        ...(advice.length ? { advice } : {}),
      });
    }
  );

  server.tool(
    "book_expose_generate",
    "Write an exposé (book proposal) for agencies and publishers in the book's language: title and facts with the extent in Normseiten, pitch, premise (or, for non-fiction, the argument and what the reader takes away), themes, synopsis from the chapter synopses, cast, comparable titles, the author — and optionally a sample of the first chapters as a submission manuscript. Anything the project does not know yet is marked [TODO: …] in the text and listed in the reply.",
    {
      outputPath: z.string().optional().describe("Where to write the exposé (default: ./expose.md)"),
      includeSample: z
        .boolean()
        .optional()
        .default(true)
        .describe("Also write a sample of the first chapters as a Normseite (German) or Standard Manuscript Format (English) .docx"),
      samplePages: z
        .number()
        .optional()
        .default(30)
        .describe("Roughly how long the sample should be, in Normseiten (default 30, the usual request)"),
      contact: z.array(z.string()).optional().describe("Contact lines for the sample's cover sheet"),
    },
    async ({ outputPath, includeSample, samplePages, contact }) => {
      const registry = requireProject();
      const language = projectLanguage().tag;
      const german = language.toLowerCase().startsWith("de");
      const projectDir = process.env.BOOK_PROJECT_DIR || process.cwd();
      const chapters = chaptersInOrder(registry);
      const whole = assembleBook(registry, chapters, { includeMatter: false });
      const extent = measureExtent(whole);

      // The sample: whole chapters from the start until the requested length
      // is reached — never a chapter cut off mid-scene.
      let sample: { file: string; chapters: number; normPages: number } | undefined;
      if (includeSample && whole.chapterCount > 0) {
        const taken = [];
        let pages = 0;
        for (const chapter of chapters) {
          const one = measureExtent(assembleBook(registry, [chapter], { includeMatter: false })).normPages;
          if (taken.length && pages + one > samplePages * 1.25) break;
          taken.push(chapter);
          pages += one;
          if (pages >= samplePages) break;
        }
        const sampleBook = assembleBook(registry, taken, { includeMatter: false });
        const preset = german ? "normseite" : "standard_manuscript";
        const surname = sampleBook.author.trim().split(/\s+/).pop() ?? sampleBook.author;
        const buffer = await buildDocx(
          sampleBook,
          layoutFor({
            preset,
            contact,
            runningHead: german ? `${sampleBook.author} · ${sampleBook.title}` : `${surname} / ${sampleBook.title.toUpperCase()}`,
            extent: german ? `Leseprobe, ca. ${pages} Normseiten` : `sample, about ${pages} pages`,
          })
        );
        const file = path.join(projectDir, german ? "leseprobe.docx" : "sample.docx");
        fs.writeFileSync(file, buffer);
        sample = { file, chapters: taken.length, normPages: pages };
      }

      const expose = buildExpose({
        registry,
        concept: getConcept(),
        metadata: getMetadata(),
        bible: getStoryBible(),
        outline: getOutline(),
        profile: getAuthorProfile(),
        language,
        extent,
        sample: sample
          ? german
            ? `Beiliegend: ${sample.chapters === 1 ? "das erste Kapitel" : `die ersten ${sample.chapters} Kapitel`}, ca. ${sample.normPages} Normseiten (${path.basename(sample.file)}).`
            : `Enclosed: the first ${sample.chapters === 1 ? "chapter" : `${sample.chapters} chapters`}, about ${sample.normPages} manuscript pages (${path.basename(sample.file)}).`
          : undefined,
      });

      const outPath = outputPath || path.join(projectDir, "expose.md");
      fs.writeFileSync(outPath, expose.markdown, "utf-8");

      return jsonResult({
        message: expose.missing.length
          ? `Exposé written, with ${expose.missing.length} gap(s) marked [TODO] in the text.`
          : "Exposé written.",
        outputPath: outPath,
        extent: { normPages: extent.normPages, words: extent.words },
        ...(sample ? { sample } : {}),
        ...(expose.missing.length ? { missing: expose.missing } : {}),
      });
    }
  );
}
