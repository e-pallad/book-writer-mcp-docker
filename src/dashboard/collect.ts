import {
  getRegistry,
  getStoryBible,
  getStyleGuide,
  getTimeline,
  getCoverSpec,
  getAuthorProfile,
  getAiDisclosure,
  getWritingLog,
  readChapterFile,
} from "../storage/filestore";
import { dayKey, projectTimeZone } from "../storage/writing-log";
import { totalsByDay } from "../storage/progress";
import { listSnapshots, readSnapshot } from "../storage/history";
import { Character, ChapterMeta, Registry } from "../storage/schema";
import { diffStats } from "../utils/diff";
import { countWords, estimateReadingTime, WORD_COUNT_VERSION } from "../utils/wordcount";
import { wholeWordRegExp } from "../utils/text";
import { BookMCPError } from "../utils/errors";
import { lastCarried } from "../tools/continuity-rules";
import {
  ChapterRow,
  DashboardData,
  HealthFinding,
  PresenceMatrix,
  ReadinessItem,
  TimelineMap,
  TimelinePoint,
  Velocity,
  VelocityPoint,
} from "./model";

const DAY_MS = 24 * 60 * 60 * 1000;

function daysBetween(from: string, to: Date): number {
  const parsed = Date.parse(from);
  if (Number.isNaN(parsed)) return 0;
  return Math.max(0, Math.floor((to.getTime() - parsed) / DAY_MS));
}

