// Front and back matter: what each section is, where it goes, and — for the
// ones the project can write itself — what it says.

import {
  AuthorProfile,
  Character,
  Matter,
  MatterSection,
  MatterType,
  PublishingMetadata,
  Registry,
  Research,
  StoryBible,
} from "../storage/schema";
import { Labels } from "../lang/types";
import { rightsStatement } from "../publishing/metadata";

export interface MatterKind {
  position: "front" | "back";
  /** Place within its end of the book. */
  order: number;
  /** Front matter that comes before the table of contents. */
  beforeContents: boolean;
  /** Printed with a heading. A dedication or an epigraph stands alone. */
  headed: boolean;
  /** Written from the project's own data when no content is given. */
  auto: boolean;
  /** EPUB structural semantics, where the vocabulary has a term for it. */
  epubType?: string;
}

// The classic order: the imprint on the back of the title page, then the
// dedication and the epigraph, the contents, the forewords; at the back the
// afterword, thanks, reference material and the author.
export const MATTER_KINDS: Record<MatterType, MatterKind> = {
  copyright: { position: "front", order: 10, beforeContents: true, headed: false, auto: true, epubType: "copyright-page" },
  dedication: { position: "front", order: 20, beforeContents: true, headed: false, auto: false, epubType: "dedication" },
  epigraph: { position: "front", order: 30, beforeContents: true, headed: false, auto: false, epubType: "epigraph" },
  foreword: { position: "front", order: 40, beforeContents: false, headed: true, auto: false, epubType: "foreword" },
  preface: { position: "front", order: 50, beforeContents: false, headed: true, auto: false, epubType: "preface" },
  dramatis_personae: { position: "front", order: 60, beforeContents: false, headed: true, auto: true },
  afterword: { position: "back", order: 110, beforeContents: false, headed: true, auto: false, epubType: "afterword" },
  acknowledgements: { position: "back", order: 120, beforeContents: false, headed: true, auto: false, epubType: "acknowledgments" },
  glossary: { position: "back", order: 130, beforeContents: false, headed: true, auto: false, epubType: "glossary" },
  bibliography: { position: "back", order: 140, beforeContents: false, headed: true, auto: true, epubType: "bibliography" },
  about_author: { position: "back", order: 150, beforeContents: false, headed: true, auto: true },
  also_by: { position: "back", order: 160, beforeContents: false, headed: true, auto: false },
};

export const MATTER_TYPES = Object.keys(MATTER_KINDS) as MatterType[];

export interface RenderedMatter {
  type: MatterType;
  position: "front" | "back";
  beforeContents: boolean;
  order: number;
  /** The printed heading, or null for a section that stands without one. */
  heading: string | null;
  /** The name in a table of contents or the EPUB navigation. */
  navTitle: string;
  markdown: string;
  source: "written" | "generated";
  epubType?: string;
}

export interface MatterSources {
  registry: Registry;
  metadata: PublishingMetadata | null;
  bible: StoryBible | null;
  profile: AuthorProfile | null;
  labels: Labels;
  research?: Research | null;
  /** For sorting the bibliography the way the book's language does. */
  language?: string;
}

const ROLE_ORDER: Character["role"][] = ["protagonist", "antagonist", "supporting"];

function firstSentence(text: string): string {
  const match = /^[\s\S]*?[.!?…](?=\s|$)/u.exec(text.trim());
  return (match ? match[0] : text).trim();
}

/** The copyright page, from the metadata and the registry. */
function copyrightPage({ registry, metadata, labels }: MatterSources): string {
  const blocks: string[][] = [];
  const title = [`**${registry.title}**`];
  if (metadata?.subtitle) title.push(metadata.subtitle);
  if (metadata?.series) title.push(labels.seriesVolume(metadata.series.name, metadata.series.number));
  blocks.push(title);

  blocks.push([rightsStatement(metadata, registry), labels.allRightsReserved]);

  const edition: string[] = [];
  if (metadata?.publicationDate) edition.push(`${labels.firstPublished} ${metadata.publicationDate}`);
  if (metadata?.publisher) edition.push(metadata.publisher);
  if (edition.length) blocks.push(edition);

  const credits = (metadata?.contributors ?? []).map(
    (c) => `${labels.roles[c.role]}: ${c.name}`
  );
  if (credits.length) blocks.push(credits);

  const isbns = (["ebook", "paperback", "hardcover"] as const)
    .filter((edition) => metadata?.isbn?.[edition])
    .map((edition) => `ISBN ${metadata!.isbn![edition]} (${labels.editions[edition]})`);
  if (isbns.length) blocks.push(isbns);

  return blocks.map((lines) => lines.join("\n")).join("\n\n");
}

