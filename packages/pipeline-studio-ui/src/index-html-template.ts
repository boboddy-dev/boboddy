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
      .studio-issue-check {
        display: block;
        font-weight: bold;
        color: #b34700;
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