/** Every name a character answers to, longest first so aliases can't be double counted. */
function namesOf(character: Character): string[] {
  return [character.name, ...character.aliases]
    .map((n) => n.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
}

function countMentions(text: string, character: Character): number {
  let remaining = text.normalize("NFC");
  let total = 0;

  for (const name of namesOf(character)) {
    const pattern = wholeWordRegExp(name, "giu");
    const matches = remaining.match(pattern);
    if (!matches) continue;
    total += matches.length;
    // Blank out what matched so "Mara" inside "Mara Vance" is not counted twice.
    remaining = remaining.replace(pattern, " ");
  }

  return total;
}

function buildPresence(
  chapters: ChapterMeta[],
  characters: Character[],
  texts: Map<string, string>
): PresenceMatrix {
  const counts = characters.map((character) =>
    chapters.map((chapter) => countMentions(texts.get(chapter.id) ?? "", character))
  );

  const totals = counts.map((row) => row.reduce((sum, n) => sum + n, 0));
  const maxCount = counts.reduce(
    (max, row) => Math.max(max, ...row, 0),
    0
  );

  const absent = characters
    .filter((_, index) => totals[index] === 0)
    .map((character) => character.name);

  // A character who appears, disappears for a stretch, then comes back. The
  // run has to be bounded on both sides by an appearance, or every character
  // who simply has not entered yet would be reported.
  const gaps: PresenceMatrix["gaps"] = [];
  counts.forEach((row, characterIndex) => {
    const present = row
      .map((n, index) => (n > 0 ? index : -1))
      .filter((index) => index >= 0);
    if (present.length < 2) return;

    for (let i = 1; i < present.length; i++) {
      const missed = present[i] - present[i - 1] - 1;
      if (missed >= 3) {
        gaps.push({
          character: characters[characterIndex].name,
          afterChapter: chapters[present[i - 1]].title,
          missedChapters: missed,
        });
      }
    }
  });

  return {
    characters: characters.map((character, index) => ({
      id: character.id,
      name: character.name,
      role: character.role,
      total: totals[index],
    })),
    chapters: chapters.map((c) => ({ id: c.id, title: c.title, order: c.order })),
    counts,
    maxCount,
    absent,
    gaps,
  };
}

function buildTimelineMap(registry: Registry, chapters: ChapterMeta[]): TimelineMap {
  const timeline = getTimeline();
  const orderOf = new Map(registry.chapters.map((c) => [c.id, c.order]));

  const events = timeline?.events ?? [];
  const placed = events
    .filter((e) => e.sortKey?.trim())
    .sort((a, b) => a.sortKey!.trim().localeCompare(b.sortKey!.trim()));
  const rankOf = new Map(placed.map((event, index) => [event.id, index + 1]));

  // A contradiction is an event that sits earlier in story time than one
  // logged in an earlier chapter — the same rule book_continuity_check uses,
  // applied across the whole book at once.
  const contradicting = new Set<string>();
  for (const a of placed) {
    for (const b of placed) {
      if (a.id === b.id) continue;
      const aOrder = a.chapterId ? orderOf.get(a.chapterId) : undefined;
      const bOrder = b.chapterId ? orderOf.get(b.chapterId) : undefined;
      if (aOrder === undefined || bOrder === undefined) continue;
      if (aOrder > bOrder && a.sortKey!.localeCompare(b.sortKey!) < 0) {
        contradicting.add(a.id);
      }
    }
  }

  const points: TimelinePoint[] = events.map((event) => ({
    id: event.id,
    event: event.event,
    inStoryTime: event.inStoryTime,
    sortKey: event.sortKey?.trim() || null,
    chapterId: event.chapterId ?? null,
    chapterOrder: event.chapterId ? orderOf.get(event.chapterId) ?? null : null,
    storyRank: rankOf.get(event.id) ?? null,
    contradiction: contradicting.has(event.id),
  }));

  const chaptersWithEvents = new Set(
    events.map((e) => e.chapterId).filter(Boolean) as string[]
  );

  return {
    points,
    unplaced: events.filter((e) => !e.sortKey?.trim()).length,
    contradictions: contradicting.size,
    chaptersWithoutEvents: chapters
      .filter((c) => !chaptersWithEvents.has(c.id))
      .map((c) => ({ id: c.id, title: c.title })),
  };
}

/**
 * Reconstructs the manuscript's word count over time from the retained
 * snapshots.
 *
 * A snapshot holds the text as it was *before* the edit that created it, so a
 * chapter's word count at time t is the word count of the first snapshot taken
 * after t — and the current text once the snapshots run out.
 */
/**
 * The manuscript's word count over time from the writing log, when it covers
 * at least two days. Exact for every change made through the tools since the
 * log began — unlike the snapshot reconstruction below, which only sees
 * prose changes and forgets all but the last 20 per chapter.
 */
function velocityFromLog(registry: Registry, totalWords: number, now: Date): Velocity | null {
  const log = getWritingLog();
  if (!log) return null;
  const days = Object.keys(log.days).sort();
  if (days.length < 2) return null;

  const points = totalsByDay(log, totalWords).map((p) => ({
    at: `${p.date}T12:00:00.000Z`,
    totalWords: p.totalWords,
  }));
  const today = dayKey(now, projectTimeZone(registry));
  if (days[days.length - 1] < today) {
    points.push({ at: `${today}T12:00:00.000Z`, totalWords });
  }

  const first = days[0];
  const startTotal = points[0].totalWords - (log.days[first].added - log.days[first].removed);
  const span = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / DAY_MS) + 1;
  return {
    series: points,
    wordsPerDay: span > 0 ? Math.round((totalWords - startTotal) / span) : null,
    daysCovered: span,
    projectedFinish: null, // filled in by the caller, which knows the target
    coverage: `From the writing log, which records every change to a chapter made through the tools since ${first}. Edits made to the files by hand are not in it.`,
  };
}

function buildVelocity(chapters: ChapterMeta[], texts: Map<string, string>): Velocity {
  const perChapter = new Map<string, { at: number; words: number }[]>();
  const timestamps = new Set<number>();

  for (const chapter of chapters) {
    const snapshots = listSnapshots(chapter.id)
      .map((snapshot) => ({
        // savedAt is the ISO form; the timestamp is the file-name form, with
        // its colons and dot replaced, which Date.parse cannot read. Both are
        // 24 characters, so telling them apart by length silently produced
        // NaN for every snapshot and an empty chart.
        at: Date.parse(snapshot.savedAt),
        words: countWords(readSnapshot(chapter.id, snapshot.timestamp)),
      }))
      .filter((entry) => !Number.isNaN(entry.at))
      .sort((a, b) => a.at - b.at);

    perChapter.set(chapter.id, snapshots);
    for (const snapshot of snapshots) timestamps.add(snapshot.at);
  }

  const ordered = [...timestamps].sort((a, b) => a - b);
  if (ordered.length === 0) {
    return {
      series: [],
      wordsPerDay: null,
      daysCovered: null,
      projectedFinish: null,
      coverage:
        "No saved versions yet, so there is no history to chart. A version is filed on each book_chapter_update that changes prose, and the last 20 per chapter are kept.",
    };
  }

  const now = Date.now();
  const points: VelocityPoint[] = [...ordered, now].map((at) => {
    let total = 0;
    for (const chapter of chapters) {
      const snapshots = perChapter.get(chapter.id) ?? [];
      const next = snapshots.find((snapshot) => snapshot.at > at);
      total += next ? next.words : countWords(texts.get(chapter.id) ?? "");
    }
    return { at: new Date(at).toISOString(), totalWords: total };
  });

  const first = points[0];
  const last = points[points.length - 1];
  const daysCovered = Math.max(
    (Date.parse(last.at) - Date.parse(first.at)) / DAY_MS,
    0
  );
  const gained = last.totalWords - first.totalWords;
  const wordsPerDay = daysCovered > 0.5 ? Math.round(gained / daysCovered) : null;

  return {
    series: points,
    wordsPerDay,
    daysCovered: daysCovered > 0 ? Math.round(daysCovered * 10) / 10 : 0,
    projectedFinish: null, // filled in by the caller, which knows the target
    coverage: `Reconstructed from ${ordered.length} saved version(s) spanning ${
      daysCovered < 1
        ? "under a day"
        : `${Math.round(daysCovered * 10) / 10} days`
    }. History only records content changes, keeps the last 20 versions per chapter, and starts when version tracking was added — so this is a partial record, not the project's full history.`,
  };
}

