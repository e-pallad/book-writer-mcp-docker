import { escapeHtml, escapeXml } from "../utils/markdown";
import {
  CHAPTER_STATUS_ORDER,
  DARK,
  LIGHT,
  STATUS_ICON,
  STATUS_LABEL,
  cssVariables,
  ordinalIndexFor,
} from "./theme";
import { DashboardData } from "./model";

// A self-contained page: no CDN, no build step, no fonts to fetch. Charts are
// inline SVG sized in a viewBox so they scale without script.
//
// Colour roles are CSS custom properties declared once per mode, so the light
// and dark palettes swap in one place and the markup is written against roles
// rather than raw hex. Dark is declared under both the OS media query and the
// data-theme scope, so a viewer's toggle wins either way.

const compact = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 10_000
    ? `${Math.round(n / 1000)}K`
    : n.toLocaleString("en-US");

const pct = (n: number) => `${Math.max(0, Math.min(100, Math.round(n)))}%`;

function statusChip(severity: string): string {
  // Icon + label + colour, never colour alone.
  return `<span class="chip chip--${escapeHtml(severity)}"><span class="chip__icon" aria-hidden="true">${
    STATUS_ICON[severity] ?? "•"
  }</span>${escapeHtml(STATUS_LABEL[severity] ?? severity)}</span>`;
}

function heroAndTiles(data: DashboardData): string {
  const o = data.overview;
  const remaining = Math.max(0, o.targetWords - o.totalWords);

  const tiles = [
    {
      label: "Complete",
      value: pct(o.percentComplete),
      sub: `${compact(remaining)} words to target`,
    },
    {
      label: "Chapters",
      value: String(o.chapterCount),
      sub: CHAPTER_STATUS_ORDER.filter((s) => o.byStatus[s])
        .map((s) => `${o.byStatus[s]} ${s}`)
        .join(" · ") || "none yet",
    },
    {
      label: "Reading time",
      value: `${o.estimatedReadingTimeMinutes}m`,
      sub: "at 250 words a minute",
    },
    {
      label: "Last worked on",
      value:
        o.daysSinceLastActivity === null
          ? "—"
          : o.daysSinceLastActivity === 0
          ? "Today"
          : `${o.daysSinceLastActivity}d ago`,
      sub: o.lastActivity ? o.lastActivity.slice(0, 10) : "no activity recorded",
    },
  ];

  return `<section class="hero-row">
  <div class="hero">
    <p class="hero__label">Words written</p>
    <p class="hero__value">${o.totalWords.toLocaleString("en-US")}</p>
    <p class="hero__sub">of ${o.targetWords.toLocaleString("en-US")} target</p>
    <div class="meter" role="img" aria-label="${pct(o.percentComplete)} of target">
      <div class="meter__fill" style="width:${pct(o.percentComplete)}"></div>
    </div>
  </div>
  <div class="tiles">
    ${tiles
      .map(
        (t) => `<div class="tile">
      <p class="tile__label">${escapeHtml(t.label)}</p>
      <p class="tile__value">${escapeHtml(t.value)}</p>
      <p class="tile__sub">${escapeHtml(t.sub)}</p>
    </div>`
      )
      .join("\n    ")}
  </div>
</section>`;
}

