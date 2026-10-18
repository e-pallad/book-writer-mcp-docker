// Every id the project files hold that points at something else — a chapter, a
// character, a setting — and whether the thing is still there. Ids are plain
// strings in JSON, so nothing stops one from outliving its target; this is the
// pass that finds them. Pure: the tool hands it a snapshot of the project.

import {
  Notes,
  Outline,
  Registry,
  Research,
  Scenes,
  StoryBible,
  Timeline,
} from "../storage/schema";
import { normalizeForCompare } from "../utils/text";

export type LinkIssueKind =
  | "missing_chapter" // points at a chapter that was deleted
  | "unresolved_chapter" // points at something that never was a chapter id
  | "missing_character"
  | "missing_setting"
  | "id_reused" // a live chapter carries the id of a deleted one
  | "duplicate_id"
  | "duplicate_order"
  | "missing_file"
  | "double_link" // two outline entries claim one chapter
  | "ambiguous_name"
  | "lost_scene";

export interface LinkIssue {
  severity: "error" | "warning";
  kind: LinkIssueKind;
  /** The record that holds the reference. */
  from: { type: string; id: string; label: string; field: string };
  /** What it points at. */
  to?: { type: "chapter" | "character" | "setting"; id: string };
  /** The chapter the issue concerns, for filtering. */
  chapterId?: string;
  problem: string;
  suggestion: string;
  /**
   * The tool call that repairs it, when there is one. `choose` names the
   * argument whose value only the author (or a look at the book) can supply —
   * the check never guesses which chapter a dangling reference was meant for.
   */
  repair?: { tool: string; args: Record<string, unknown>; choose?: string };
}

export interface LinkSnapshot {
  registry: Registry;
  bible: StoryBible;
  timeline: Timeline | null;
  outline: Outline | null;
  notes: Notes | null;
  scenes: Scenes | null;
  research: Research | null;
  fileExists: (filename: string) => boolean;
  /** Ids of chapters deleted earlier, from the trash. */
  trashed: { id: string; file: string }[];
  /** Scene metadata whose scene can no longer be found in its chapter. */
  lostScenes: { chapterId: string; anchor: string }[];
}

export interface LinkReport {
  issues: LinkIssue[];
  /** How many references were examined. */
  references: number;
  errors: number;
  warnings: number;
}

interface Ref {
  from: LinkIssue["from"];
  type: "chapter" | "character" | "setting";
  id: string;
  /** Where in the chapter the holder sits, when it sits in one. */
  inChapter?: string;
  repair?: (id: string) => LinkIssue["repair"];
}

function numberOf(id: string): number | null {
  const match = /^ch-(\d+)$/.exec(id);
  return match ? parseInt(match[1], 10) : null;
}