function buildHealth(
  registry: Registry,
  chapters: ChapterMeta[],
  texts: Map<string, string>,
  presence: PresenceMatrix,
  timeline: TimelineMap,
  now: Date
): HealthFinding[] {
  const findings: HealthFinding[] = [];
  const bible = getStoryBible();
  const guide = getStyleGuide();
  const lastOrder = chapters.length ? chapters[chapters.length - 1].order : 0;

  // Plot threads left open, weighted by how long they have gone uncarried —
  // named in the prose, or touched with book_plot_thread_touch.
  const lastChapter = chapters[chapters.length - 1];
  for (const thread of bible?.plotThreads ?? []) {
    if (thread.status !== "open") continue;
    const openedIn = registry.chapters.find((c) => c.id === thread.openedIn);
    const carried =
      openedIn && lastChapter
        ? lastCarried(thread, chapters, lastChapter, (c) => texts.get(c.id) ?? "")
        : null;
    const since = carried ? lastOrder - carried.order : 0;
    findings.push({
      severity: since >= 8 ? "serious" : "warning",
      area: "plot",
      summary: `Open thread: "${thread.title}"`,
      detail: !openedIn
        ? `Opened in "${thread.openedIn}", which is not in the manuscript.`
        : carried && carried.id !== openedIn.id
        ? `Opened in ${openedIn.id} ("${openedIn.title}"), last carried in ${carried.id} ("${carried.title}"), ${since} chapter(s) ago.`
        : `Opened in ${openedIn.id} ("${openedIn.title}") and not carried since, ${since} chapter(s) later.`,
    });
  }

  if (timeline.contradictions > 0) {
    findings.push({
      severity: "critical",
      area: "timeline",
      summary: `${timeline.contradictions} timeline contradiction(s)`,
      detail:
        "An event logged in a later chapter happens before one logged earlier. Either the chapter is a flashback, or a sortKey is wrong.",
    });
  }

  // Only worth raising once the timeline is actually in use. Telling an author
  // who has never logged an event that every chapter is missing one is nagging,
  // not a finding — the same reason book_continuity_check stays quiet about a
  // chapter with nothing logged against it.
  if (timeline.points.length > 0 && timeline.chaptersWithoutEvents.length) {
    findings.push({
      severity: "warning",
      area: "timeline",
      summary: `${timeline.chaptersWithoutEvents.length} chapter(s) have no timeline events`,
      detail: `Their timing is never cross-referenced: ${timeline.chaptersWithoutEvents
        .slice(0, 6)
        .map((c) => c.title)
        .join(", ")}${timeline.chaptersWithoutEvents.length > 6 ? ", …" : ""}.`,
    });
  }

  for (const gap of presence.gaps) {
    findings.push({
      severity: gap.missedChapters >= 6 ? "serious" : "warning",
      area: "pace",
      summary: `${gap.character} disappears for ${gap.missedChapters} chapters`,
      detail: `Last seen in "${gap.afterChapter}", then absent until they return.`,
    });
  }

  if (presence.absent.length) {
    findings.push({
      severity: "warning",
      area: "pace",
      summary: `${presence.absent.length} character(s) never appear`,
      detail: `In the story bible but named in no chapter: ${presence.absent.join(", ")}.`,
    });
  }

  // Characters carrying dialogue without a voice profile to check it against.
  const speakers = (bible?.characters ?? []).filter((character) => {
    if (character.voiceProfile) return false;
    const total = presence.characters.find((c) => c.id === character.id)?.total ?? 0;
    return total >= 5;
  });
  if (speakers.length) {
    findings.push({
      severity: "warning",
      area: "voice",
      summary: `${speakers.length} prominent character(s) have no voice profile`,
      detail: `book_style_check cannot judge their dialogue: ${speakers
        .map((c) => c.name)
        .join(", ")}.`,
    });
  }

  // Style guide avoidances, counted across the manuscript.
  for (const avoidance of guide?.thingsToAvoid ?? []) {
    const term = avoidance.trim();
    if (!term) continue;
    let hits = 0;
    const worst: string[] = [];
    for (const chapter of chapters) {
      const matches = (texts.get(chapter.id) ?? "")
        .normalize("NFC")
        .match(wholeWordRegExp(term));
      if (matches?.length) {
        hits += matches.length;
        worst.push(`${chapter.title} (${matches.length})`);
      }
    }
    if (hits > 0) {
      findings.push({
        severity: hits >= 5 ? "serious" : "warning",
        area: "style",
        summary: `"${term}" appears ${hits} time(s)`,
        detail: `The style guide lists it under things to avoid. In: ${worst
          .slice(0, 5)
          .join(", ")}${worst.length > 5 ? ", …" : ""}.`,
      });
    }
  }

  // Chapters that have not been touched in a while, and are not finished.
  const stale = chapters.filter(
    (chapter) => chapter.status !== "final" && daysBetween(chapter.updatedAt, now) >= 21
  );
  if (stale.length) {
    findings.push({
      severity: "warning",
      area: "pace",
      summary: `${stale.length} unfinished chapter(s) untouched for 3+ weeks`,
      detail: stale
        .map((c) => `${c.title} (${daysBetween(c.updatedAt, now)}d)`)
        .join(", "),
    });
  }

  if (findings.length === 0) {
    findings.push({
      severity: "good",
      area: "plot",
      summary: "Nothing flagged",
      detail:
        "No open threads, timeline contradictions, absent characters or style-guide breaches were found.",
    });
  }

  const rank = { critical: 0, serious: 1, warning: 2, good: 3 };
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

function buildReadiness(registry: Registry): ReadinessItem[] {
  const items: ReadinessItem[] = [];
  const spec = getCoverSpec();
  const profile = getAuthorProfile();
  const disclosure = getAiDisclosure();

  const finals = registry.chapters.filter((c) => c.status === "final").length;
  items.push({
    item: "Chapters finalised",
    state: finals === registry.chapters.length && finals > 0 ? "ready" : "needed",
    detail: `${finals} of ${registry.chapters.length} marked final.`,
  });

  items.push({
    item: "Cover spec",
    state: spec ? "ready" : "needed",
    detail: spec ? "On file." : "Run book_cover_create_spec.",
  });

  items.push({
    item: "Back cover blurb",
    state: spec?.backCover?.blurb ? "ready" : "optional",
    detail: spec?.backCover?.blurb
      ? "Written."
      : "Needed for paperback and hardcover.",
  });

  items.push({
    item: "Author profile",
    state: profile?.generatedIntro ? "ready" : "optional",
    detail: profile?.generatedIntro
      ? `Bio ready for ${profile.name}.`
      : "No author bio yet — run book_author_update_profile.",
  });

  items.push({
    item: "AI content disclosure",
    state: disclosure ? "ready" : "needed",
    detail: disclosure
      ? disclosure.disclosureRequired
        ? "Recorded — declare AI-generated content in the KDP form."
        : "Recorded — nothing to declare."
      : "Not worked out. Run book_ai_disclosure_generate.",
  });

  return items;
}

export function collectDashboard(): DashboardData {
  const registry = getRegistry();
  if (!registry)
    throw new BookMCPError("No book project found. Run book_init first.");

  const now = new Date();
  const chapters = [...registry.chapters].sort((a, b) => a.order - b.order);
  const texts = new Map(
    chapters.map((chapter) => [chapter.id, readChapterFile(chapter.filename)])
  );

  // Counted from the chapter files, not from the registry's cached figure.
  // The presence map and the style findings are read from those files, so
  // taking word counts from anywhere else lets two panels of the same
  // dashboard describe different states — which is exactly what happened when
  // a chapter was edited outside the tools and the live page showed the new
  // prose while the totals did not move.
  const liveWords = new Map(
    chapters.map((chapter) => [chapter.id, countWords(texts.get(chapter.id) ?? "")])
  );
  const totalWords = chapters.reduce(
    (sum, chapter) => sum + (liveWords.get(chapter.id) ?? 0),
    0
  );
  // A registry counted by the older word counter differs everywhere for that
  // reason alone, and is recounted on its next write; only a current one says
  // anything about edits made outside the tools.
  const staleCounts =
    registry.countVersion === WORD_COUNT_VERSION
      ? chapters.filter((chapter) => (liveWords.get(chapter.id) ?? 0) !== chapter.wordCount)
      : [];
  const byStatus: Record<string, number> = {};
  for (const chapter of chapters) {
    byStatus[chapter.status] = (byStatus[chapter.status] || 0) + 1;
  }

  const lastActivity = chapters.reduce<string | null>((latest, chapter) => {
    if (!latest) return chapter.updatedAt;
    return Date.parse(chapter.updatedAt) > Date.parse(latest) ? chapter.updatedAt : latest;
  }, null);

  const rows: ChapterRow[] = chapters.map((chapter) => {
    const snapshots = listSnapshots(chapter.id);
    let churn: ChapterRow["churn"] = null;
    if (snapshots.length) {
      const oldest = snapshots[snapshots.length - 1];
      const { added, removed } = diffStats(
        readSnapshot(chapter.id, oldest.timestamp),
        texts.get(chapter.id) ?? ""
      );
      churn = { linesAdded: added, linesRemoved: removed };
    }
    return {
      id: chapter.id,
      title: chapter.title,
      status: chapter.status,
      order: chapter.order,
      wordCount: liveWords.get(chapter.id) ?? 0,
      updatedAt: chapter.updatedAt,
      daysSinceUpdate: daysBetween(chapter.updatedAt, now),
      revisionCount: snapshots.length,
      churn,
    };
  });

  const bible = getStoryBible();
  const presence = buildPresence(chapters, bible?.characters ?? [], texts);
  const timeline = buildTimelineMap(registry, chapters);
  const velocity =
    velocityFromLog(registry, totalWords, now) ?? buildVelocity(chapters, texts);

  // Projection needs the target, which velocity does not see.
  if (velocity.wordsPerDay && velocity.wordsPerDay > 0) {
    const remaining = registry.targetWordCount - totalWords;
    if (remaining > 0) {
      const days = Math.ceil(remaining / velocity.wordsPerDay);
      velocity.projectedFinish = new Date(now.getTime() + days * DAY_MS)
        .toISOString()
        .slice(0, 10);
    }
  }

  const notes: string[] = [];
  if (staleCounts.length) {
    notes.push(
      `${staleCounts.length} chapter file(s) differ in length from what the registry records (${staleCounts
        .map((c) => c.title)
        .join(", ")}). The figures here are counted from the files. This is what an edit made outside the tools looks like; book_chapter_update re-syncs the registry.`
    );
  }
  if (!bible?.characters.length) {
    notes.push(
      "No characters in the story bible, so the presence map is empty. Add them with book_character_add."
    );
  }
  if (timeline.points.length === 0) {
    notes.push(
      "No timeline events logged, so the story-order chart is empty. Log them with book_timeline_add."
    );
  }

  return {
    generatedAt: now.toISOString(),
    overview: {
      title: registry.title,
      author: registry.author,
      genre: registry.genre,
      totalWords,
      targetWords: registry.targetWordCount,
      percentComplete: registry.targetWordCount
        ? Math.round((totalWords / registry.targetWordCount) * 100)
        : 0,
      chapterCount: chapters.length,
      byStatus,
      estimatedReadingTimeMinutes: estimateReadingTime(totalWords),
      lastActivity,
      daysSinceLastActivity: lastActivity ? daysBetween(lastActivity, now) : null,
    },
    chapters: rows,
    presence,
    timeline,
    velocity,
    health: buildHealth(registry, chapters, texts, presence, timeline, now),
    readiness: buildReadiness(registry),
    notes,
  };
}