function presencePanel(data: DashboardData): string {
  const { characters, chapters, counts, maxCount } = data.presence;

  if (characters.length === 0 || chapters.length === 0) {
    return card(
      "Who appears where",
      "Characters down the side, chapters across. Darker means named more often.",
      `<p class="empty">${escapeHtml(
        characters.length === 0
          ? "No characters in the story bible yet."
          : "No chapters yet."
      )}</p>`
    );
  }

  const cell = 26;
  const gap = 2;
  const labelWidth = 132;
  const headerHeight = 96;
  const width = labelWidth + chapters.length * (cell + gap);
  const height = headerHeight + characters.length * (cell + gap);

  const cells = characters
    .map((character, row) =>
      chapters
        .map((chapter, col) => {
          const count = counts[row][col];
          // Sequential: near-zero is allowed to recede to the surface.
          const step =
            count === 0
              ? -1
              : Math.min(
                  12,
                  Math.max(0, Math.round((count / Math.max(1, maxCount)) * 12))
                );
          const x = labelWidth + col * (cell + gap);
          const y = headerHeight + row * (cell + gap);
          const fill = step < 0 ? "var(--empty-cell)" : `var(--seq-${step})`;
          const title = `${character.name} — ${chapter.title}: ${
            count === 0 ? "not named" : `${count} mention${count === 1 ? "" : "s"}`
          }`;
          return `<g class="cell"><rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="3" fill="${fill}" /><title>${escapeXml(
            title
          )}</title></g>`;
        })
        .join("")
    )
    .join("");

  const rowLabels = characters
    .map(
      (character, row) =>
        `<text class="axis-label" x="${labelWidth - 10}" y="${
          headerHeight + row * (cell + gap) + cell / 2 + 4
        }" text-anchor="end">${escapeXml(
          character.name.length > 16 ? `${character.name.slice(0, 15)}…` : character.name
        )}</text>`
    )
    .join("");

  const colLabels = chapters
    .map((chapter, col) => {
      const x = labelWidth + col * (cell + gap) + cell / 2;
      const label =
        chapter.title.length > 14 ? `${chapter.title.slice(0, 13)}…` : chapter.title;
      return `<text class="axis-label" x="${x}" y="${
        headerHeight - 8
      }" transform="rotate(-45 ${x} ${headerHeight - 8})" text-anchor="start">${escapeXml(
        label
      )}</text>`;
    })
    .join("");

  const legend = `<div class="scale">
    <span class="scale__label">Fewer</span>
    ${[0, 3, 6, 9, 12]
      .map((step) => `<span class="scale__swatch" style="background:var(--seq-${step})"></span>`)
      .join("")}
    <span class="scale__label">More mentions</span>
  </div>`;

  const table = `<table>
    <caption>Mentions per chapter</caption>
    <thead><tr><th scope="col">Character</th>${chapters
      .map((c) => `<th scope="col">${escapeHtml(c.title)}</th>`)
      .join("")}<th scope="col">Total</th></tr></thead>
    <tbody>${characters
      .map(
        (character, row) =>
          `<tr><th scope="row">${escapeHtml(character.name)}</th>${counts[row]
            .map((n) => `<td>${n || "—"}</td>`)
            .join("")}<td>${character.total}</td></tr>`
      )
      .join("")}</tbody>
  </table>`;

  return card(
    "Who appears where",
    "Characters down the side, chapters across. Darker means named more often — a pale streak is someone leaving the book for a while.",
    `${legend}
    <div class="scroll"><svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Character presence by chapter">
      ${colLabels}${rowLabels}${cells}
    </svg></div>`,
    table
  );
}

