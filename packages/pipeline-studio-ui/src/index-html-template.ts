/**
 * The studio's single HTML page. `Bun.build` (see `build.ts`) always emits
 * `main.css` alongside `main.js` for this entrypoint — `App.tsx` imports
 * `@xyflow/react/dist/style.css`, so React Flow's own base styles live there
 * too, not just this file's own tiny layout rules (inlined below rather than
 * added to that generated file, since this template is the one place meant
 * to be hand-edited).
 *
 * Every color is a `--studio-*` custom property keyed off `<html data-theme>`.
 * The page ships as `data-theme="dark"`; the inline head script swaps in a
 * previously saved choice (see `theme.ts`) before first paint so a light-mode
 * user never sees a dark flash.
 */
export const STUDIO_INDEX_HTML = `<!doctype html>
<html lang="en" data-theme="dark">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Boboddy Pipeline Studio</title>
    <script>
      try {
        var saved = localStorage.getItem("boboddy-studio-theme");
        if (saved === "light" || saved === "dark") {
          document.documentElement.dataset.theme = saved;
        }
      } catch (_) {}
    </script>
    <link rel="stylesheet" href="./main.css" />
    <style>
      :root,
      [data-theme="dark"] {
        color-scheme: dark;
        --studio-bg: #0f1115;
        --studio-surface: #171a21;
        --studio-surface-raised: #1e222b;
        --studio-node-bg: #1e222b;
        --studio-hover: #232833;
        --studio-text: #e6e8ec;
        --studio-text-strong: #f5f6f8;
        --studio-text-muted: #9097a3;
        --studio-text-subtle: #b4bac4;
        --studio-border: #2a2f3a;
        --studio-border-subtle: #20242d;
        --studio-focus: #e6e8ec;
        --studio-severity-error: #f2545b;
        --studio-severity-warning: #e8913a;
        --studio-severity-info: #4f9cf0;
        --studio-severity-none: #3a4050;
        --studio-chip-text: #0f1115;
        --studio-node-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
        --studio-backdrop: rgba(0, 0, 0, 0.6);
        --studio-dialog-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
      }
      [data-theme="light"] {
        color-scheme: light;
        --studio-bg: #ffffff;
        --studio-surface: #ffffff;
        --studio-surface-raised: #f7f7f7;
        --studio-node-bg: #ffffff;
        --studio-hover: #f0f0f0;
        --studio-text: #1a1a1a;
        --studio-text-strong: #1a1a1a;
        --studio-text-muted: #666666;
        --studio-text-subtle: #444444;
        --studio-border: #e2e2e2;
        --studio-border-subtle: #f0f0f0;
        --studio-focus: #1a1a1a;
        --studio-severity-error: #b00020;
        --studio-severity-warning: #b34700;
        --studio-severity-info: #0969da;
        --studio-severity-none: #1a192b1a;
        --studio-chip-text: #ffffff;
        --studio-node-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
        --studio-backdrop: rgba(0, 0, 0, 0.4);
        --studio-dialog-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
      }
      html, body, #root { height: 100%; margin: 0; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: var(--studio-text);
        background: var(--studio-bg);
      }
      .studio-layout {
        display: grid;
        grid-template-columns: 1fr 320px;
        grid-template-rows: auto 1fr;
        height: 100%;
      }
      .studio-header {
        grid-column: 1 / -1;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 8px 16px;
        border-bottom: 1px solid var(--studio-border);
        background: var(--studio-surface);
      }
      .studio-header select,
      .studio-theme-toggle {
        padding: 4px 8px;
        border: 1px solid var(--studio-border);
        border-radius: 4px;
        background: var(--studio-surface-raised);
        color: var(--studio-text);
        font: inherit;
        font-size: 13px;
      }
      .studio-theme-toggle { cursor: pointer; }
      .studio-theme-toggle:hover { background: var(--studio-hover); }
      .studio-graph { grid-column: 1; grid-row: 2; }
      .studio-graph .react-flow { --xy-background-color: var(--studio-bg); }
      .studio-issues {
        grid-column: 2;
        grid-row: 2;
        overflow-y: auto;
        padding: 12px 16px;
        border-left: 1px solid var(--studio-border);
        background: var(--studio-surface);
      }
      .studio-issues h2 {
        font-size: 14px;
        text-transform: uppercase;
        color: var(--studio-text-muted);
      }
      .studio-issues-list { list-style: none; margin: 0; padding: 0; }
      .studio-issue {
        padding: 8px 0;
        border-bottom: 1px solid var(--studio-border-subtle);
        font-size: 13px;
      }
      .studio-issue-header {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 2px;
      }
      .studio-issue-check {
        font-weight: bold;
        color: var(--studio-severity-warning);
      }
      .studio-severity-chip {
        display: inline-block;
        flex: none;
        padding: 1px 6px;
        border-radius: 3px;
        color: var(--studio-chip-text);
        font-size: 10px;
        font-weight: bold;
        text-transform: uppercase;
        letter-spacing: 0.02em;
      }
      /*
       * Rows for issues with a nodeKey (see IssueRow in App.tsx) are
       * clickable — selects that node and swaps in NodeDetailPanel. Rows
       * for step-only issues (no nodeKey) get no such affordance, since
       * there's nothing for them to select.
       */
      .studio-issue-clickable { cursor: pointer; }
      .studio-issue-clickable:hover { background: var(--studio-hover); }
      .studio-issue-clickable:focus-visible {
        outline: 2px solid var(--studio-focus);
        outline-offset: -2px;
      }
      /*
       * React Flow's own stylesheet (imported by PipelineGraphView.tsx)
       * gives every node's wrapper div a "react-flow__node-default" class
       * with its own border/padding/background REGARDLESS of whether a
       * custom nodeTypes component is registered — that wrapper still
       * renders around StudioGraphNode's own .studio-node box below,
       * producing a visible double border/corner. Neutralize it here
       * rather than fight it with more specific selectors.
       */
      .react-flow__node-default {
        padding: 0;
        border: none;
        background: none;
        width: auto;
        text-align: left;
      }
      .studio-node {
        position: relative;
        width: 220px;
        padding: 8px 10px;
        border: 2px solid var(--studio-severity-none);
        border-radius: 6px;
        background: var(--studio-node-bg);
        color: var(--studio-text);
        box-shadow: var(--studio-node-shadow);
        font-size: 12px;
      }
      .studio-node[data-selected="true"] { box-shadow: 0 0 0 2px var(--studio-focus); }
      .studio-node-label { font-weight: bold; font-size: 13px; color: var(--studio-text-strong); }
      .studio-node-kind {
        color: var(--studio-text-muted);
        text-transform: uppercase;
        font-size: 10px;
        letter-spacing: 0.02em;
        margin-top: 2px;
      }
      .studio-node-counts { color: var(--studio-text-subtle); margin-top: 4px; }
      .studio-node-badge {
        position: absolute;
        top: -8px;
        right: -8px;
        min-width: 16px;
        height: 16px;
        padding: 0 4px;
        border-radius: 8px;
        background: var(--studio-severity-error);
        color: var(--studio-chip-text);
        font-size: 10px;
        font-weight: bold;
        line-height: 16px;
        text-align: center;
      }
      .studio-detail-back {
        display: block;
        margin: 0 0 12px;
        padding: 4px 0;
        border: none;
        background: none;
        color: var(--studio-text);
        font-size: 13px;
        cursor: pointer;
      }
      .studio-detail-back:hover { text-decoration: underline; }
      .studio-detail-title { margin: 0; font-size: 16px; color: var(--studio-text-strong); }
      .studio-detail-section { margin-top: 16px; }
      .studio-detail-section h3 {
        font-size: 13px;
        text-transform: uppercase;
        color: var(--studio-text-muted);
        margin: 0 0 6px;
      }
      .studio-detail-empty { font-size: 12px; color: var(--studio-text-muted); margin: 0; }
      .studio-detail-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }
      .studio-detail-table th {
        text-align: left;
        color: var(--studio-text-muted);
        font-weight: normal;
        border-bottom: 1px solid var(--studio-border);
        padding: 4px 6px 4px 0;
      }
      .studio-detail-table td {
        padding: 4px 6px 4px 0;
        border-bottom: 1px solid var(--studio-border-subtle);
      }
      .studio-detail-unbound { font-style: italic; color: var(--studio-text-muted); }
      .studio-required-badge {
        display: inline-block;
        padding: 1px 6px;
        border-radius: 3px;
        background: var(--studio-severity-none);
        color: var(--studio-text-subtle);
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.02em;
      }
      .studio-detail-schema {
        white-space: pre-wrap;
        word-break: break-word;
        font-family: ui-monospace, SFMono-Regular, monospace;
        font-size: 11px;
        background: var(--studio-surface-raised);
        border-radius: 6px;
        padding: 10px;
        margin: 6px 0 0;
      }
      .studio-detail-branch {
        margin-top: 12px;
        padding: 8px 10px;
        border: 1px solid var(--studio-border);
        border-radius: 6px;
      }
      .studio-detail-branch h4 { margin: 0 0 6px; font-size: 12px; }
      .studio-detail-issue-list {
        list-style: none;
        margin: 6px 0 0;
        padding: 0;
      }
      .studio-detail-issue {
        padding: 6px 0 6px 8px;
        border-left: 3px solid var(--studio-severity-none);
        border-bottom: 1px solid var(--studio-border-subtle);
        font-size: 12px;
      }
      .studio-status { padding: 24px; font-size: 14px; }
      .studio-status-error { color: var(--studio-severity-error); }
      .studio-option-broken { color: var(--studio-severity-error); }
      .studio-dialog-backdrop {
        position: fixed;
        inset: 0;
        background: var(--studio-backdrop);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10;
      }
      .studio-dialog {
        background: var(--studio-surface);
        color: var(--studio-text);
        border: 1px solid var(--studio-border);
        border-radius: 8px;
        padding: 20px 24px;
        max-width: 560px;
        width: calc(100% - 48px);
        max-height: calc(100% - 48px);
        overflow-y: auto;
        box-shadow: var(--studio-dialog-shadow);
      }
      .studio-dialog h2 {
        margin: 0 0 12px;
        font-size: 15px;
        color: var(--studio-severity-error);
      }
      .studio-dialog-message {
        white-space: pre-wrap;
        word-break: break-word;
        font-family: ui-monospace, SFMono-Regular, monospace;
        font-size: 12px;
        background: var(--studio-surface-raised);
        border-radius: 6px;
        padding: 12px;
        margin: 0 0 16px;
      }
      .studio-dialog-close {
        padding: 6px 14px;
        border: 1px solid var(--studio-border);
        border-radius: 4px;
        background: var(--studio-surface-raised);
        color: var(--studio-text);
        cursor: pointer;
      }
      .studio-dialog-close:hover { background: var(--studio-hover); }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.js"></script>
  </body>
</html>
`;
