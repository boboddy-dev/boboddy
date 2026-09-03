import type { DefinitionValidationIssue } from "@boboddy/sdk/definitions/validation";
import type {
  StudioNode,
  StudioNodeInputField,
  StudioNodeOutputSignal,
  StudioParallelBranchShape,
} from "./studio-graph-types";
import { SeverityChip } from "./SeverityChip";
import { severityColor } from "./studio-graph-visuals";

/** One row of an issue list — full message text, colored by its own severity. */
function IssueMessageRow({ issue }: { issue: DefinitionValidationIssue }) {
  return (
    <li className="studio-detail-issue" style={{ borderLeftColor: severityColor(issue.severity) }}>
      <div className="studio-issue-header">
        <SeverityChip severity={issue.severity} />
        <span className="studio-issue-check">{issue.check}</span>
      </div>
      {issue.message}
    </li>
  );
}

function IssueMessageList({ issues }: { issues: readonly DefinitionValidationIssue[] }) {
  if (issues.length === 0) {
    return <p className="studio-issues-empty">No validation issues.</p>;
  }
  return (
    <ul className="studio-detail-issue-list">
      {issues.map((issue, index) => (
        <IssueMessageRow key={`${issue.check}-${issue.branchKey ?? ""}-${String(index)}`} issue={issue} />
      ))}
    </ul>
  );
}

/** A "required" pill shown next to input/output field names. */
function RequiredBadge({ required }: { required: boolean }) {
  if (!required) return null;
  return <span className="studio-required-badge">required</span>;
}

function InputFieldsTable({ fields }: { fields: readonly StudioNodeInputField[] }) {
  if (fields.length === 0) {
    return <p className="studio-detail-empty">No additional input fields.</p>;
  }
  return (
    <table className="studio-detail-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Type</th>
          <th>Required</th>
          <th>Bound to</th>
        </tr>
      </thead>
      <tbody>
        {fields.map((field) => (
          <tr key={field.name}>
            <td>{field.name}</td>
            <td>{field.type}</td>
            <td>
              <RequiredBadge required={field.required} />
            </td>
            <td className={field.boundTo === null ? "studio-detail-unbound" : undefined}>
              {field.boundTo ?? "unbound"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function OutputSignalsTable({ signals }: { signals: readonly StudioNodeOutputSignal[] }) {
  if (signals.length === 0) {
    return <p className="studio-detail-empty">No declared output signals.</p>;
  }
  return (
    <table className="studio-detail-table">
      <thead>
        <tr>
          <th>Key</th>
          <th>Type</th>
          <th>Required</th>
        </tr>
      </thead>
      <tbody>
        {signals.map((signal) => (
          <tr key={signal.key}>
            <td>{signal.key}</td>
            <td>{signal.type}</td>
            <td>
              <RequiredBadge required={signal.required} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ParallelBranchSection({ branch }: { branch: StudioParallelBranchShape }) {
  return (
    <div className="studio-detail-branch">
      <h4>{branch.label}</h4>
      {branch.inputFields === null ? (
        <p className="studio-detail-empty">Shape unknown — this branch's step wasn't found.</p>
      ) : (
        <InputFieldsTable fields={branch.inputFields} />
      )}
      <IssueMessageList issues={branch.issues} />
    </div>
  );
}

/**
 * The right-hand `<aside>`'s content when a node is selected (Phase 5) —
 * swapped in for `IssuesPanel` by `App.tsx`. Renders the node's own
 * step-derived shape (per `StudioNodeShape.kind`) plus its own filtered
 * issue messages (full text, not counts — those live on the graph badge).
 */
export function NodeDetailPanel({
  node,
  onBack,
}: {
  node: StudioNode;
  onBack: () => void;
}) {
  const { data } = node;
  const { shape } = data;

  return (
    <div className="studio-detail">
      <button type="button" className="studio-detail-back" onClick={onBack}>
        ← Back to issues
      </button>
      <h2 className="studio-detail-title">{data.label}</h2>
      <div className="studio-node-kind">{data.kind}</div>

      {shape.kind === "step" ? (
        <>
          <section className="studio-detail-section">
            <h3>Input fields</h3>
            <InputFieldsTable fields={shape.inputFields} />
          </section>
          <section className="studio-detail-section">
            <h3>Output signals</h3>
            <OutputSignalsTable signals={shape.outputSignals} />
          </section>
          <section className="studio-detail-section">
            <details>
              <summary>Result schema (raw JSON)</summary>
              <pre className="studio-detail-schema">
                {JSON.stringify(shape.resultSchemaJson, null, 2)}
              </pre>
            </details>
          </section>
        </>
      ) : null}

      {shape.kind === "parallel" ? (
        <section className="studio-detail-section">
          <h3>Branches</h3>
          {shape.branches.map((branch) => (
            <ParallelBranchSection key={branch.key} branch={branch} />
          ))}
        </section>
      ) : null}

      <section className="studio-detail-section">
        <h3>Issues</h3>
        <IssueMessageList issues={data.issues} />
      </section>
    </div>
  );
}