function timelinePanel(data: DashboardData): string {
  const points = data.timeline.points.filter(
    (p) => p.storyRank !== null && p.chapterOrder !== null
  );

  if (points.length === 0) {
    return card(
      "Story order vs chapter order",
      "Where each logged event sits in story time against where it is told.",
      `<p class="empty">${escapeHtml(
        data.timeline.points.length === 0
          ? "No timeline events logged yet."
          : "No events have both a sortKey and a chapter, so none can be placed."
      )}</p>`
    );
  }

  const w = 640;
  const h = 360;
  const pad = { top: 16, right: 20, bottom: 44, left: 52 };
  const maxChapter = Math.max(...points.map((p) => p.chapterOrder!), 1);
  const maxRank = Math.max(...points.map((p) => p.storyRank!), 1);

  const sx = (order: number) =>
    pad.left + ((order - 1) / Math.max(1, maxChapter - 1)) * (w - pad.left - pad.right);
  const sy = (rank: number) =>
    h - pad.bottom - ((rank - 1) / Math.max(1, maxRank - 1)) * (h - pad.top - pad.bottom);

  // The diagonal is "told in the order it happens". Distance from it is the
  // book's flashback structure.
  const reference = `<line class="reference" x1="${sx(1)}" y1="${sy(1)}" x2="${sx(
    maxChapter
  )}" y2="${sy(maxRank)}" />`;

  const dots = points
    .map((p) => {
      const cls = p.contradiction ? "dot dot--bad" : "dot";
      const title = `${p.event} — ${p.inStoryTime || p.sortKey}${
        p.contradiction ? " (contradicts an earlier chapter)" : ""
      }`;
      return `<g class="${cls}"><circle cx="${sx(p.chapterOrder!)}" cy="${sy(
        p.storyRank!
      )}" r="5" /><title>${escapeXml(title)}</title></g>`;
    })
    .join("");

  const gridlines = [0, 0.25, 0.5, 0.75, 1]
    .map((t) => {
      const y = pad.top + t * (h - pad.top - pad.bottom);
      return `<line class="grid" x1="${pad.left}" y1="${y}" x2="${w - pad.right}" y2="${y}" />`;
    })
    .join("");

  const contradictionNote = data.timeline.contradictions
    ? `<p class="note note--bad">${statusChip("critical")} ${
        data.timeline.contradictions
      } event(s) happen before something logged in an earlier chapter. Either the chapter is a flashback, or a sortKey is wrong.</p>`
    : "";

  const table = `<table>
    <caption>Logged events in story order</caption>
    <thead><tr><th scope="col">#</th><th scope="col">Event</th><th scope="col">In-story time</th><th scope="col">Chapter</th><th scope="col">Flag</th></tr></thead>
    <tbody>${[...points]
      .sort((a, b) => a.storyRank! - b.storyRank!)
      .map(
        (p) =>
          `<tr><td>${p.storyRank}</td><td>${escapeHtml(p.event)}</td><td>${escapeHtml(
            p.inStoryTime
          )}</td><td>${p.chapterOrder}</td><td>${
            p.contradiction ? "contradiction" : "—"
          }</td></tr>`
      )
      .join("")}</tbody>
  </table>`;

  return card(
    "Story order vs chapter order",
    "Each dot is a logged event: across is the chapter it is told in, up is when it happens. A straight diagonal means the book is told in order; departures from it are the flashback structure.",
    `${contradictionNote}
    <svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Story order against chapter order">
      ${gridlines}${reference}
      <line class="axis" x1="${pad.left}" y1="${h - pad.bottom}" x2="${w - pad.right}" y2="${
      h - pad.bottom
    }" />
      <line class="axis" x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${
      h - pad.bottom
    }" />
      ${dots}
      ${Array.from({ length: maxChapter }, (_, i) => i + 1)
        .filter(
          (order) =>
            maxChapter <= 12 || order === 1 || order === maxChapter || order % 5 === 0
        )
        .map(
          (order) =>
            `<text class="axis-label" x="${sx(order)}" y="${
              h - pad.bottom + 16
            }" text-anchor="middle">${order}</text>`
        )
        .join("")}
      <text class="axis-title" x="${(pad.left + w - pad.right) / 2}" y="${
      h - 8
    }" text-anchor="middle">Chapter order →</text>
      <text class="axis-title" transform="rotate(-90 14 ${
        (pad.top + h - pad.bottom) / 2
      })" x="14" y="${(pad.top + h - pad.bottom) / 2}" text-anchor="middle">Happens later →</text>
    </svg>`,
    table
  );
}

function chaptersPanel(data: DashboardData): string {
  if (data.chapters.length === 0) {
    return card("Chapters", "Length and state of each chapter.", `<p class="empty">No chapters yet.</p>`);
  }

  const max = Math.max(...data.chapters.map((c) => c.wordCount), 1);
  const barW = 260;

  const rows = data.chapters
    .map((chapter) => {
      const width = Math.max(2, (chapter.wordCount / max) * barW);
      const stale = chapter.status !== "final" && chapter.daysSinceUpdate >= 21;
      return `<tr>
      <td class="c-title">${escapeHtml(chapter.title)}</td>
      <td><span class="status status--${ordinalIndexFor(
        chapter.status
      )}">${escapeHtml(chapter.status)}</span></td>
      <td class="num">${chapter.wordCount.toLocaleString("en-US")}</td>
      <td class="barcell"><span class="bar" style="width:${width}px" title="${
        chapter.wordCount
      } words"></span></td>
      <td class="num">${chapter.revisionCount || "—"}</td>
      <td class="num">${
        chapter.churn
          ? `<span class="churn">+${chapter.churn.linesAdded} / −${chapter.churn.linesRemoved}</span>`
          : "—"
      }</td>
      <td class="num${stale ? " is-stale" : ""}">${chapter.daysSinceUpdate}d${
        stale ? ' <span class="chip chip--warning"><span class="chip__icon" aria-hidden="true">!</span>stale</span>' : ""
      }</td>
    </tr>`;
    })
    .join("");

  return card(
    "Chapters",
    "Length, state, how many saved versions each has, and how much has changed since the oldest one.",
    `<table class="chapters">
      <thead><tr>
        <th scope="col">Chapter</th><th scope="col">Status</th><th scope="col">Words</th>
        <th scope="col"><span class="visually-hidden">Length</span></th>
        <th scope="col">Revisions</th><th scope="col">Churn</th><th scope="col">Last edit</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`
  );
}

function velocityPanel(data: DashboardData): string {
  const { series, wordsPerDay, projectedFinish, coverage } = data.velocity;

  if (series.length < 2) {
    return card(
      "Words over time",
      "Reconstructed from saved chapter versions.",
      `<p class="empty">${escapeHtml(coverage)}</p>`
    );
  }

  const w = 640;
  const h = 260;
  const pad = { top: 16, right: 20, bottom: 36, left: 64 };
  const t0 = Date.parse(series[0].at);
  const t1 = Date.parse(series[series.length - 1].at);
  const peak = Math.max(...series.map((p) => p.totalWords), 1);
  // 15% headroom: with the peak at the ceiling the line runs along the top
  // edge and the end-label is clipped out of the viewBox entirely.
  const maxWords = peak * 1.15;

  const sx = (at: string) =>
    pad.left + ((Date.parse(at) - t0) / Math.max(1, t1 - t0)) * (w - pad.left - pad.right);
  const sy = (words: number) =>
    h - pad.bottom - (words / maxWords) * (h - pad.top - pad.bottom);

  const path = series
    .map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.at).toFixed(1)},${sy(p.totalWords).toFixed(1)}`)
    .join(" ");
  const area = `${path} L${sx(series[series.length - 1].at).toFixed(1)},${
    h - pad.bottom
  } L${sx(series[0].at).toFixed(1)},${h - pad.bottom} Z`;

  const last = series[series.length - 1];
  const ticks = [0, 0.5, 1].map((t) => {
    const words = Math.round(peak * t);
    const y = sy(words);
    return `<line class="grid" x1="${pad.left}" y1="${y}" x2="${w - pad.right}" y2="${y}" />
      <text class="axis-label" x="${pad.left - 8}" y="${y + 4}" text-anchor="end">${compact(
      words
    )}</text>`;
  });

  return card(
    "Words over time",
    "Total words across the manuscript, reconstructed from the saved chapter versions.",
    `<p class="note">${escapeHtml(coverage)}</p>
    ${
      wordsPerDay !== null
        ? `<p class="note">About <strong>${wordsPerDay.toLocaleString(
            "en-US"
          )}</strong> words a day over that window${
            projectedFinish
              ? `, which reaches the target around <strong>${escapeHtml(
                  projectedFinish
                )}</strong> if it holds.`
              : "."
          }</p>`
        : ""
    }
    <svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Total words over time">
      ${ticks.join("")}
      <path class="area" d="${area}" />
      <path class="line" d="${path}" />
      <g class="dot dot--end"><circle cx="${sx(last.at).toFixed(1)}" cy="${sy(
      last.totalWords
    ).toFixed(1)}" r="5" /><title>${escapeXml(
      `${last.totalWords.toLocaleString("en-US")} words on ${last.at.slice(0, 10)}`
    )}</title></g>
      <text class="end-label" x="${(sx(last.at) - 8).toFixed(1)}" y="${Math.max(
      pad.top + 10,
      sy(last.totalWords) - 12
    ).toFixed(1)}" text-anchor="end">${compact(last.totalWords)}</text>
      <line class="axis" x1="${pad.left}" y1="${h - pad.bottom}" x2="${w - pad.right}" y2="${
      h - pad.bottom
    }" />
      <text class="axis-label" x="${pad.left}" y="${h - 12}">${escapeHtml(
      series[0].at.slice(0, 10)
    )}</text>
      <text class="axis-label" x="${w - pad.right}" y="${h - 12}" text-anchor="end">${escapeHtml(
      last.at.slice(0, 10)
    )}</text>
    </svg>`
  );
}

