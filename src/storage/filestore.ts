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
} from "./schema";
import { BookMCPError } from "../utils/errors";
import { toNFC } from "../utils/text";

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
  targetWordCount: number
): Registry {
  ensureDir(mcpPath());
  ensureDir(chaptersPath());

  const registry: Registry = {
    title,
    author,
    genre,
    targetWordCount,
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
    timeline: [],
  };
  saveStoryBible(bible);

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
  };
}
