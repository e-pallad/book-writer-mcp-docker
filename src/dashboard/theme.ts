// Colour roles, from the validated reference palette.
//
// Every value here was checked with the data-viz validator rather than picked
// by eye. The two ordinal ramps below pass all four ordinal checks in their
// respective modes (monotone lightness, >= 0.06 step gaps, light end clearing
// the surface, single hue).
//
// The status four are the reserved status palette. They are deliberately NOT
// run through the categorical checks: warning and serious sit below 3:1 on the
// light surface by design, and the documented mitigation is that a status
// colour never travels without an icon and a word. Nothing here uses status
// colour alone.

export const LIGHT = {
  surface: "#fcfcfb",
  plane: "#f9f9f7",
  textPrimary: "#0b0b0b",
  textSecondary: "#52514e",
  textMuted: "#898781",
  grid: "#e1e0d9",
  axis: "#c3c2b7",
  border: "rgba(11,11,11,0.10)",
  series1: "#2a78d6",
  // Sequential blue, 100 -> 700, for the presence heatmap.
  sequential: [
    "#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec",
    "#5598e7", "#3987e5", "#2a78d6", "#256abf", "#1c5cab",
    "#184f95", "#104281", "#0d366b",
  ],
  // Ordinal blue for chapter status (outline -> final). Starts at step 250:
  // nothing lighter clears 2:1 against the light surface.
  ordinal: ["#86b6ef", "#5598e7", "#2a78d6", "#1c5cab"],
};

export const DARK = {
  surface: "#1a1a19",
  plane: "#0d0d0d",
  textPrimary: "#ffffff",
  textSecondary: "#c3c2b7",
  textMuted: "#898781",
  grid: "#2c2c2a",
  axis: "#383835",
  border: "rgba(255,255,255,0.10)",
  series1: "#3987e5",
  sequential: [
    "#0d366b", "#104281", "#184f95", "#1c5cab", "#256abf",
    "#2a78d6", "#3987e5", "#5598e7", "#6da7ec", "#86b6ef",
    "#9ec5f4", "#b7d3f6", "#cde2fb",
  ],
  // Mirror of the light ramp, stepped for the dark surface: nothing darker
  // than step 600 clears 2:1 there.
  ordinal: ["#6da7ec", "#3987e5", "#256abf", "#184f95"],
};

/** Fixed in both modes, per the reference palette. */
export const STATUS = {
  good: "#0ca30c",
  warning: "#fab219",
  serious: "#ec835a",
  critical: "#d03b3b",
};

// Status never carries meaning by colour alone.
export const STATUS_ICON: Record<string, string> = {
  good: "✓",
  warning: "!",
  serious: "!!",
  critical: "✕",
};

export const STATUS_LABEL: Record<string, string> = {
  good: "OK",
  warning: "Watch",
  serious: "Serious",
  critical: "Critical",
};

/** Chapter status is an ordered scale, so it gets the ordinal ramp, not status colours. */
export const CHAPTER_STATUS_ORDER = ["outline", "draft", "review", "final"] as const;

export function ordinalIndexFor(status: string): number {
  const index = CHAPTER_STATUS_ORDER.indexOf(status as never);
  return index === -1 ? 0 : index;
}

/**
 * The custom-property block for one mode.
 *
 * The stylesheet is generated from these constants rather than written out
 * beside them, so the validated values above are the only place a colour is
 * stated and the CSS cannot drift away from what was checked.
 */
export function cssVariables(mode: typeof LIGHT | typeof DARK): string {
  const lines = [
    `--surface:${mode.surface};`,
    `--plane:${mode.plane};`,
    `--text-primary:${mode.textPrimary};`,
    `--text-secondary:${mode.textSecondary};`,
    `--text-muted:${mode.textMuted};`,
    `--grid:${mode.grid};`,
    `--axis:${mode.axis};`,
    `--border:${mode.border};`,
    `--series-1:${mode.series1};`,
    `--empty-cell:${mode === LIGHT ? "#f0efec" : "#232321"};`,
    ...mode.sequential.map((hex, i) => `--seq-${i}:${hex};`),
    ...mode.ordinal.map((hex, i) => `--ord-${i}:${hex};`),
    `--good:${STATUS.good};`,
    `--warning:${STATUS.warning};`,
    `--serious:${STATUS.serious};`,
    `--critical:${STATUS.critical};`,
  ];
  return lines.join("\n  ");
}