function healthPanel(data: DashboardData): string {
  const rows = data.health
    .map(
      (finding) => `<li class="finding">
      ${statusChip(finding.severity)}
      <div>
        <p class="finding__summary">${escapeHtml(finding.summary)}</p>
        <p class="finding__detail">${escapeHtml(finding.detail)}</p>
      </div>
      <span class="finding__area">${escapeHtml(finding.area)}</span>
    </li>`
    )
    .join("");

  return card(
    "Manuscript health",
    "What the continuity, timeline, voice and style checks find across the whole book.",
    `<ul class="findings">${rows}</ul>`
  );
}

function readinessPanel(data: DashboardData): string {
  const icon = { ready: "✓", needed: "✕", optional: "–" };
  const rows = data.readiness
    .map(
      (item) => `<li class="ready-item ready-item--${item.state}">
      <span class="ready-item__icon" aria-hidden="true">${icon[item.state]}</span>
      <div>
        <p class="finding__summary">${escapeHtml(item.item)} <span class="ready-item__state">${escapeHtml(
        item.state
      )}</span></p>
        <p class="finding__detail">${escapeHtml(item.detail)}</p>
      </div>
    </li>`
    )
    .join("");

  return card(
    "Publishing readiness",
    "What is still outstanding before this can go to KDP.",
    `<ul class="findings">${rows}</ul>`
  );
}

