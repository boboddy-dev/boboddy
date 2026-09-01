import { useEffect, useMemo, useState } from "react";
import type { DefinitionValidationIssue } from "@boboddy/sdk/definitions/validation";
import type { BrokenPipeline } from "@boboddy/sdk/push";
import { PipelineGraphView } from "./graph/PipelineGraphView";
import type { StudioSnapshot } from "./graph/studio-graph-types";

function IssueRow({
  issue,
}: {
  issue: DefinitionValidationIssue;
}) {
  return (
    <li className="studio-issue">
      <span className="studio-issue-check">{issue.check}</span>
      {issue.message}
    </li>
  );
}

/**
 * Subscribes to the studio server's `/api/stream` SSE endpoint and re-renders
 * on every message. Read-only, v1 scope: nothing here ever writes back to the
 * source directory — see docs/research/flat-pipeline-sdk-and-visual-designer.md §3.
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
}: {
  issues: readonly DefinitionValidationIssue[];
}) {
  if (issues.length === 0) {
    return <p className="studio-issues-empty">No validation issues.</p>;
  }
  return (
    <ul className="studio-issues-list">
      {issues.map((issue, index) => (
        <IssueRow key={`${issue.check}-${issue.nodeKey ?? ""}-${String(index)}`} issue={issue} />
      ))}
    </ul>
  );
}

/**
 * Shown when the user picks a broken pipeline from the header dropdown —
 * see `App`'s `handleSelect`. Dismissible via the close button, the Escape
 * key, or clicking the backdrop; the picker's own selection is left as-is,
 * so re-opening just means picking the same (still broken) entry again.
 */
function BrokenPipelineDialog({
  pipeline,
  onClose,
}: {
  pipeline: BrokenPipeline;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div className="studio-dialog-backdrop" onClick={onClose}>
      <div
        className="studio-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="studio-dialog-title"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <h2 id="studio-dialog-title">{`"${pipeline.key}" failed to compile`}</h2>
        <pre className="studio-dialog-message">{pipeline.message}</pre>
        <button type="button" className="studio-dialog-close" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

export function App() {
  const snapshot = useStudioSnapshot();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [dialogPipeline, setDialogPipeline] = useState<BrokenPipeline | null>(null);

  const pipelines = snapshot?.status === "ok" ? snapshot.pipelines : [];
  const brokenPipelines = snapshot?.status === "ok" ? snapshot.brokenPipelines : [];

  // Falls back to the first WORKING pipeline, never a broken one — a broken
  // selection has no graph to show, only the dialog below.
  const selected = useMemo(
    () =>
      pipelines.find((p) => p.key === selectedKey) ?? pipelines[0] ?? null,
    [pipelines, selectedKey],
  );

  function handleSelect(key: string): void {
    setSelectedKey(key);
    setDialogPipeline(brokenPipelines.find((p) => p.key === key) ?? null);
  }

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
          value={selectedKey ?? selected?.key ?? ""}
          onChange={(event) => {
            handleSelect(event.target.value);
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
      </header>
      <div className="studio-graph">
        {selected ? (
          <PipelineGraphView key={selected.key} nodes={selected.nodes} edges={selected.edges} />
        ) : (
          <p className="studio-status">
            Every pipeline in .boboddy/pipeline-builder currently has an error — pick one above to see it.
          </p>
        )}
      </div>
      <aside className="studio-issues">
        <h2>Validation issues</h2>
        <IssuesPanel issues={snapshot.validationIssues} />
      </aside>
      {dialogPipeline ? (
        <BrokenPipelineDialog
          pipeline={dialogPipeline}
          onClose={() => {
            setDialogPipeline(null);
          }}
        />
      ) : null}
    </div>
  );
}
