import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import {
  Registry,
  StoryBible,
  StyleGuide,
  Outline,
  CoverSpec,
  AuthorProfile,
  Timeline,
  AiDisclosure,
  WritingLog,
  PublishingMetadata,
  Matter,
  Notes,
} from "./schema";
import { BookMCPError } from "../utils/errors";
import { toNFC } from "../utils/text";
import { withFileLock } from "./lock";
import { countWords, WORD_COUNT_VERSION } from "../utils/wordcount";

const MCP_DIR = ".book-mcp";
const CHAPTERS_DIR = "chapters";
const TRASH_DIR = "trash";

function getProjectDir(): string {
  return process.env.BOOK_PROJECT_DIR || process.cwd();
}

function mcpPath(...parts: string[]): string {
  return path.join(getProjectDir(), MCP_DIR, ...parts);
}

function chaptersPath(...parts: string[]): string {
  return path.join(getProjectDir(), CHAPTERS_DIR, ...parts);
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// Writes via a temp file + rename so a crash or concurrent read never
// observes a partially-written file; rename is atomic on the same filesystem.
// Everything is written as UTF-8 in NFC so an "ö" typed on macOS (o + combining
// diaeresis) is stored the same way as one typed on Windows or Linux.
function writeFileAtomic(filePath: string, data: string): void {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmpPath, toNFC(data), "utf-8");
  fs.renameSync(tmpPath, filePath);
}

function readJSON<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf-8");
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new BookMCPError(
      `Corrupted project data in ${filePath}: ${(error as Error).message}`
    );
  }
}

function writeJSON<T>(filePath: string, data: T): void {
  writeFileAtomic(filePath, JSON.stringify(data, null, 2));
}

// Registry
export function getRegistry(): Registry | null {
  return readJSON<Registry>(mcpPath("registry.json"));
}

export function saveRegistry(registry: Registry): void {
  registry.updatedAt = new Date().toISOString();
  writeJSON(mcpPath("registry.json"), registry);
}

export function initProject(
  title: string,
  author: string,
  genre: string,
  targetWordCount: number,
  language = "en"
): Registry {
  ensureDir(mcpPath());
  ensureDir(chaptersPath());

  const registry: Registry = {
    title,
    author,
    genre,
    targetWordCount,
    language,
    countVersion: WORD_COUNT_VERSION,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    chapters: [],
  };
  saveRegistry(registry);

  const bible: StoryBible = {
    characters: [],
    settings: [],
    themes: [],
    plotThreads: [],
    timelineRef: TIMELINE_FILE,
  };
  saveStoryBible(bible);

  saveTimeline({ events: [] });

  const outline: Outline = { acts: [] };
  saveOutline(outline);

  return registry;
}

