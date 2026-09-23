import * as fs from "fs";
import * as path from "path";
import { getProjectPaths, readChapterFile } from "./filestore";
import { toNFC } from "../utils/text";
import { BookMCPError } from "../utils/errors";

const HISTORY_DIR = "history";

// Twenty revisions is enough to walk back through a working session without
// letting a heavily edited chapter fill the project directory.
export const MAX_SNAPSHOTS_PER_CHAPTER = 20;

// ":" is not allowed in a Windows filename and "." would confuse the ".md"
// suffix, so an ISO timestamp is stored with both replaced. The result still
// sorts chronologically as a plain string, which is what the pruning and the
// listing rely on.
function timestampFor(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

// A chapter id reaches this module from tool input, so it is never allowed to
// escape the history directory.
function assertSafeSegment(value: string, what: string): void {
  if (!value || value.includes("/") || value.includes("\\") || value.includes("..")) {
    throw new BookMCPError(`Invalid ${what}: "${value}".`);
  }
}

export function historyDir(chapterId: string): string {
  assertSafeSegment(chapterId, "chapter id");
  return path.join(getProjectPaths().mcpDir, HISTORY_DIR, chapterId);
}

export function snapshotPath(chapterId: string, timestamp: string): string {
  assertSafeSegment(timestamp, "snapshot timestamp");
  return path.join(historyDir(chapterId), `${timestamp}.md`);
}

export interface SnapshotMeta {
  timestamp: string;
  path: string;
  bytes: number;
  savedAt: string;
}

/** Snapshot timestamps for one chapter, newest first. */
export function listSnapshots(chapterId: string): SnapshotMeta[] {
  const dir = historyDir(chapterId);
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => {
      const timestamp = name.slice(0, -3);
      const full = path.join(dir, name);
      return {
        timestamp,
        path: full,
        bytes: fs.statSync(full).size,
        savedAt: readableTimestamp(timestamp),
      };
    })
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

// Turns "2026-09-22T14-30-00-000Z" back into a real ISO string for display.
export function readableTimestamp(timestamp: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(timestamp);
  if (!match) return timestamp;
  return `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
}

export function readSnapshot(chapterId: string, timestamp: string): string {
  const file = snapshotPath(chapterId, timestamp);
  if (!fs.existsSync(file)) {
    const available = listSnapshots(chapterId);
    throw new BookMCPError(
      `No snapshot "${timestamp}" for chapter "${chapterId}". ${
        available.length
          ? `Available: ${available.map((s) => s.timestamp).join(", ")}`
          : "This chapter has no history yet."
      }`
    );
  }
  return fs.readFileSync(file, "utf-8");
}

/**
 * Stores `content` as the newest snapshot of a chapter and prunes the oldest
 * beyond MAX_SNAPSHOTS_PER_CHAPTER. Returns the timestamp it was filed under.
 */
export function saveSnapshot(chapterId: string, content: string): string {
  const dir = historyDir(chapterId);
  fs.mkdirSync(dir, { recursive: true });

  // Two updates inside the same millisecond would otherwise overwrite each
  // other, losing the revision in between.
  let timestamp = timestampFor(new Date());
  let counter = 1;
  while (fs.existsSync(path.join(dir, `${timestamp}.md`))) {
    timestamp = `${timestampFor(new Date())}-${counter++}`;
  }

  const target = path.join(dir, `${timestamp}.md`);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, toNFC(content), "utf-8");
  fs.renameSync(tmp, target);

  pruneSnapshots(chapterId);
  return timestamp;
}

/** Drops the oldest snapshots past the cap. Returns the timestamps removed. */
export function pruneSnapshots(chapterId: string): string[] {
  const snapshots = listSnapshots(chapterId); // newest first
  if (snapshots.length <= MAX_SNAPSHOTS_PER_CHAPTER) return [];

  const excess = snapshots.slice(MAX_SNAPSHOTS_PER_CHAPTER);
  for (const snapshot of excess) {
    fs.rmSync(snapshot.path, { force: true });
  }
  return excess.map((s) => s.timestamp);
}

/**
 * Snapshots a chapter's current file content, unless there is nothing worth
 * keeping — an unwritten chapter, or an edit that leaves the prose unchanged.
 */
export function snapshotIfChanged(
  chapterId: string,
  filename: string,
  nextContent: string
): string | null {
  const current = readChapterFile(filename);
  if (!current) return null;
  if (toNFC(current) === toNFC(nextContent)) return null;
  return saveSnapshot(chapterId, current);
}

/**
 * Moves a chapter's history aside when the chapter is deleted, mirroring what
 * trashChapterFile does with the prose: nothing an author wrote is unlinked.
 *
 * This also has to happen because chapter ids can be handed out twice. The
 * next id is derived from the highest id still in the registry, so deleting
 * the last chapter frees its id for the next one created — and a new chapter
 * must not inherit the deleted chapter's revisions.
 *
 * Returns the trash path and how many snapshots moved with it.
 */
export function trashHistory(chapterId: string): { path: string; count: number } | null {
  const dir = historyDir(chapterId);
  if (!fs.existsSync(dir)) return null;

  const count = listSnapshots(chapterId).length;
  const trashDir = path.join(getProjectPaths().trashDir);
  fs.mkdirSync(trashDir, { recursive: true });

  const stamp = timestampFor(new Date());
  let target = path.join(trashDir, `${stamp}-history-${chapterId}`);
  let counter = 1;
  while (fs.existsSync(target)) {
    target = path.join(trashDir, `${stamp}-${counter++}-history-${chapterId}`);
  }
  fs.renameSync(dir, target);
  return { path: target, count };
}
