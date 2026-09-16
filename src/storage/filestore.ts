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

const MCP_DIR = ".book-mcp";
const CHAPTERS_DIR = "chapters";

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
function writeFileAtomic(filePath: string, data: string): void {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmpPath, data, "utf-8");
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
    registryPath: mcpPath("registry.json"),
    storyBiblePath: mcpPath("story-bible.json"),
    styleGuidePath: mcpPath("style-guide.json"),
    outlinePath: mcpPath("outline.json"),
    coverSpecPath: mcpPath("cover-spec.json"),
    authorProfilePath: mcpPath("author-profile.json"),
  };
}