function card(
  title: string,
  subtitle: string,
  body: string,
  table?: string
): string {
  const id = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `<section class="card">
  <header class="card__head">
    <h2>${escapeHtml(title)}</h2>
    <p class="card__sub">${escapeHtml(subtitle)}</p>
  </header>
  <div class="card__body">${body}</div>
  ${
    table
      ? `<details class="table-view"><summary>Table view</summary><div class="scroll" id="${id}-table">${table}</div></details>`
      : ""
  }
</section>`;
}

export interface RenderOptions {
  /**
   * Reload every N seconds via a meta refresh. Set by the live server; left
   * off for the exported file, which stays free of anything executable.
   */
  refreshSeconds?: number;
}

export function renderDashboard(
  data: DashboardData,
  options: RenderOptions = {}
): string {
  const notes = data.notes.length
    ? `<section class="card card--notes"><ul>${data.notes
        .map((n) => `<li>${escapeHtml(n)}</li>`)
        .join("")}</ul></section>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(data.overview.title)} — Dashboard</title>
${
  options.refreshSeconds
    ? `<meta http-equiv="refresh" content="${options.refreshSeconds}" />`
    : ""
}
<style>
:root {
  color-scheme: light dark;
  ${cssVariables(LIGHT)}
}
/* Dark is declared twice on purpose: the media query follows the OS, the
   data-theme scope follows a viewer's toggle, and the toggle must win both
   ways. The :not() guard lets an explicit light stamp beat OS dark. */
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) {
    ${cssVariables(DARK)}
  }
}
:root[data-theme="dark"] {
  ${cssVariables(DARK)}
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--plane); color: var(--text-primary);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  line-height: 1.5;
}
.wrap { max-width: 1140px; margin: 0 auto; padding: 32px 16px 64px; }
header.page { margin-bottom: 24px; }
header.page h1 { font-size: 1.5rem; margin: 0 0 4px; }
header.page p { margin: 0; color: var(--text-secondary); font-size: 0.9rem; }
.hero-row { display: grid; grid-template-columns: minmax(240px, 1fr) 2fr; gap: 16px; margin-bottom: 16px; }
.hero, .tile, .card {
  background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 20px;
}
.hero__label, .tile__label { margin: 0; font-size: 0.8rem; color: var(--text-secondary); }
.hero__value { margin: 4px 0 0; font-size: 3rem; font-weight: 600; line-height: 1.05; }
.hero__sub, .tile__sub { margin: 2px 0 0; font-size: 0.8rem; color: var(--text-muted); }
.meter { margin-top: 14px; height: 8px; border-radius: 4px; background: var(--seq-0); overflow: hidden; }
.meter__fill { height: 100%; background: var(--series-1); }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 16px; }
.tile__value { margin: 4px 0 0; font-size: 1.6rem; font-weight: 600; }
.card { margin-bottom: 16px; }
.card__head { margin-bottom: 14px; }
.card__head h2 { margin: 0; font-size: 1.05rem; }
.card__sub { margin: 4px 0 0; font-size: 0.85rem; color: var(--text-secondary); max-width: 68ch; }
.empty { color: var(--text-muted); font-size: 0.9rem; margin: 0; }
.note { font-size: 0.85rem; color: var(--text-secondary); margin: 0 0 10px; }
.note--bad { display: flex; align-items: center; gap: 8px; }
.scroll { overflow-x: auto; }
svg { max-width: 100%; height: auto; display: block; }
/* Charts keep their drawn proportions instead of stretching to the card: a
   640px plot blown up to 900 puts the marks adrift in whitespace. */
.card__body > svg { max-width: 680px; margin: 0 auto; }
.grid { stroke: var(--grid); stroke-width: 1; }
.axis { stroke: var(--axis); stroke-width: 1; }
.reference { stroke: var(--axis); stroke-width: 1; }
.axis-label { fill: var(--text-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.axis-title { fill: var(--text-secondary); font-size: 11px; }
.end-label { fill: var(--text-secondary); font-size: 12px; font-weight: 600; }
.dot circle { fill: var(--series-1); stroke: var(--surface); stroke-width: 2; }
.dot--bad circle { fill: var(--critical); }
.dot { cursor: default; }
.dot:hover circle { r: 7; }
.cell rect { stroke: var(--surface); stroke-width: 2; }
.cell:hover rect { stroke: var(--text-primary); }
.line { fill: none; stroke: var(--series-1); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.area { fill: var(--series-1); opacity: 0.10; stroke: none; }
.scale { display: flex; align-items: center; gap: 4px; margin-bottom: 12px; font-size: 0.75rem; color: var(--text-muted); }
.scale__swatch { width: 22px; height: 10px; border-radius: 2px; }
.scale__label { margin: 0 6px; }
table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
caption { text-align: left; color: var(--text-secondary); font-size: 0.8rem; padding-bottom: 8px; }
th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--border); }
th { color: var(--text-secondary); font-weight: 600; font-size: 0.78rem; }
td.num, th[scope="col"].num { text-align: right; font-variant-numeric: tabular-nums; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.c-title { font-weight: 500; }
.barcell { width: 280px; }
.bar { display: block; height: 10px; border-radius: 0 4px 4px 0; background: var(--series-1); }
.churn { color: var(--text-secondary); font-size: 0.8rem; }
.is-stale { color: var(--text-primary); }
.status { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 0.75rem; color: #fff; }
.status--0 { background: var(--ord-0); color: #0b0b0b; }
.status--1 { background: var(--ord-1); }
.status--2 { background: var(--ord-2); }
.status--3 { background: var(--ord-3); }
.chip { display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border-radius: 999px;
  font-size: 0.72rem; font-weight: 600; white-space: nowrap; color: var(--text-primary);
  border: 1px solid var(--border); }
.chip__icon { display: inline-grid; place-items: center; width: 14px; height: 14px; border-radius: 50%;
  color: #fff; font-size: 9px; line-height: 1; }
.chip--good .chip__icon { background: var(--good); }
.chip--warning .chip__icon { background: var(--warning); color: #0b0b0b; }
.chip--serious .chip__icon { background: var(--serious); }
.chip--critical .chip__icon { background: var(--critical); }
.findings { list-style: none; margin: 0; padding: 0; }
.finding, .ready-item { display: grid; grid-template-columns: auto 1fr auto; gap: 12px;
  align-items: start; padding: 11px 0; border-bottom: 1px solid var(--border); }
.ready-item { grid-template-columns: auto 1fr; }
.finding:last-child, .ready-item:last-child { border-bottom: 0; }
.finding__summary { margin: 0; font-size: 0.9rem; font-weight: 500; }
.finding__detail { margin: 2px 0 0; font-size: 0.82rem; color: var(--text-secondary); }
.finding__area { font-size: 0.7rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
.ready-item__icon { display: inline-grid; place-items: center; width: 18px; height: 18px;
  border-radius: 50%; font-size: 11px; color: #fff; margin-top: 2px; }
.ready-item--ready .ready-item__icon { background: var(--good); }
.ready-item--needed .ready-item__icon { background: var(--critical); }
.ready-item--optional .ready-item__icon { background: var(--text-muted); }
.ready-item__state { font-size: 0.72rem; color: var(--text-muted); font-weight: 400; }
.table-view { margin-top: 14px; border-top: 1px solid var(--border); padding-top: 10px; }
.table-view summary { cursor: pointer; font-size: 0.82rem; color: var(--text-secondary); }
.card--notes ul { margin: 0; padding-left: 18px; font-size: 0.85rem; color: var(--text-secondary); }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.grid-2 > .card { margin-bottom: 0; }
@media (max-width: 860px) {
  .hero-row, .grid-2 { grid-template-columns: 1fr; }
  .wrap { padding: 20px 16px 48px; }
}
@media print { body { background: #fff; } .card { break-inside: avoid; } }
</style>
</head>
<body>
<div class="wrap">
  <header class="page">
    <h1>${escapeHtml(data.overview.title)}</h1>
    <p>${escapeHtml(data.overview.author)} · ${escapeHtml(
    data.overview.genre
  )} · generated ${escapeHtml(data.generatedAt.slice(0, 16).replace("T", " "))}</p>
  </header>
  ${heroAndTiles(data)}
  ${notes}
  ${presencePanel(data)}
  ${timelinePanel(data)}
  ${chaptersPanel(data)}
  ${velocityPanel(data)}
  <div class="grid-2">
    ${healthPanel(data)}
    ${readinessPanel(data)}
  </div>
</div>
</body>
</html>`;
}
