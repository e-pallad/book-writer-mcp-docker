// Turning a passage selected in the preview into a note on the right chapter.
//
// The browser only knows the rendered text of the page, which has lost the
// markdown (emphasis markers, the chapter a paragraph came from). The passage
// is therefore found again in the chapter files, and the note is anchored to
// the exact words when they appear verbatim in the source, or to the paragraph
// when emphasis or a line break in between makes that impossible.

import { getNotes, getRegistry, readChapterFile, updateNotes } from "../storage/filestore";
import { Note } from "../storage/schema";
import { plainText } from "../utils/markdown";
import { condense } from "../utils/match";
import { splitParagraphs, toNFC } from "../utils/text";
import { locateNote, newNoteId } from "../notes/anchor";

type Registry = NonNullable<ReturnType<typeof getRegistry>>;

const MAX_ANCHOR_CHARS = 200;
const PARAGRAPH_ANCHOR_CHARS = 60;
const MIN_SELECTION_CHARS = 2;

export interface MarkRequest {
  /** What the reader selected, as the browser reports it. */
  selection: string;
  /** The plain text of the paragraph the selection starts in, to tell repeats apart. */
  container?: string;
  /** The reader's own comment; optional. */
  text?: string;
  kind?: Note["kind"];
}

export interface PassageLocation {
  chapterId: string;
  chapterTitle: string;
  paragraph: number;
  anchorText: string;
}

const flat = (value: string) => condense(toNFC(value)).trim();

/**
 * Finds where a selection came from. A selection across paragraphs is placed by
 * its first paragraph's worth of text. Returns null for text that is not in any
 * chapter — front matter, part pages, the generated title.
 */
export function locatePassage(
  registry: Registry,
  selection: string,
  container?: string
): PassageLocation | null {
  const parts = toNFC(selection)
    .split(/\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const needle = flat(parts[0]);
  if (needle.length < MIN_SELECTION_CHARS) return null;
  const wanted = container ? flat(container) : "";

  let first: PassageLocation | null = null;
  const chapters = [...registry.chapters].sort((a, b) => a.order - b.order);
  for (const chapter of chapters) {
    const content = toNFC(readChapterFile(chapter.filename));
    for (const paragraph of splitParagraphs(content)) {
      const plain = flat(plainText(paragraph.text));
      if (!plain.includes(needle)) continue;

      const verbatim = parts[0];
      const anchorText = paragraph.text.includes(verbatim)
        ? verbatim.slice(0, MAX_ANCHOR_CHARS)
        : paragraph.text.trim().slice(0, PARAGRAPH_ANCHOR_CHARS);
      const found: PassageLocation = {
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        paragraph: paragraph.index,
        anchorText,
      };
      if (!wanted || plain === wanted) return found;
      first ??= found;
    }
  }
  return first;
}

export class MarkError extends Error {}

/** Records the marked passage as an open note and returns it. */
export async function markPassage(request: MarkRequest): Promise<Note> {
  const registry = getRegistry();
  if (!registry) throw new MarkError("No book project here.");
  if (typeof request.selection !== "string" || !request.selection.trim()) {
    throw new MarkError("Nothing is selected.");
  }

  const where = locatePassage(registry, request.selection, request.container);
  if (!where) {
    throw new MarkError(
      "That passage is not in a chapter — front matter and part pages cannot be marked."
    );
  }

  const quoted = flat(request.selection);
  const comment = typeof request.text === "string" ? request.text.trim() : "";
  const kinds: Note["kind"][] = ["comment", "question", "suggestion", "praise"];
  const note: Note = {
    id: "",
    chapterId: where.chapterId,
    anchorText: where.anchorText,
    paragraphHint: where.paragraph,
    source: "Vorschau",
    kind: kinds.includes(request.kind as Note["kind"]) ? (request.kind as Note["kind"]) : "suggestion",
    // The words themselves go in the text too: the anchor may be only the
    // opening of a paragraph, and an editor reading the list wants the passage.
    text: [comment || "Zur Überarbeitung markiert.", `„${quoted.slice(0, 400)}“`].join("\n\n"),
    status: "open",
    createdAt: new Date().toISOString(),
  };
  await updateNotes((notes) => {
    note.id = newNoteId(notes.notes);
    notes.notes.push(note);
  });
  return note;
}

/** An open note, placed for the reader page to draw on the passage. */
export interface NoteHighlight {
  id: string;
  kind: Note["kind"];
  source: string;
  text: string;
  /** The passage, as the page shows it (markup removed, whitespace collapsed). */
  quote: string;
  /** The paragraph it is in, in the same form — finds the block among repeats. */
  container: string;
}

const MAX_HIGHLIGHT_TEXT = 600;

/** Open notes whose passage is still in its chapter. Lost anchors are left out. */
export function openNoteHighlights(registry: Registry): NoteHighlight[] {
  const open = (getNotes()?.notes ?? []).filter((n) => n.status === "open" && n.anchorText);
  const chapters = new Map<string, ReturnType<typeof splitParagraphs> | null>();
  const contents = new Map<string, string>();

  const highlights: NoteHighlight[] = [];
  for (const note of open) {
    const chapter = registry.chapters.find((c) => c.id === note.chapterId);
    if (!chapter) continue;
    if (!contents.has(chapter.id)) contents.set(chapter.id, toNFC(readChapterFile(chapter.filename)));
    const content = contents.get(chapter.id)!;

    const located = locateNote(note, content);
    if (!located.found || located.paragraph == null) continue;
    if (!chapters.has(chapter.id)) chapters.set(chapter.id, splitParagraphs(content));
    const paragraph = chapters.get(chapter.id)![located.paragraph - 1];
    if (!paragraph) continue;

    highlights.push({
      id: note.id,
      kind: note.kind,
      source: note.source,
      text: note.text.trim().slice(0, MAX_HIGHLIGHT_TEXT),
      quote: flat(plainText(note.anchorText)),
      container: flat(plainText(paragraph.text)),
    });
  }
  return highlights;
}