/** The cast, main roles first, each with the first sentence of their description. */
function dramatisPersonae({ bible }: MatterSources): string | null {
  const cast = (bible?.characters ?? [])
    .filter((c) => c.role !== "minor")
    .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));
  if (!cast.length) return null;
  return cast
    .map((c) => {
      const about = firstSentence(c.description);
      return about ? `**${c.name}** — ${about}` : `**${c.name}**`;
    })
    .join("\n\n");
}

function aboutAuthor({ profile }: MatterSources): string | null {
  return profile?.generatedIntro?.trim() || null;
}

/**
 * The sources marked for the bibliography, alphabetically as the book's
 * language sorts, each with its link when it has one.
 */
export function bibliography({ research, language }: MatterSources): string | null {
  const entries = (research?.entries ?? []).filter((e) => e.bibliography);
  if (!entries.length) return null;
  const collator = new Intl.Collator(language ?? "en", { sensitivity: "base" });
  return entries
    .map((e) => ({ text: (e.source?.trim() || e.title).trim(), url: e.url?.trim() }))
    .sort((a, b) => collator.compare(a.text, b.text))
    .map((e) => `- ${e.text}${e.url ? ` — ${e.url}` : ""}`)
    .join("\n");
}

/**
 * The text a section will print: what the author wrote, or what the project
 * says when the section is one it can write itself. Null when there is nothing
 * to print — an automatic section whose source is still empty.
 */
export function matterContent(section: MatterSection, sources: MatterSources): string | null {
  if (section.content.trim()) return section.content;
  switch (section.type) {
    case "copyright":
      return copyrightPage(sources);
    case "dramatis_personae":
      return dramatisPersonae(sources);
    case "about_author":
      return aboutAuthor(sources);
    case "bibliography":
      return bibliography(sources);
    default:
      return null;
  }
}

/** Why an automatic section came out empty, for the export's warnings. */
export function emptyReason(type: MatterType): string {
  switch (type) {
    case "dramatis_personae":
      return "The cast list is empty: the story bible has no characters above a minor role.";
    case "about_author":
      return "There is no author bio yet. Write one with book_author_update_profile, or give the section content.";
    case "bibliography":
      return "No research entry is marked for the bibliography. Mark sources with book_research_add bibliography=true.";
    default:
      return "The section has no content.";
  }
}

/** Every section, rendered and in reading order. */
export function renderMatter(
  matter: Matter | null,
  sources: MatterSources
): { sections: RenderedMatter[]; warnings: string[] } {
  const warnings: string[] = [];
  const sections: RenderedMatter[] = [];

  for (const section of matter?.sections ?? []) {
    const kind = MATTER_KINDS[section.type];
    if (!kind) continue;
    const markdown = matterContent(section, sources);
    if (markdown === null) {
      warnings.push(`${sources.labels.matter[section.type]} left out: ${emptyReason(section.type)}`);
      continue;
    }
    const position = section.position ?? kind.position;
    const navTitle = section.title?.trim() || sources.labels.matter[section.type];
    sections.push({
      type: section.type,
      position,
      beforeContents: position === "front" && kind.beforeContents,
      order: kind.order,
      heading: kind.headed || section.title?.trim() ? navTitle : null,
      navTitle,
      markdown,
      source: section.content.trim() ? "written" : "generated",
      epubType: kind.epubType,
    });
  }

  sections.sort((a, b) => a.order - b.order);
  return { sections, warnings };
}