export function checkLinks(snapshot: LinkSnapshot): LinkReport {
  const { registry, bible, timeline, outline, notes, scenes, research } = snapshot;
  const issues: LinkIssue[] = [];

  const chapterIds = new Set(registry.chapters.map((c) => c.id));
  const characterIds = new Set(bible.characters.map((c) => c.id));
  const settingIds = new Set(bible.settings.map((s) => s.id));
  const trashedIds = new Set(snapshot.trashed.map((t) => t.id));
  const counter = registry.nextChapterNumber ?? 0;

  // ------------------------------------------------------------------------
  // Registry
  const seenIds = new Map<string, number>();
  const seenOrders = new Map<number, string[]>();
  for (const chapter of registry.chapters) {
    seenIds.set(chapter.id, (seenIds.get(chapter.id) ?? 0) + 1);
    seenOrders.set(chapter.order, [...(seenOrders.get(chapter.order) ?? []), chapter.id]);
    if (!snapshot.fileExists(chapter.filename)) {
      issues.push({
        severity: "error",
        kind: "missing_file",
        from: { type: "chapter", id: chapter.id, label: chapter.title, field: "filename" },
        chapterId: chapter.id,
        problem: `Chapter ${chapter.id} ("${chapter.title}") is registered, but chapters/${chapter.filename} does not exist.`,
        suggestion:
          "Restore the file from .book-mcp/trash or chapter history, or delete the registry entry with book_chapter_delete (keepFile=true).",
      });
    }
  }
  for (const [id, count] of seenIds) {
    if (count > 1) {
      issues.push({
        severity: "error",
        kind: "duplicate_id",
        from: { type: "chapter", id, label: id, field: "id" },
        chapterId: id,
        problem: `${count} chapters share the id "${id}", so every reference to it is ambiguous.`,
        suggestion: "Repair .book-mcp/registry.json by hand: give each chapter its own id.",
      });
    }
  }
  for (const [order, ids] of seenOrders) {
    if (ids.length > 1) {
      issues.push({
        severity: "warning",
        kind: "duplicate_order",
        from: { type: "chapter", id: ids[0], label: ids.join(", "), field: "order" },
        chapterId: ids[0],
        problem: `Chapters ${ids.join(", ")} all sit at position ${order}; their reading order is undefined.`,
        suggestion: "Settle the order with book_chapter_reorder.",
      });
    }
  }

  // ------------------------------------------------------------------------
  // The references themselves
  const refs: Ref[] = [];
  const chapterRef = (
    from: LinkIssue["from"],
    id: string | undefined,
    repair?: Ref["repair"],
    inChapter?: string
  ) => {
    if (id && id.trim()) refs.push({ from, type: "chapter", id: id.trim(), repair, inChapter });
  };

  for (const character of bible.characters) {
    const at = (field: string) => ({ type: "character", id: character.id, label: character.name, field });
    chapterRef(at("firstAppearance"), character.firstAppearance, () => ({
      tool: "book_character_update",
      args: { characterId: character.id },
      choose: "updates.firstAppearance",
    }));
    for (const milestone of character.arc?.milestones ?? []) {
      chapterRef(at("arc.milestones"), milestone.chapterId, () => ({
        tool: "book_character_update",
        args: { characterId: character.id },
        choose: "updates.arc",
      }));
    }
    for (const relation of character.relationships ?? []) {
      refs.push({
        from: at("relationships"),
        type: "character",
        id: relation.characterId,
        repair: () => ({
          tool: "book_character_update",
          args: { characterId: character.id },
          choose: "updates.relationships",
        }),
      });
    }
  }

  for (const thread of bible.plotThreads) {
    const at = (field: string) => ({ type: "plot_thread", id: thread.id, label: thread.title, field });
    const fix = (field: string): Ref["repair"] => () => ({
      tool: "book_plot_thread_update",
      args: { threadId: thread.id },
      choose: field,
    });
    chapterRef(at("openedIn"), thread.openedIn, fix("openedIn"));
    chapterRef(at("resolvedIn"), thread.resolvedIn, fix("resolvedIn"));
    for (const touch of thread.touches ?? []) chapterRef(at("touches"), touch.chapterId);
  }

  for (const event of timeline?.events ?? []) {
    const at = (field: string) => ({
      type: "timeline_event",
      id: event.id,
      label: event.event,
      field,
    });
    chapterRef(at("chapterId"), event.chapterId, () => ({
      tool: "book_timeline_update",
      args: { eventId: event.id },
      choose: "chapterId",
    }));
    for (const characterId of event.characterIds ?? []) {
      refs.push({
        from: at("characterIds"),
        type: "character",
        id: characterId,
        repair: () => ({
          tool: "book_timeline_update",
          args: { eventId: event.id },
          choose: "characterIds",
        }),
      });
    }
  }

  for (const meta of scenes?.scenes ?? []) {
    const at = (field: string) => ({
      type: "scene",
      id: `${meta.chapterId}#${meta.indexHint}`,
      label: `scene ${meta.indexHint} of ${meta.chapterId}`,
      field,
    });
    chapterRef(at("chapterId"), meta.chapterId);
    if (meta.pov) {
      refs.push({
        from: at("pov"),
        type: "character",
        id: meta.pov,
        inChapter: meta.chapterId,
        repair: () => ({
          tool: "book_scene_set",
          args: { chapterId: meta.chapterId, scene: meta.indexHint },
          choose: "pov",
        }),
      });
    }
    if (meta.settingId) {
      refs.push({
        from: at("settingId"),
        type: "setting",
        id: meta.settingId,
        inChapter: meta.chapterId,
        repair: () => ({
          tool: "book_scene_set",
          args: { chapterId: meta.chapterId, scene: meta.indexHint },
          choose: "setting",
        }),
      });
    }
  }

  for (const note of notes?.notes ?? []) {
    chapterRef(
      { type: "note", id: note.id, label: note.text.slice(0, 40), field: "chapterId" },
      note.chapterId
    );
  }

  for (const entry of research?.entries ?? []) {
    for (const chapterId of entry.chapterIds) {
      chapterRef(
        { type: "research", id: entry.id, label: entry.title, field: "chapterIds" },
        chapterId,
        () => ({ tool: "book_research_update", args: { id: entry.id }, choose: "chapters" })
      );
    }
  }

  const claimed = new Map<string, string[]>();
  for (const act of outline?.acts ?? []) {
    for (const entry of act.chapters) {
      if (!entry.chapterId) continue;
      claimed.set(entry.chapterId, [...(claimed.get(entry.chapterId) ?? []), entry.title]);
      chapterRef(
        { type: "outline_entry", id: entry.title, label: entry.title, field: "chapterId" },
        entry.chapterId,
        () => ({
          tool: "book_outline_update_chapter",
          args: { chapterTitle: entry.title },
          choose: "linkTo",
        })
      );
    }
  }
  for (const [chapterId, titles] of claimed) {
    if (titles.length > 1 && chapterIds.has(chapterId)) {
      issues.push({
        severity: "warning",
        kind: "double_link",
        from: { type: "outline_entry", id: titles[0], label: titles.join(" / "), field: "chapterId" },
        to: { type: "chapter", id: chapterId },
        chapterId,
        problem: `Outline entries ${titles.map((t) => `"${t}"`).join(" and ")} are both linked to ${chapterId}.`,
        suggestion: "One of them stands for a different chapter. Relink it with book_outline_link.",
      });
    }
  }

  for (const placement of outline?.structure?.beats ?? []) {
    chapterRef(
      { type: "structure_beat", id: placement.beat, label: placement.beat, field: "chapterId" },
      placement.chapterId,
      () => ({ tool: "book_beat_set", args: { beat: placement.beat }, choose: "chapterId" })
    );
  }

  // ------------------------------------------------------------------------
  // Resolve them
  const byChapter = new Map<string, Ref[]>();
  for (const ref of refs) {
    if (ref.type === "chapter") {
      byChapter.set(ref.id, [...(byChapter.get(ref.id) ?? []), ref]);
      if (chapterIds.has(ref.id)) continue;

      const wasReal = trashedIds.has(ref.id) || (numberOf(ref.id) ?? Infinity) < counter;
      const idLike = numberOf(ref.id) !== null;
      issues.push({
        severity: idLike && wasReal ? "error" : "warning",
        kind: idLike && wasReal ? "missing_chapter" : "unresolved_chapter",
        from: ref.from,
        to: { type: "chapter", id: ref.id },
        chapterId: ref.id,
        problem:
          idLike && wasReal
            ? `${describe(ref.from)} points at ${ref.id}, which was deleted.`
            : `${describe(ref.from)} points at "${ref.id}", which is not a chapter in this book${
                idLike ? " (not created yet)" : " (a title or other text, not a chapter id)"
              }.`,
        suggestion: ref.repair
          ? `Point it at the right chapter with ${ref.repair(ref.id)!.tool}, or clear it.`
          : "Delete or re-file it; there is no tool to retarget it.",
        ...(ref.repair ? { repair: ref.repair(ref.id) } : {}),
      });
    } else if (ref.type === "character") {
      if (characterIds.has(ref.id)) continue;
      issues.push({
        severity: "error",
        kind: "missing_character",
        from: ref.from,
        to: { type: "character", id: ref.id },
        ...(ref.inChapter ? { chapterId: ref.inChapter } : {}),
        problem: `${describe(ref.from)} points at character "${ref.id}", who is not in the story bible.`,
        suggestion: "Re-add the character with book_character_add, or point the reference at someone else.",
        ...(ref.repair ? { repair: ref.repair(ref.id) } : {}),
      });
    } else {
      if (settingIds.has(ref.id)) continue;
      issues.push({
        severity: "error",
        kind: "missing_setting",
        from: ref.from,
        to: { type: "setting", id: ref.id },
        ...(ref.inChapter ? { chapterId: ref.inChapter } : {}),
        problem: `${describe(ref.from)} points at setting "${ref.id}", which is not in the story bible.`,
        suggestion: "Re-add the setting with book_setting_add, or set the scene's setting again.",
        ...(ref.repair ? { repair: ref.repair(ref.id) } : {}),
      });
    }
  }

  // A live chapter wearing the id of a deleted one: whatever was written
  // before the deletion points at the wrong chapter now, and nothing above can
  // tell. Reported with everything that points at it, to be checked by eye.
  for (const { id, file } of snapshot.trashed) {
    const live = registry.chapters.find((c) => c.id === id);
    if (!live || issues.some((i) => i.kind === "id_reused" && i.to?.id === id)) continue;
    const holders = byChapter.get(id) ?? [];
    issues.push({
      severity: "warning",
      kind: "id_reused",
      from: { type: "chapter", id, label: live.title, field: "id" },
      to: { type: "chapter", id },
      chapterId: id,
      problem: `${id} ("${live.title}") reuses the id of a chapter deleted earlier (.book-mcp/trash/${file}). ${
        holders.length
          ? `${holders.length} reference(s) to ${id} may have been made for the deleted chapter: ${holders
              .slice(0, 8)
              .map((h) => describe(h.from))
              .join("; ")}${holders.length > 8 ? "; …" : ""}.`
          : "Nothing points at it, so nothing is misdirected."
      }`,
      suggestion: holders.length
        ? `Read each one and compare it with "${live.title}". Where it was meant for the deleted chapter, retarget or clear it. New chapters no longer reuse ids.`
        : "Nothing to do. New chapters no longer reuse ids.",
    });
  }

  // ------------------------------------------------------------------------
  // The story bible's own ids and names
  const dupes = (items: { id: string }[], type: string, label: (i: never) => string) => {
    const counts = new Map<string, number>();
    for (const item of items) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
    for (const [id, count] of counts) {
      if (count < 2) continue;
      const first = items.find((i) => i.id === id)!;
      issues.push({
        severity: "error",
        kind: "duplicate_id",
        from: { type, id, label: label(first as never), field: "id" },
        problem: `${count} ${type}s share the id "${id}"; an update by id changes whichever comes first.`,
        suggestion: "Repair .book-mcp/story-bible.json by hand: give each its own id.",
      });
    }
  };
  dupes(bible.characters, "character", (c: { name: string }) => c.name);
  dupes(bible.settings, "setting", (s: { name: string }) => s.name);
  dupes(bible.plotThreads, "plot_thread", (t: { title: string }) => t.title);

  const owners = new Map<string, Set<string>>();
  for (const character of bible.characters) {
    for (const name of [character.name, ...character.aliases]) {
      const key = normalizeForCompare(name.trim());
      if (!key) continue;
      owners.set(key, (owners.get(key) ?? new Set()).add(character.id));
    }
  }
  for (const [key, ids] of owners) {
    if (ids.size < 2) continue;
    const names = [...ids].map((id) => bible.characters.find((c) => c.id === id)!.name);
    issues.push({
      severity: "warning",
      kind: "ambiguous_name",
      from: { type: "character", id: [...ids][0], label: names.join(" / "), field: "name/aliases" },
      problem: `"${key}" is a name or alias of ${names.join(" and ")}. A reference by that name cannot tell them apart, and the continuity check attributes the character's traits to both.`,
      suggestion: "Remove the alias from one of them with book_character_update, or use ids when you refer to them.",
    });
  }

  for (const lost of snapshot.lostScenes) {
    issues.push({
      severity: "warning",
      kind: "lost_scene",
      from: { type: "scene", id: `${lost.chapterId}`, label: `"${lost.anchor}"`, field: "anchor" },
      to: { type: "chapter", id: lost.chapterId },
      chapterId: lost.chapterId,
      problem: `Scene metadata for ${lost.chapterId} anchored at "${lost.anchor}" no longer matches any scene: the opening was rewritten or the scene cut.`,
      suggestion: "Set the scene's metadata again with book_scene_set, or let it go when the scene is gone.",
    });
  }

  issues.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
  return {
    issues,
    references: refs.length,
    errors: issues.filter((i) => i.severity === "error").length,
    warnings: issues.filter((i) => i.severity === "warning").length,
  };
}

function describe(from: LinkIssue["from"]): string {
  return `${from.type.replace(/_/g, " ")} "${from.label}" (${from.field})`;
}