// Chapters
export function readChapterFile(filename: string): string {
  const filePath = chaptersPath(filename);
  if (!fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf-8");
}

export function writeChapterFile(filename: string, content: string): void {
  writeFileAtomic(chaptersPath(filename), content);
}

// Renames a chapter file so the file name keeps matching the chapter title.
// Returns false when there is nothing on disk to rename (a chapter that was
// registered but never written), so callers can still update the registry.
export function renameChapterFile(oldName: string, newName: string): boolean {
  if (oldName === newName) return false;
  const from = chaptersPath(oldName);
  if (!fs.existsSync(from)) return false;
  const to = chaptersPath(newName);
  if (fs.existsSync(to)) {
    throw new BookMCPError(
      `Cannot rename chapter file: "chapters/${newName}" already exists.`
    );
  }
  ensureDir(path.dirname(to));
  fs.renameSync(from, to);
  return true;
}

// Deleting a chapter throws away prose, so the file is moved into
// .book-mcp/trash/ instead of being unlinked: a mistaken delete stays
// recoverable by hand. Returns the trash path, or null when no file existed.
export function trashChapterFile(filename: string): string | null {
  const from = chaptersPath(filename);
  if (!fs.existsSync(from)) return null;

  const trashDir = mcpPath(TRASH_DIR);
  ensureDir(trashDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let to = path.join(trashDir, `${stamp}-${filename}`);
  // A second delete of the same file within the same millisecond would
  // otherwise overwrite the first copy.
  let counter = 1;
  while (fs.existsSync(to)) {
    to = path.join(trashDir, `${stamp}-${counter++}-${filename}`);
  }
  fs.renameSync(from, to);
  return to;
}

// Story Bible
export function getStoryBible(): StoryBible | null {
  return readJSON<StoryBible>(mcpPath("story-bible.json"));
}

export function saveStoryBible(bible: StoryBible): void {
  writeJSON(mcpPath("story-bible.json"), bible);
}

// Timeline
//
// Kept out of story-bible.json so events can reference chapters and characters
// by id without a second copy of either. story-bible.json carries a
// `timelineRef` pointing here.
export const TIMELINE_FILE = "timeline.json";

export function getTimeline(): Timeline | null {
  return readJSON<Timeline>(mcpPath(TIMELINE_FILE));
}

export function saveTimeline(timeline: Timeline): void {
  writeJSON(mcpPath(TIMELINE_FILE), timeline);
}

/**
 * The timeline, creating it on first use and carrying over any events an older
 * version of this server wrote inline into story-bible.json.
 *
 * Projects created before timeline.json existed have `timeline: []` in their
 * story bible. Nothing ever wrote to it — there was no tool that could — but a
 * hand-edited project might, so the events are moved rather than dropped.
 */
export function loadOrInitTimeline(): Timeline {
  const existing = getTimeline();
  if (existing) return existing;

  const timeline: Timeline = { events: [] };
  const bible = getStoryBible();

  if (bible?.timeline?.length) {
    const now = new Date().toISOString();
    timeline.events = bible.timeline.map((legacy, index) => ({
      id: legacy.id || `tl-legacy-${index + 1}`,
      event: legacy.event,
      inStoryTime: "",
      // The old shape had an integer `order` and nothing else to sort on.
      sortKey: String(legacy.order ?? index).padStart(6, "0"),
      chapterId: legacy.chapterId || undefined,
      characterIds: [],
      notes: "Migrated from story-bible.json.",
      createdAt: now,
      updatedAt: now,
    }));
  }

  saveTimeline(timeline);

  if (bible) {
    bible.timelineRef = TIMELINE_FILE;
    delete bible.timeline;
    saveStoryBible(bible);
  }

  return timeline;
}

/**
 * Amends the timeline under its own lock, creating and migrating it first when
 * the project has none.
 */
export function updateTimeline(
  mutate: (timeline: Timeline) => unknown | Promise<unknown>
): Promise<Timeline> {
  return withFileLock(mcpPath(TIMELINE_FILE), async () => {
    const timeline = loadOrInitTimeline();
    const outcome = await mutate(timeline);
    if (outcome !== ABORT) saveTimeline(timeline);
    return timeline;
  });
}

// Writing log
//
// Written only while registry.json is held: every change to chapter text runs
// inside a registry transaction, and so does every entry here. That lock is
// what serialises it, so it takes none of its own — and must never be written
// from outside a registry transaction.
export function getWritingLog(): WritingLog | null {
  return readJSON<WritingLog>(mcpPath("writing-log.json"));
}

export function saveWritingLog(log: WritingLog): void {
  writeJSON(mcpPath("writing-log.json"), log);
}

// Publishing metadata
export function getMetadata(): PublishingMetadata | null {
  return readJSON<PublishingMetadata>(mcpPath("metadata.json"));
}

export function saveMetadata(metadata: PublishingMetadata): void {
  metadata.updatedAt = new Date().toISOString();
  writeJSON(mcpPath("metadata.json"), metadata);
}

/** Amends the metadata, creating it on first use. */
export function updateMetadata(
  mutate: (metadata: PublishingMetadata) => unknown | Promise<unknown>
): Promise<PublishingMetadata> {
  return withFileLock(mcpPath("metadata.json"), async () => {
    const metadata = getMetadata() ?? { updatedAt: new Date().toISOString() };
    const outcome = await mutate(metadata);
    if (outcome !== ABORT) saveMetadata(metadata);
    return metadata;
  });
}

// Front and back matter
export function getMatter(): Matter | null {
  return readJSON<Matter>(mcpPath("matter.json"));
}

export function saveMatter(matter: Matter): void {
  writeJSON(mcpPath("matter.json"), matter);
}

/** Amends the front and back matter, creating the file on first use. */
export function updateMatter(
  mutate: (matter: Matter) => unknown | Promise<unknown>
): Promise<Matter> {
  return withFileLock(mcpPath("matter.json"), async () => {
    const matter = getMatter() ?? { sections: [] };
    const outcome = await mutate(matter);
    if (outcome !== ABORT) saveMatter(matter);
    return matter;
  });
}

// Reader and editor notes
export function getNotes(): Notes | null {
  return readJSON<Notes>(mcpPath("notes.json"));
}

export function saveNotes(notes: Notes): void {
  writeJSON(mcpPath("notes.json"), notes);
}

/** Amends the notes, creating the file on first use. */
export function updateNotes(
  mutate: (notes: Notes) => unknown | Promise<unknown>
): Promise<Notes> {
  return withFileLock(mcpPath("notes.json"), async () => {
    const notes = getNotes() ?? { notes: [] };
    const outcome = await mutate(notes);
    if (outcome !== ABORT) saveNotes(notes);
    return notes;
  });
}

// AI content disclosure
export function getAiDisclosure(): AiDisclosure | null {
  return readJSON<AiDisclosure>(mcpPath("ai-disclosure.json"));
}

export function saveAiDisclosure(disclosure: AiDisclosure): void {
  writeJSON(mcpPath("ai-disclosure.json"), disclosure);
}

export function writeAiDisclosure(disclosure: AiDisclosure): Promise<void> {
  return withFileLock(mcpPath("ai-disclosure.json"), () =>
    saveAiDisclosure(disclosure)
  );
}

// Style Guide
export function getStyleGuide(): StyleGuide | null {
  return readJSON<StyleGuide>(mcpPath("style-guide.json"));
}

export function saveStyleGuide(guide: StyleGuide): void {
  writeJSON(mcpPath("style-guide.json"), guide);
}

// Outline
export function getOutline(): Outline | null {
  return readJSON<Outline>(mcpPath("outline.json"));
}

export function saveOutline(outline: Outline): void {
  writeJSON(mcpPath("outline.json"), outline);
}

// Cover Spec
export function getCoverSpec(): CoverSpec | null {
  return readJSON<CoverSpec>(mcpPath("cover-spec.json"));
}

export function saveCoverSpec(spec: CoverSpec): void {
  writeJSON(mcpPath("cover-spec.json"), spec);
}

// Author Profile
export function getAuthorProfile(): AuthorProfile | null {
  return readJSON<AuthorProfile>(mcpPath("author-profile.json"));
}

export function saveAuthorProfile(profile: AuthorProfile): void {
  writeJSON(mcpPath("author-profile.json"), profile);
}

// Read-modify-write transactions
//
// Each helper below hands a document to `mutate`, then writes it back, with
// the file locked for the whole span. That span is the part that matters: the
// read and the write are individually atomic already, but a handler that
// yields between them lets a second call start from the same state and lose
// one of the two changes. Anything that changes one of these files should go
// through the matching helper rather than calling get*/save* in sequence.
//
// `mutate` may be async. Returning `false` from it abandons the transaction
// without writing, which is how a no-op update avoids touching the file.
//
// Nesting is allowed in one direction only: registry -> outline, which is what
// a chapter rename needs. Taking them the other way round would deadlock, so
// no outline helper may reach for the registry.

const ABORT = false;

async function transact<T>(
  filePath: string,
  load: () => T | null,
  save: (value: T) => void,
  missingMessage: string,
  mutate: (value: T) => unknown | Promise<unknown>
): Promise<T> {
  return withFileLock(filePath, async () => {
    const value = load();
    if (!value) throw new BookMCPError(missingMessage);
    const outcome = await mutate(value);
    if (outcome !== ABORT) save(value);
    return value;
  });
}

export function updateRegistry(
  mutate: (registry: Registry) => unknown | Promise<unknown>
): Promise<Registry> {
  return transact(
    mcpPath("registry.json"),
    getRegistry,
    saveRegistry,
    "No book project found. Run book_init first.",
    async (registry) => {
      // A registry counted by an older word counter is recounted as part of
      // its next write, so figures from the two counters are never mixed.
      const recounted = recountIfStale(registry);
      const outcome = await mutate(registry);
      return outcome === ABORT && recounted ? undefined : outcome;
    }
  );
}

function recountIfStale(registry: Registry): boolean {
  if (registry.countVersion === WORD_COUNT_VERSION) return false;
  for (const chapter of registry.chapters) {
    chapter.wordCount = countWords(readChapterFile(chapter.filename));
  }
  registry.countVersion = WORD_COUNT_VERSION;
  return true;
}

export function updateStoryBible(
  mutate: (bible: StoryBible) => unknown | Promise<unknown>
): Promise<StoryBible> {
  return transact(
    mcpPath("story-bible.json"),
    getStoryBible,
    saveStoryBible,
    "No story bible found. Run book_init first.",
    mutate
  );
}

export function updateStyleGuide(
  mutate: (guide: StyleGuide) => unknown | Promise<unknown>
): Promise<StyleGuide> {
  return transact(
    mcpPath("style-guide.json"),
    getStyleGuide,
    saveStyleGuide,
    "No style guide found. Use book_style_set to create one.",
    mutate
  );
}

export function updateOutline(
  mutate: (outline: Outline) => unknown | Promise<unknown>
): Promise<Outline> {
  return transact(
    mcpPath("outline.json"),
    getOutline,
    saveOutline,
    "No outline found. Run book_init first.",
    mutate
  );
}

/**
 * Amends the outline only when the project has one, reporting whether it
 * wrote. A chapter rename needs this: an outline is optional, and a rename
 * that matches nothing in it should not rewrite the file.
 *
 * Returning `false` from `mutate` abandons the write.
 */
export function updateOutlineIfPresent(
  mutate: (outline: Outline) => unknown | Promise<unknown>
): Promise<boolean> {
  return withFileLock(mcpPath("outline.json"), async () => {
    const outline = getOutline();
    if (!outline) return false;
    const outcome = await mutate(outline);
    if (outcome === ABORT) return false;
    saveOutline(outline);
    return true;
  });
}

export function updateCoverSpec(
  mutate: (spec: CoverSpec) => unknown | Promise<unknown>
): Promise<CoverSpec> {
  return transact(
    mcpPath("cover-spec.json"),
    getCoverSpec,
    saveCoverSpec,
    "No cover spec found. Run book_cover_create_spec first.",
    mutate
  );
}

export function updateAuthorProfile(
  mutate: (profile: AuthorProfile) => unknown | Promise<unknown>
): Promise<AuthorProfile> {
  return transact(
    mcpPath("author-profile.json"),
    getAuthorProfile,
    saveAuthorProfile,
    "No author profile found. Run book_author_from_linkedin or book_author_update_profile first.",
    mutate
  );
}

/**
 * Replaces a whole document under its lock, for the tools that write a file
 * outright instead of amending it (book_style_set, book_outline_set, a first
 * cover spec or author profile).
 */
export function writeStyleGuide(guide: StyleGuide): Promise<void> {
  return withFileLock(mcpPath("style-guide.json"), () => saveStyleGuide(guide));
}

export function writeOutline(outline: Outline): Promise<void> {
  return withFileLock(mcpPath("outline.json"), () => saveOutline(outline));
}

export function writeCoverSpec(spec: CoverSpec): Promise<void> {
  return withFileLock(mcpPath("cover-spec.json"), () => saveCoverSpec(spec));
}

export function writeAuthorProfile(profile: AuthorProfile): Promise<void> {
  return withFileLock(mcpPath("author-profile.json"), () => saveAuthorProfile(profile));
}

/**
 * Amends the author profile, creating it first when the project has none.
 * book_author_update_profile needs this because it doubles as the tool that
 * establishes the profile, which updateAuthorProfile cannot do.
 */
export function upsertAuthorProfile(
  create: () => AuthorProfile,
  mutate: (profile: AuthorProfile) => unknown | Promise<unknown>
): Promise<AuthorProfile> {
  return withFileLock(mcpPath("author-profile.json"), async () => {
    const profile = getAuthorProfile() ?? create();
    await mutate(profile);
    saveAuthorProfile(profile);
    return profile;
  });
}

export function writeStoryBible(bible: StoryBible): Promise<void> {
  return withFileLock(mcpPath("story-bible.json"), () => saveStoryBible(bible));
}

export function getProjectPaths() {
  return {
    projectDir: getProjectDir(),
    mcpDir: mcpPath(),
    chaptersDir: chaptersPath(),
    trashDir: mcpPath(TRASH_DIR),
    registryPath: mcpPath("registry.json"),
    storyBiblePath: mcpPath("story-bible.json"),
    styleGuidePath: mcpPath("style-guide.json"),
    outlinePath: mcpPath("outline.json"),
    coverSpecPath: mcpPath("cover-spec.json"),
    authorProfilePath: mcpPath("author-profile.json"),
    timelinePath: mcpPath(TIMELINE_FILE),
    aiDisclosurePath: mcpPath("ai-disclosure.json"),
    writingLogPath: mcpPath("writing-log.json"),
    metadataPath: mcpPath("metadata.json"),
    matterPath: mcpPath("matter.json"),
    notesPath: mcpPath("notes.json"),
  };
}
