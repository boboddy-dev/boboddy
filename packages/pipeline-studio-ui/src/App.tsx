import { useEffect, useMemo, useState } from "react";
import type { DefinitionValidationIssue } from "@boboddy/sdk/definitions/validation";
import type { BrokenPipeline } from "@boboddy/sdk/push";
import { NodeDetailPanel } from "./graph/NodeDetailPanel";
import { PipelineGraphView } from "./graph/PipelineGraphView";
import { SeverityChip } from "./graph/SeverityChip";
import type { StudioSnapshot } from "./graph/studio-graph-types";
import { useStudioTheme } from "./theme";

/**
 * One issue row. Step-only issues (`nodeKey === undefined`, e.g.
 * `signal-source-path`/`health-check-*`) have no node to jump to and render
 * as a plain, non-interactive row; everything else is clickable and selects
 * the node it's about, swapping in `NodeDetailPanel` (see `App`).
 */
function IssueRow({
  issue,
  onSelectNode,
}: {
  issue: DefinitionValidationIssue;
  onSelectNode: (nodeKey: string) => void;
}) {
  if (issue.nodeKey === undefined) {
    return (
      <li className="studio-issue">
        <div className="studio-issue-header">
          <SeverityChip severity={issue.severity} />
          <span className="studio-issue-check">{issue.check}</span>
        </div>
        {issue.message}
      </li>
    );
  }

  const nodeKey = issue.nodeKey;

  return (
    <li
      className="studio-issue studio-issue-clickable"
      role="button"
      tabIndex={0}
      onClick={() => {
        onSelectNode(nodeKey);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelectNode(nodeKey);
        }
      }}
    >
      <div className="studio-issue-header">
        <SeverityChip severity={issue.severity} />
        <span className="studio-issue-check">{issue.check}</span>
      </div>
      {issue.message}
    </li>
  );
}

/**
 * Subscribes to the studio server's `/api/stream` SSE endpoint and re-renders
 * on every message. Read-only, v1 scope: nothing here ever writes back to the
 * source directory.
 */
function useStudioSnapshot(): StudioSnapshot | null {
  const [snapshot, setSnapshot] = useState<StudioSnapshot | null>(null);

  useEffect(() => {
    const source = new EventSource("/api/stream");
    source.onmessage = (event: MessageEvent<string>) => {
      try {
        setSnapshot(JSON.parse(event.data) as StudioSnapshot);
      } catch (error) {
        console.error("Failed to parse studio snapshot", error);
      }
    };
    source.onerror = () => {
      // EventSource retries automatically; nothing to do but wait.
    };
    return () => {
      source.close();
    };
  }, []);

  return snapshot;
}

function IssuesPanel({
  issues,
  hasCompileErrors,
  onSelectNode,
}: {
  issues: readonly DefinitionValidationIssue[];
  hasCompileErrors: boolean;
  onSelectNode: (nodeKey: string) => void;
}) {
  if (issues.length === 0) {
    return (
      <p className="studio-issues-empty">
        {hasCompileErrors
          ? "Files that fail to compile can't be validated — fix the compile errors above first."
          : "No validation issues."}
      </p>
    );
  }
  return (
    <ul className="studio-issues-list">
      {issues.map((issue, index) => (
        <IssueRow
          key={`${issue.check}-${issue.nodeKey ?? ""}-${String(index)}`}
          issue={issue}
          onSelectNode={onSelectNode}
        />
      ))}
    </ul>
  );
}

/**
 * Takes the graph's place when the selected entry failed to compile, so the
 * error is on screen the moment it's selected (or the moment the studio opens
 * on a directory with nothing working) rather than behind a dialog.
 */
function BrokenPipelinePanel({ pipeline }: { pipeline: BrokenPipeline }) {
  return (
    <section className="studio-broken" role="alert" aria-labelledby="studio-broken-title">
      <h2 id="studio-broken-title" className="studio-broken-title">
        {`${pipeline.key}.ts failed to compile`}
      </h2>
      <pre className="studio-broken-message">{pipeline.message}</pre>
      <p className="studio-broken-hint">
        Fix the file in .boboddy/pipeline-builder and save — the studio reloads automatically.
      </p>
    </section>
  );
}

/**
 * Every file that failed to compile, listed above the validation issues so the
 * sidebar never reads "No validation issues" while something is broken.
 * Clicking a row selects that entry, which shows its full error in place of
 * the graph.
 */
