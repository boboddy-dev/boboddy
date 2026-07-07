import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { StepExecutionRunTracker } from "../contracts/process-project-work-types";

export type LocalRuntimeSessionStatus =
  | "launching"
  | "running"
  | "succeeded"
  | "failed";

export type LocalRuntimeSessionRecord = {
  id: string;
  projectId: string;
  stepExecutionId: string;
  status: LocalRuntimeSessionStatus;
  workspacePath: string | null;
  runtimeContainerId: string | null;
  agentBaseUrl: string | null;
  opencodeSessionId: string | null;
  failureReason: string | null;
  metadataJson: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type LocalRuntimeSessionStore = StepExecutionRunTracker & {
  createSession(input: {
    id: string;
    projectId: string;
    stepExecutionId: string;
    metadataJson?: string | null | undefined;
  }): void;
  markRunning(input: {
    id: string;
    workspacePath: string;
    runtimeContainerId: string | null;
    agentBaseUrl: string;
    metadataJson?: string | null | undefined;
  }): void;
  attachAgentSession(input: {
    id: string;
    agentSessionId: string;
    metadataJson?: string | null | undefined;
  }): void;
  markSucceeded(input: {
    id: string;
    metadataJson?: string | null | undefined;
  }): void;
  markFailed(input: {
    id: string;
    failureReason: string;
    metadataJson?: string | null | undefined;
  }): void;
  close(): void;
};

const DEFAULT_DB_PATH = path.join(homedir(), ".boboddy", "db.sqlite");

export const getDefaultLocalRuntimeSessionDbPath = () =>
  process.env["BOBODDY_LOCAL_DB_PATH"]?.trim() || DEFAULT_DB_PATH;

export class SqliteLocalRuntimeSessionStore implements LocalRuntimeSessionStore {
  private readonly db: Database;

  constructor(databasePath = getDefaultLocalRuntimeSessionDbPath()) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath, { create: true, strict: true });
    this.db.run(`
      CREATE TABLE IF NOT EXISTS local_runtime_sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        step_execution_id TEXT NOT NULL,
        status TEXT NOT NULL,
        workspace_path TEXT,
        runtime_container_id TEXT,
        agent_base_url TEXT,
        opencode_session_id TEXT,
        failure_reason TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
    `);
  }

  createSession(input: {
    id: string;
    projectId: string;
    stepExecutionId: string;
    metadataJson?: string | null | undefined;
  }) {
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO local_runtime_sessions (
          id,
          project_id,
          step_execution_id,
          status,
          metadata_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, 'launching', ?, ?, ?)`,
      )
      .run(
        input.id,
        input.projectId,
        input.stepExecutionId,
        input.metadataJson ?? null,
        now,
        now,
      );
  }

  markRunning(input: {
    id: string;
    workspacePath: string;
    runtimeContainerId: string | null;
    agentBaseUrl: string;
    metadataJson?: string | null | undefined;
  }) {
    this.update(
      input.id,
      "running",
      {
        workspace_path: input.workspacePath,
        runtime_container_id: input.runtimeContainerId,
        agent_base_url: input.agentBaseUrl,
        metadata_json: input.metadataJson ?? null,
      },
      false,
    );
  }

  attachAgentSession(input: {
    id: string;
    agentSessionId: string;
    metadataJson?: string | null | undefined;
  }) {
    const existing = this.getRecord(input.id);
    this.update(
      input.id,
      existing.status,
      {
        opencode_session_id: input.agentSessionId,
        metadata_json: input.metadataJson ?? existing.metadataJson,
      },
      false,
    );
  }

  markSucceeded(input: {
    id: string;
    metadataJson?: string | null | undefined;
  }) {
    this.update(
      input.id,
      "succeeded",
      {
        metadata_json:
          input.metadataJson ?? this.getRecord(input.id).metadataJson,
      },
      true,
    );
  }

  markFailed(input: {
    id: string;
    failureReason: string;
    metadataJson?: string | null | undefined;
  }) {
    this.update(
      input.id,
      "failed",
      {
        failure_reason: input.failureReason,
        metadata_json:
          input.metadataJson ?? this.getRecord(input.id).metadataJson,
      },
      true,
    );
  }

  close() {
    this.db.close();
  }

  private getRecord(id: string): LocalRuntimeSessionRecord {
    const record = this.db
      .query<
        LocalRuntimeSessionRecord,
        [string]
      >("SELECT * FROM local_runtime_sessions WHERE id = ?")
      .get(id);

    if (!record) {
      throw new Error(`Local runtime session ${id} was not found`);
    }

    return record;
  }

  private update(
    id: string,
    status: LocalRuntimeSessionStatus,
    fields: Record<string, string | null>,
    setCompletedAt: boolean,
  ) {
    const updatedAt = new Date().toISOString();
    const entries = Object.entries(fields);
    const assignments = entries.map(([key]) => `${key} = ?`);

    assignments.push("status = ?", "updated_at = ?");
    if (setCompletedAt) {
      assignments.push("completed_at = ?");
    }

    const values = entries.map(([, value]) => value);
    values.push(status, updatedAt);
    if (setCompletedAt) {
      values.push(updatedAt);
    }
    values.push(id);

    this.db
      .query(
        `UPDATE local_runtime_sessions SET ${assignments.join(", ")} WHERE id = ?`,
      )
      .run(...values);
  }
}
