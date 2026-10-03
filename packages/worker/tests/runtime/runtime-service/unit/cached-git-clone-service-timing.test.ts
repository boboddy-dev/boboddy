/**
 * Unit tests for the timing and fallback lines {@link CachedGitCloneService}
 * emits through the work logger: they are the only trace of where clone time
 * went (or why the cache was skipped) in the shipped step log, so they must be
 * at info (`log`) level, scoped `git-cache`, and free of URL credentials.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { GitCommandError } from "../../../../src/runtime/runtime-service/infra/git-failure";
import {
  runGit,
  type GitRunner,
} from "../../../../src/runtime/runtime-service/infra/run-git";
import {
  createRecordingWorkLogger,
  type RecordedLogEntry,
} from "../../../support/recording-work-logger";
import { setupCachedCloneFixture } from "./cached-git-clone-fixtures";

const SECONDS = String.raw`\d+\.\d+s`;
const MIRROR_CREATED = new RegExp(
  `^git-cache: mirror created in ${SECONDS} \\(miss\\)$`,
  "u",
);
const MIRROR_REFRESHED = new RegExp(
  `^git-cache: mirror refreshed in ${SECONDS} \\(hit\\)$`,
  "u",
);
const LOCAL_CLONE = new RegExp(`^git-cache: local clone in ${SECONDS}$`, "u");
const PLAIN_CLONE = new RegExp(
  `^git-cache: plain clone in ${SECONDS} \\(fallback\\)$`,
  "u",
);
const FALLBACK_REASON = "git-cache: falling back to plain clone (";

const failAfterLocalClone: GitRunner = async (args, options) => {
  const stdout = await runGit(args, options);
  if (args.includes("clone")) {
    throw new GitCommandError(
      "git clone failed: fatal: bad object deadbeef",
      "fatal: bad object deadbeef",
      128,
    );
  }
  return stdout;
};

function messages(entries: RecordedLogEntry[]): string[] {
  return entries.map((entry) => entry.message);
}

describe("CachedGitCloneService timing lines", () => {
  test.concurrent(
    "first clone logs mirror creation as a miss, then the local clone",
    async () => {
      const fx = await setupCachedCloneFixture();
      const { entries, logger } = createRecordingWorkLogger();
      try {
        await fx.service.cloneRepository({
          gitUrl: fx.remote,
          workspacePath: fx.workspacePath,
          logger,
        });

        const lines = messages(entries);
        expect(lines).toHaveLength(2);
        expect(lines[0]).toMatch(MIRROR_CREATED);
        expect(lines[1]).toMatch(LOCAL_CLONE);
        expect(entries.every((entry) => entry.scope === "git-cache")).toBe(
          true,
        );
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "second clone logs the mirror refresh as a hit, then the local clone",
    async () => {
      const fx = await setupCachedCloneFixture();
      const { entries, logger } = createRecordingWorkLogger();
      try {
        await fx.service.cloneRepository({
          gitUrl: fx.remote,
          workspacePath: path.join(fx.root, "first"),
        });

        await fx.service.cloneRepository({
          gitUrl: fx.remote,
          workspacePath: fx.workspacePath,
          logger,
        });

        const lines = messages(entries);
        expect(lines).toHaveLength(2);
        expect(lines[0]).toMatch(MIRROR_REFRESHED);
        expect(lines[1]).toMatch(LOCAL_CLONE);
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "a refresh failure logs the reason and the timed plain clone with the fallback marker",
    async () => {
      const fx = await setupCachedCloneFixture();
      const { entries, logger } = createRecordingWorkLogger();
      try {
        await rm(fx.remote, { recursive: true, force: true });

        await fx.service.cloneRepository({
          gitUrl: fx.remote,
          workspacePath: fx.workspacePath,
          logger,
        });

        const lines = messages(entries);
        expect(lines).toHaveLength(2);
        expect(lines[0]).toStartWith(FALLBACK_REASON);
        expect(lines[1]).toMatch(PLAIN_CLONE);
        expect(lines.some((line) => LOCAL_CLONE.test(line))).toBe(false);
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "a failed local clone logs the reason and the timed plain clone, not a local clone time",
    async () => {
      const fx = await setupCachedCloneFixture({ runGit: failAfterLocalClone });
      const { entries, logger } = createRecordingWorkLogger();
      try {
        await fx.service.cloneRepository({
          gitUrl: fx.remote,
          workspacePath: fx.workspacePath,
          logger,
        });

        const lines = messages(entries);
        expect(lines).toHaveLength(3);
        expect(lines[0]).toMatch(MIRROR_CREATED);
        expect(lines[1]).toStartWith(FALLBACK_REASON);
        expect(lines[1]).toContain("bad object");
        expect(lines[2]).toMatch(PLAIN_CLONE);
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "a non-empty workspace logs why the cache was skipped and times the plain clone",
    async () => {
      const fx = await setupCachedCloneFixture();
      const { entries, logger } = createRecordingWorkLogger();
      try {
        await mkdir(fx.workspacePath, { recursive: true });
        await writeFile(path.join(fx.workspacePath, "keep.txt"), "keep");

        await fx.service.cloneRepository({
          gitUrl: fx.remote,
          workspacePath: fx.workspacePath,
          logger,
        });

        const lines = messages(entries);
        expect(lines).toHaveLength(2);
        expect(lines[0]).toStartWith(FALLBACK_REASON);
        expect(lines[0]).toContain("not empty");
        expect(lines[1]).toMatch(PLAIN_CLONE);
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "every line is emitted at info level: nothing goes to debug or error",
    async () => {
      const fx = await setupCachedCloneFixture();
      const { entries, logger } = createRecordingWorkLogger();
      try {
        await fx.service.cloneRepository({
          gitUrl: fx.remote,
          workspacePath: path.join(fx.root, "hit-miss"),
          logger,
        });
        await fx.service.cloneRepository({
          gitUrl: fx.remote,
          workspacePath: fx.workspacePath,
          logger,
        });
        await rm(fx.remote, { recursive: true, force: true });
        await fx.service.cloneRepository({
          gitUrl: fx.remote,
          workspacePath: path.join(fx.root, "fallback"),
          logger,
        });

        expect(entries.length).toBeGreaterThanOrEqual(6);
        expect(entries.every((entry) => entry.level === "log")).toBe(true);
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "no logged message or detail contains URL credentials",
    async () => {
      const secret = "s3cret-pass";
      const fx = await setupCachedCloneFixture();
      const { entries, logger } = createRecordingWorkLogger();
      try {
        await fx.service.cloneRepository({
          gitUrl: `https://user:${secret}@example.invalid/org/repo.git`,
          workspacePath: fx.workspacePath,
          logger,
        });

        const lines = messages(entries);
        expect(lines).toHaveLength(2);
        expect(lines[0]).toStartWith(FALLBACK_REASON);
        expect(lines[1]).toMatch(PLAIN_CLONE);
        expect(JSON.stringify(entries)).not.toContain(secret);
        expect(JSON.stringify(entries)).not.toContain("user:");
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "a token-only userinfo never appears in the fallback lines either",
    async () => {
      const token = "ghp_abcdef1234567890";
      const fx = await setupCachedCloneFixture();
      const { entries, logger } = createRecordingWorkLogger();
      try {
        await fx.service.cloneRepository({
          gitUrl: `https://${token}@example.invalid/org/repo.git`,
          workspacePath: fx.workspacePath,
          logger,
        });

        expect(entries.length).toBeGreaterThan(0);
        expect(JSON.stringify(entries)).not.toContain(token);
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );
});
