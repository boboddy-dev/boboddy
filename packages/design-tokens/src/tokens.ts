export const colors = {
  bg: "#0d1117",
  bgElev: "#161b22",
  // App header / global chrome sits a shade below the canvas (GitHub-style).
  bgHeader: "#010409",
  // Hover wash for rows, tabs, and nav items.
  bgHover: "rgba(177, 186, 196, 0.08)",
  surface: "#161b22",
  surfaceInset: "#010409",
  border: "#30363d",
  borderStrong: "#6e7681",
  borderMuted: "#21262d",
  text: "#e6edf3",
  textMuted: "#9198a1",
  textDim: "#6e7681",
  accent: "#38bdf8",
  accentSoft: "#7dd3fc",
  accent2: "#7c5cff",
  accent3: "#34d399",
  accentFg: "#38bdf8",
  // Primary actions / active states use the cyan brand family (was GitHub blue #1f6feb).
  accentEmphasis: "#0ea5e9",
  accentHover: "#38bdf8",
  accentActive: "#0284c7",
  accentSubtle: "rgba(56, 189, 248, 0.15)",
  accentMuted: "rgba(56, 189, 248, 0.4)",
  accentBorder: "rgba(56, 189, 248, 0.5)",
  successFg: "#3fb950",
  successEmphasis: "#238636",
  successSubtle: "rgba(63, 185, 80, 0.15)",
  successMuted: "rgba(63, 185, 80, 0.4)",
  dangerFg: "#f85149",
  dangerEmphasis: "#da3633",
  dangerSubtle: "rgba(248, 81, 73, 0.15)",
  dangerMuted: "rgba(248, 81, 73, 0.4)",
  attentionFg: "#d29922",
  attentionEmphasis: "#9e6a03",
  attentionSubtle: "rgba(187, 128, 9, 0.15)",
  attentionMuted: "rgba(187, 128, 9, 0.4)",
  doneFg: "#a371f7",
  doneEmphasis: "#8957e5",
  doneSubtle: "rgba(163, 113, 247, 0.15)",
  doneMuted: "rgba(163, 113, 247, 0.4)",
} as const;

export const fonts = {
  sans:
    '"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  mono:
    '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
} as const;

export type ColorToken = keyof typeof colors;
export type FontToken = keyof typeof fonts;
