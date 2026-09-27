// The shape of everything the dashboard shows. Collected once, then rendered
// either as JSON (book_dashboard) or as a page (book_dashboard_export), so the
// two can never disagree about the state of the book.

export interface DashboardOverview {
  title: string;
  author: string;
  genre: string;
  totalWords: number;
  targetWords: number;
  percentComplete: number;
  chapterCount: number;
  byStatus: Record<string, number>;
  estimatedReadingTimeMinutes: number;
  lastActivity: string | null;
  daysSinceLastActivity: number | null;
}

export interface ChapterRow {
  id: string;
  title: string;
  status: "outline" | "draft" | "review" | "final";
  order: number;
  wordCount: number;
  updatedAt: string;
  daysSinceUpdate: number;
  revisionCount: number;
  /** Lines added and removed since the oldest retained version of this chapter. */
  churn: { linesAdded: number; linesRemoved: number } | null;
}

export interface PresenceMatrix {
  characters: { id: string; name: string; role: string; total: number }[];
  chapters: { id: string; title: string; order: number }[];
  /** counts[characterIndex][chapterIndex] — times that character is named. */
  counts: number[][];
  maxCount: number;
  /** Characters in the bible that no included chapter names at all. */
  absent: string[];
  /** Runs of chapters where a character who appears elsewhere is missing. */
  gaps: { character: string; afterChapter: string; missedChapters: number }[];
}

export interface TimelinePoint {
  id: string;
  event: string;
  inStoryTime: string;
  sortKey: string | null;
  chapterId: string | null;
  chapterOrder: number | null;
  /** Rank of this event in story-chronological order, 1-based. */
  storyRank: number | null;
  contradiction: boolean;
}

export interface TimelineMap {
  points: TimelinePoint[];
  unplaced: number;
  contradictions: number;
  chaptersWithoutEvents: { id: string; title: string }[];
}

export interface VelocityPoint {
  at: string;
  totalWords: number;
}

export interface Velocity {
  series: VelocityPoint[];
  /** Words per day over the window the retained history actually covers. */
  wordsPerDay: number | null;
  daysCovered: number | null;
  projectedFinish: string | null;
  /** Why the series is partial — always stated, never implied. */
  coverage: string;
}

export interface HealthFinding {
  severity: "good" | "warning" | "serious" | "critical";
  area: "plot" | "timeline" | "voice" | "style" | "pace";
  summary: string;
  detail: string;
}

export interface ReadinessItem {
  item: string;
  state: "ready" | "needed" | "optional";
  detail: string;
}

export interface DashboardData {
  generatedAt: string;
  overview: DashboardOverview;
  chapters: ChapterRow[];
  presence: PresenceMatrix;
  timeline: TimelineMap;
  velocity: Velocity;
  health: HealthFinding[];
  readiness: ReadinessItem[];
  notes: string[];
}
