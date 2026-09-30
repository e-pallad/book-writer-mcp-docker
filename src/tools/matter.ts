import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getAuthorProfile,
  getMatter,
  getMetadata,
  getResearch,
  getStoryBible,
  updateMatter,
} from "../storage/filestore";
import { requireProject } from "../storage/chapters";
import { MatterSection, MatterType } from "../storage/schema";
import { BookMCPError } from "../utils/errors";
import { countWords } from "../utils/wordcount";
import { labelsFor, projectLanguage } from "../lang";
import { emptyReason, MATTER_KINDS, MATTER_TYPES, matterContent } from "../export/matter";
import { briefSchema, writeReply } from "./brief";

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

const TYPE_SCHEMA = z
  .enum(MATTER_TYPES as [MatterType, ...MatterType[]])
  .describe(
    "copyright (Impressum), dedication, epigraph (Motto), foreword, preface, dramatis_personae (cast list), afterword, acknowledgements, glossary, bibliography, about_author, also_by"
  );

/** A section as the tools report it: what it is, where it goes, what it will print. */
function describe(section: MatterSection) {
  const registry = requireProject();
  const labels = labelsFor(projectLanguage().tag);
  const kind = MATTER_KINDS[section.type];
  const printed = matterContent(section, {
    registry,
    metadata: getMetadata(),
    bible: getStoryBible(),
    profile: getAuthorProfile(),
    labels,
    research: getResearch(),
    language: projectLanguage().tag,
  });
  return {
    type: section.type,
    heading: kind.headed || section.title ? section.title ?? labels.matter[section.type] : null,
    position: section.position ?? kind.position,
    source: section.content.trim() ? "written" : "generated",
    ...(printed === null
      ? { willPrint: null, note: `Left out of the exports for now. ${emptyReason(section.type)}` }
      : { willPrint: printed, words: countWords(printed) }),
  };
}

export function registerMatterTools(server: McpServer): void {
  server.tool(
    "book_matter_set",
    "Add or replace a piece of front or back matter — the parts of a book that are not chapters. The exports set them in the classic order: copyright page, dedication, epigraph, contents, foreword, preface, cast list; after the last chapter the afterword, acknowledgements, glossary, bibliography, about the author, also by. The copyright page, the cast list, the author's bio and the bibliography can be left without content: they are then written at export time from the metadata, the story bible, the author profile and the research notes marked for the bibliography.",
    {
      type: TYPE_SCHEMA,
      content: z
        .string()
        .optional()
        .describe(
          "The section's text as markdown. Leave out for copyright, dramatis_personae, about_author and bibliography to have it written from the project's data."
        ),
      title: z
        .string()
        .optional()
        .describe('Heading to print instead of the default ("Danksagung", "About the Author"); "" restores the default'),
      position: z
        .enum(["front", "back"])
        .optional()
        .describe("Move the section to the other end of the book — a cast list at the back, say"),
      brief: briefSchema,
    },
    async ({ type, content, title, position, brief }) => {
      const kind = MATTER_KINDS[type];

      let section!: MatterSection;
      let replaced = false;
      await updateMatter((matter) => {
        const existing = matter.sections.find((s) => s.type === type);
        replaced = Boolean(existing);
        section = existing ?? { type, content: "", updatedAt: "" };
        if (content !== undefined) section.content = content;
        if (title !== undefined) {
          if (title.trim()) section.title = title.trim();
          else delete section.title;
        }
        if (position !== undefined) {
          if (position === kind.position) delete section.position;
          else section.position = position;
        }
        // Checked on the result, so a heading can be changed without sending
        // the text again.
        if (!kind.auto && !section.content.trim()) {
          throw new BookMCPError(
            `A ${type.replace(/_/g, " ")} needs content: only copyright, dramatis_personae, about_author and bibliography can be written from the project's data.`
          );
        }
        section.updatedAt = new Date().toISOString();
        if (!existing) matter.sections.push(section);
      });

      const described = describe(section);
      const caution =
        type === "dramatis_personae" && described.source === "generated"
          ? "The cast list prints the first sentence of each character's story-bible description. Read it for spoilers before publishing, or give the section content of its own."
          : undefined;
      return writeReply(
        brief,
        {
          message: `${replaced ? "Updated" : "Added"} the ${type.replace(/_/g, " ")}.`,
          section: described,
          ...(caution ? { caution } : {}),
        },
        {
          id: type,
          status: replaced ? "updated" : "created",
          ...("words" in described ? { wordCount: described.words } : {}),
        },
        caution ? [caution] : []
      );
    }
  );

  server.tool(
    "book_matter_get",
    "Read one piece of front or back matter, including what it will print — for a generated section, the text as it stands today.",
    { type: TYPE_SCHEMA },
    async ({ type }) => {
      const section = getMatter()?.sections.find((s) => s.type === type);
      if (!section) {
        throw new BookMCPError(`The book has no ${type.replace(/_/g, " ")}. Add it with book_matter_set.`);
      }
      return jsonResult({ section: { ...describe(section), content: section.content, title: section.title ?? null } });
    }
  );

  server.tool(
    "book_matter_list",
    "List the book's front and back matter in the order the exports set it, with each section's heading, whether it was written or is generated, and its length.",
    {},
    async () => {
      const sections = [...(getMatter()?.sections ?? [])].sort(
        (a, b) => MATTER_KINDS[a.type].order - MATTER_KINDS[b.type].order
      );
      const described = sections.map(describe).map(({ willPrint: _, ...rest }) => rest);
      return jsonResult({
        front: described.filter((s) => s.position === "front"),
        back: described.filter((s) => s.position === "back"),
        available: MATTER_TYPES.filter((t) => !sections.some((s) => s.type === t)),
      });
    }
  );

  server.tool(
    "book_matter_remove",
    "Remove a piece of front or back matter",
    { type: TYPE_SCHEMA, brief: briefSchema },
    async ({ type, brief }) => {
      let removed = false;
      await updateMatter((matter) => {
        const before = matter.sections.length;
        matter.sections = matter.sections.filter((s) => s.type !== type);
        removed = matter.sections.length < before;
        if (!removed) return false;
      });
      if (!removed) throw new BookMCPError(`The book has no ${type.replace(/_/g, " ")}.`);
      return writeReply(
        brief,
        { message: `Removed the ${type.replace(/_/g, " ")}.` },
        { id: type, status: "deleted" }
      );
    }
  );
}
