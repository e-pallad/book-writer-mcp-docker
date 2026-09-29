// Turning the writing log into answers: today against the goal, the streak,
// the last two weeks, and whether the deadline is in reach.

import { Registry, WritingLog } from "./schema";
import { dayKey, projectTimeZone } from "./writing-log";

const DAY_MS = 24 * 60 * 60 * 1000;
export const RECENT_DAYS = 14;

export interface DayTally {
  date: string;
  added: number;
  removed: number;
  net: number;
}

export interface Progress {
  timezone: string;
  today: DayTally & {
    goal: number | null;
    remainingToGoal: number | null;
    goalMet: boolean | null;
  };
  recent: DayTally[];
  streak: {
    /** Consecutive days with words added, ending today (or yesterday, if today is still empty). */
    writingDays: number;
    /** The same, counting only days that met the goal. */
    goalDays: number | null;
  };
  averages: {
    /** Words added per calendar day over the recent window the log covers. */
    addedPerDay: number;
    /** Net words per calendar day over the same window. */
    netPerDay: number;
    daysCovered: number;
  };
  manuscript: { totalWords: number; targetWords: number; remaining: number };
  deadline: {
    date: string;
    /** Days left, today included. */
    daysLeft: number;
    wordsPerDayNeeded: number | null;
    onTrack: boolean | null;
  } | null;
  /** When the target is reached at the recent net pace, or null. */
  projectedFinish: string | null;
  logStartedAt: string | null;
  notes: string[];
}

/** YYYY-MM-DD shifted by whole days. */
function shiftDay(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d) + days * DAY_MS);
  return shifted.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  const parse = (value: string) => {
    const [y, m, d] = value.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((parse(to) - parse(from)) / DAY_MS);
}

function tally(log: WritingLog | null, date: string): DayTally {
  const day = log?.days[date];
  const added = day?.added ?? 0;
  const removed = day?.removed ?? 0;
  return { date, added, removed, net: added - removed };
}

export function computeProgress(
  registry: Registry,
  log: WritingLog | null,
  totalWords: number,
  now = new Date()
): Progress {
  const timezone = projectTimeZone(registry);
  const today = dayKey(now, timezone);
  const goal = registry.dailyWordGoal && registry.dailyWordGoal > 0 ? registry.dailyWordGoal : null;
  const notes: string[] = [];

  const todayTally = tally(log, today);
  const recent = Array.from({ length: RECENT_DAYS }, (_, i) =>
    tally(log, shiftDay(today, i - (RECENT_DAYS - 1)))
  );

  // A streak survives an empty today: the day is not over yet.
  const streakOf = (qualifies: (t: DayTally) => boolean) => {
    let date = qualifies(todayTally) ? today : shiftDay(today, -1);
    let count = 0;
    while (qualifies(tally(log, date))) {
      count++;
      date = shiftDay(date, -1);
    }
    return count;
  };

  // The window the averages cover: the recent fortnight, but not before the
  // log began — days before it were not "zero words", they were unrecorded.
  const startedDay = log ? dayKey(new Date(log.startedAt), timezone) : today;
  const firstCovered = daysBetween(startedDay, recent[0].date) >= 0 ? recent[0].date : startedDay;
  const covered = recent.filter((d) => d.date >= firstCovered);
  const daysCovered = covered.length;
  const addedPerDay = daysCovered
    ? Math.round(covered.reduce((sum, d) => sum + d.added, 0) / daysCovered)
    : 0;
  const netPerDay = daysCovered
    ? Math.round(covered.reduce((sum, d) => sum + d.net, 0) / daysCovered)
    : 0;

  const remaining = Math.max(0, registry.targetWordCount - totalWords);

  let deadline: Progress["deadline"] = null;
  if (registry.deadline) {
    const daysLeft = daysBetween(today, registry.deadline) + 1;
    const wordsPerDayNeeded = daysLeft > 0 ? Math.ceil(remaining / daysLeft) : null;
    deadline = {
      date: registry.deadline,
      daysLeft: Math.max(0, daysLeft),
      wordsPerDayNeeded,
      onTrack:
        remaining === 0
          ? true
          : wordsPerDayNeeded === null
          ? false
          : daysCovered >= 3
          ? netPerDay >= wordsPerDayNeeded
          : null,
    };
    if (daysLeft <= 0 && remaining > 0) {
      notes.push(`The deadline ${registry.deadline} has passed with ${remaining} words to go.`);
    } else if (deadline.onTrack === null) {
      notes.push("Fewer than three days logged, so it is too early to say whether the deadline is in reach.");
    }
  }

  let projectedFinish: string | null = null;
  if (remaining > 0 && netPerDay > 0) {
    projectedFinish = shiftDay(today, Math.ceil(remaining / netPerDay));
  }

  if (!log) {
    notes.push(
      "Nothing logged yet. Every change to a chapter made through the tools is recorded from now on."
    );
  }

  return {
    timezone,
    today: {
      ...todayTally,
      goal,
      remainingToGoal: goal === null ? null : Math.max(0, goal - todayTally.added),
      goalMet: goal === null ? null : todayTally.added >= goal,
    },
    recent,
    streak: {
      writingDays: streakOf((t) => t.added > 0),
      goalDays: goal === null ? null : streakOf((t) => t.added >= goal),
    },
    averages: { addedPerDay, netPerDay, daysCovered },
    manuscript: { totalWords, targetWords: registry.targetWordCount, remaining },
    deadline,
    projectedFinish,
    logStartedAt: log?.startedAt ?? null,
    notes,
  };
}

/**
 * Manuscript totals at the end of each logged day, walked back from today's
 * total: the total at the end of a day is today's minus every net change made
 * after it. Exact for everything made through the tools since the log began.
 */
export function totalsByDay(
  log: WritingLog,
  currentTotal: number
): { date: string; totalWords: number }[] {
  const dates = Object.keys(log.days).sort();
  const points: { date: string; totalWords: number }[] = [];
  let total = currentTotal;
  for (let i = dates.length - 1; i >= 0; i--) {
    points.unshift({ date: dates[i], totalWords: total });
    const day = log.days[dates[i]];
    total -= day.added - day.removed;
  }
  return points;
}
