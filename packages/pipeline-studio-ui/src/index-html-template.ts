/**
 * The studio's single HTML page. `Bun.build` (see `build.ts`) always emits
 * `main.css` alongside `main.js` for this entrypoint — `App.tsx` imports
 * `@xyflow/react/dist/style.css`, so React Flow's own base styles live there
 * too, not just this file's own tiny layout rules (inlined below rather than
 * added to that generated file, since this template is the one place meant
 * to be hand-edited).
 */
export const STUDIO_INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Boboddy Pipeline Studio</title>
    <link rel="stylesheet" href="./main.css" />
    <style>
      html, body, #root { height: 100%; margin: 0; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #1a1a1a;
      }
      .studio-layout {
        display: grid;
        grid-template-columns: 1fr 320px;
        grid-template-rows: auto 1fr;
        height: 100%;
      }
      .studio-header {
        grid-column: 1 / -1;
        padding: 8px 16px;
        border-bottom: 1px solid #e2e2e2;
      }
      .studio-graph { grid-column: 1; grid-row: 2; }
      .studio-issues {
        grid-column: 2;
        grid-row: 2;
        overflow-y: auto;
        padding: 12px 16px;
        border-left: 1px solid #e2e2e2;
      }
      .studio-issues h2 { font-size: 14px; text-transform: uppercase; color: #666; }
      .studio-issues-list { list-style: none; margin: 0; padding: 0; }
      .studio-issue {
        padding: 8px 0;
        border-bottom: 1px solid #f0f0f0;
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
        color: #b34700;
      }
      .studio-severity-chip {
        display: inline-block;
        flex: none;
        padding: 1px 6px;
        border-radius: 3px;
        color: #fff;
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
      .studio-issue-clickable:hover { background: #f7f7f7; }
      .studio-issue-clickable:focus-visible {
        outline: 2px solid #1a1a1a;
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
        border: 2px solid #1a192b1a;
        border-radius: 6px;
        background: #fff;
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
        font-size: 12px;
      }
      .studio-node[data-selected="true"] { box-shadow: 0 0 0 2px #1a1a1a; }
      .studio-node-label { font-weight: bold; font-size: 13px; }
      .studio-node-kind {
        color: #666;
        text-transform: uppercase;
        font-size: 10px;
        letter-spacing: 0.02em;
        margin-top: 2px;
      }
      .studio-node-counts { color: #444; margin-top: 4px; }
      .studio-node-badge {
        position: absolute;
        top: -8px;
        right: -8px;
        min-width: 16px;
        height: 16px;
        padding: 0 4px;
        border-radius: 8px;
        background: #b00020;
        color: #fff;
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
        color: #1a1a1a;
        font-size: 13px;
        cursor: pointer;
      }
      .studio-detail-back:hover { text-decoration: underline; }
      .studio-detail-title { margin: 0; font-size: 16px; }
      .studio-detail-section { margin-top: 16px; }
      .studio-detail-section h3 {
        font-size: 13px;
        text-transform: uppercase;
        color: #666;
        margin: 0 0 6px;
      }
      .studio-detail-empty { font-size: 12px; color: #666; margin: 0; }
      .studio-detail-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }
      .studio-detail-table th {
        text-align: left;
        color: #666;
        font-weight: normal;
        border-bottom: 1px solid #e2e2e2;
        padding: 4px 6px 4px 0;
      }
      .studio-detail-table td {
        padding: 4px 6px 4px 0;
        border-bottom: 1px solid #f0f0f0;
      }
      .studio-detail-unbound { font-style: italic; color: #666; }
      .studio-required-badge {
        display: inline-block;
        padding: 1px 6px;
        border-radius: 3px;
        background: #1a192b1a;
        color: #444;
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.02em;
      }
      .studio-detail-schema {
        white-space: pre-wrap;
        word-break: break-word;
        font-family: ui-monospace, SFMono-Regular, monospace;
        font-size: 11px;
        background: #f7f7f7;
        border-radius: 6px;
        padding: 10px;
        margin: 6px 0 0;
      }
      .studio-detail-branch {
        margin-top: 12px;
        padding: 8px 10px;
        border: 1px solid #e2e2e2;
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
        border-left: 3px solid #1a192b1a;
        border-bottom: 1px solid #f0f0f0;
        font-size: 12px;
      }
      .studio-status { padding: 24px; font-size: 14px; }
      .studio-status-error { color: #b00020; }
      .studio-option-broken { color: #b00020; }
      .studio-dialog-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.4);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10;
      }
      .studio-dialog {
        background: #fff;
        border-radius: 8px;
        padding: 20px 24px;
        max-width: 560px;
        width: calc(100% - 48px);
        max-height: calc(100% - 48px);
        overflow-y: auto;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
      }
      .studio-dialog h2 {
        margin: 0 0 12px;
        font-size: 15px;
        color: #b00020;
      }
      .studio-dialog-message {
        white-space: pre-wrap;
        word-break: break-word;
        font-family: ui-monospace, SFMono-Regular, monospace;
        font-size: 12px;
        background: #f7f7f7;
        border-radius: 6px;
        padding: 12px;
        margin: 0 0 16px;
      }
      .studio-dialog-close {
        padding: 6px 14px;
        border: 1px solid #ccc;
        border-radius: 4px;
        background: #fff;
        cursor: pointer;
      }
      .studio-dialog-close:hover { background: #f0f0f0; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.js"></script>
  </body>
</html>
`;