function CompileErrorsPanel({
  pipelines,
  selectedKey,
  onSelect,
}: {
  pipelines: readonly BrokenPipeline[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  return (
    <>
      <h2>Compile errors</h2>
      <ul className="studio-issues-list">
        {pipelines.map((pipeline) => (
          <li
            key={pipeline.key}
            className="studio-issue studio-issue-clickable"
            role="button"
            tabIndex={0}
            aria-current={pipeline.key === selectedKey ? "true" : undefined}
            onClick={() => {
              onSelect(pipeline.key);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(pipeline.key);
              }
            }}
          >
            <div className="studio-issue-header">
              <SeverityChip severity="error" />
              <span className="studio-issue-check">{`${pipeline.key}.ts`}</span>
            </div>
            <span className="studio-compile-error-message">{pipeline.message}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

export function App() {
  const snapshot = useStudioSnapshot();
  const { theme, toggleTheme } = useStudioTheme();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedNodeKey, setSelectedNodeKey] = useState<string | null>(null);

  const pipelines = snapshot?.status === "ok" ? snapshot.pipelines : [];
  const brokenPipelines = snapshot?.status === "ok" ? snapshot.brokenPipelines : [];

  // A broken entry is shown only when it's explicitly selected, or when there
  // is no working pipeline to fall back to — then the first error is shown
  // straight away instead of an empty graph area.
  const selectedBroken = useMemo(
    () =>
      brokenPipelines.find((p) => p.key === selectedKey) ??
      (pipelines.length === 0 ? (brokenPipelines[0] ?? null) : null),
    [brokenPipelines, pipelines, selectedKey],
  );

  const selected = useMemo(
    () =>
      selectedBroken
        ? null
        : (pipelines.find((p) => p.key === selectedKey) ?? pipelines[0] ?? null),
    [pipelines, selectedBroken, selectedKey],
  );

  // A selected node id from a previous pipeline is meaningless (and likely
  // nonexistent) once the picker switches pipelines — reset to the issues
  // list rather than showing a stale/broken detail panel.
  useEffect(() => {
    setSelectedNodeKey(null);
  }, [selected?.key]);

  const selectedNode = selected?.nodes.find((n) => n.id === selectedNodeKey) ?? null;

  // Narrows the full-batch `validationIssues` down to the currently selected
  // pipeline's own issues, PLUS step-only issues (`pipelineKey === undefined`
  // — `signal-source-path`/`health-check-*`) — those never belong to any one
  // pipeline and would otherwise be unreachable from every picker selection,
  // so they stay visible regardless of what's selected. Matches
  // `issuesForPipeline`'s filter in `translate-spec-to-graph.ts` (which
  // deliberately excludes step-only issues, since it's building per-pipeline
  // GRAPH data that has no node to attach them to) plus that broader
  // "always show step-only" carve-out. When a broken entry is showing
  // (`selected === null`), this only shows step-only issues — there's no
  // working pipeline for the pipeline-scoped half to match.
  const validationIssues = snapshot?.status === "ok" ? snapshot.validationIssues : [];
  const filteredIssues = useMemo(
    () =>
      validationIssues.filter(
        (issue) => issue.pipelineKey === selected?.key || issue.pipelineKey === undefined,
      ),
    [validationIssues, selected],
  );

  if (snapshot === null) {
    return <p className="studio-status">Connecting…</p>;
  }

  if (snapshot.status === "error") {
    return <p className="studio-status studio-status-error">{snapshot.message}</p>;
  }

  if (pipelines.length === 0 && brokenPipelines.length === 0) {
    return (
      <p className="studio-status">
        No pipelines found in .boboddy/pipeline-builder yet.
      </p>
    );
  }

  return (
    <div className="studio-layout">
      <header className="studio-header">
        <select
          value={selected?.key ?? selectedBroken?.key ?? ""}
          onChange={(event) => {
            setSelectedKey(event.target.value);
          }}
        >
          {pipelines.map((p) => (
            <option key={p.key} value={p.key}>
              {p.name}
            </option>
          ))}
          {brokenPipelines.map((p) => (
            <option key={p.key} value={p.key} className="studio-option-broken">
              {`⚠ ${p.key} (error)`}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="studio-theme-toggle"
          onClick={toggleTheme}
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
        >
          {theme === "dark" ? "Light mode" : "Dark mode"}
        </button>
      </header>
      <div className="studio-graph">
        {selected ? (
          <PipelineGraphView
            key={selected.key}
            nodes={selected.nodes}
            edges={selected.edges}
            colorMode={theme}
            onSelectNode={setSelectedNodeKey}
            onDeselect={() => {
              setSelectedNodeKey(null);
            }}
          />
        ) : selectedBroken ? (
          <BrokenPipelinePanel pipeline={selectedBroken} />
        ) : null}
      </div>
      <aside className="studio-issues">
        {selectedNode ? (
          <NodeDetailPanel
            node={selectedNode}
            onBack={() => {
              setSelectedNodeKey(null);
            }}
          />
        ) : (
          <>
            {brokenPipelines.length > 0 ? (
              <CompileErrorsPanel
                pipelines={brokenPipelines}
                selectedKey={selectedBroken?.key ?? null}
                onSelect={setSelectedKey}
              />
            ) : null}
            <h2>Validation issues</h2>
            <IssuesPanel
              issues={filteredIssues}
              hasCompileErrors={brokenPipelines.length > 0}
              onSelectNode={setSelectedNodeKey}
            />
          </>
        )}
      </aside>
    </div>
  );
}
