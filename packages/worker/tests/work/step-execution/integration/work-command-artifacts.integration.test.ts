/**
 * Integration test for artifact persistence in the `work` command.
 *
 * Verifies that after the OpenCode agent session stops, the worker collects
 * files from <workspace>/.boboddy/step-artifacts/ and persists them through
 * the ArtifactStore (LocalArtifactStore pointed at a temp dir for this test).
 *
 * Artifact files are pre-seeded into the workspace bind-mount by the
 * SeedingGitCloneService (a wrapper around FakeGitCloneService that writes
 * configured files into step-artifacts/ after the dummy repo is copied). This
 * guarantees the files exist on the host before collectStepArtifacts runs,
 * without requiring the fake AI to execute arbitrary commands.
 *
 * What is faked (same as the happy-path test):
 *   - Platform server: FakeStepExecutionWorkerClient
 *   - AI provider: FakeAiServer
 *   - git clone: SeedingGitCloneService (FakeGitCloneService + artifact seeds)
 *
 * What this test adds over the happy-path test:
 *   - Injects a LocalArtifactStore pointed at a dedicated temp dir.
 *   - Seeds two artifact files (a flat file and a nested file) into the
 *     workspace step-artifacts dir before the agent starts.
 *   - After runProjectWork completes, asserts both files have been copied into
 *     the artifact store at the expected paths with the expected content.
 *
 * Gated behind BOBODDY_INTEGRATION=true.
 *
 * Run with:
 *   BOBODDY_INTEGRATION=true bun test tests/work/step-execution/integration
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import { LocalArtifactStore } from "../../../../src/artifacts/artifact-store/infra/local-artifact-store";
import { runProjectWork } from "../../../../src/work/step-execution/application/run-project-work";
import { FakeAiServer } from "./helpers/fake-ai-server";
import { FakeStepExecutionWorkerClient } from "./helpers/fake-worker-client";
import { buildIntegrationDeps } from "./helpers/build-integration-deps";
import { buildSingleStepScenario } from "./helpers/scenario";
import type { ContainerRegistry } from "./helpers/containers/container-registry";

const integrationEnabled = process.env["BOBODDY_INTEGRATION"] === "true";
const keepContainers =
  process.env["BOBODDY_INTEGRATION_KEEP_CONTAINERS"] === "true";
const TEST_TIMEOUT_MS = 5 * 60 * 1000;

function resolveFakeAiHost(): string {
  const configured = process.env["BOBODDY_FAKE_AI_HOST"]?.trim();
  if (configured) return configured;
  return "host.docker.internal";
}

async function seedOpencodeConfig(
  configHomeDir: string,
  fakeAiPort: number,
): Promise<void> {
  const configDir = path.join(configHomeDir, ".config", "opencode");
  await mkdir(configDir, { recursive: true });
  const config = {
    model: "anthropic/claude-3-5-haiku-latest",
    provider: {
      anthropic: {
        options: {
          baseURL: `http://${resolveFakeAiHost()}:${String(fakeAiPort)}`,
          apiKey: "fake-key",
        },
      },
    },
  };
  await writeFile(
    path.join(configDir, "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
}

describe.skipIf(!integrationEnabled)(
  "work command artifact persistence (integration)",
  () => {
    let fakeAi: FakeAiServer;
    let homeDir: string;
    let artifactsBaseDir: string;
    let originalHome: string | undefined;
    let containerRegistry: ContainerRegistry | undefined;

    beforeEach(async () => {
      if (process.env["TESTCONTAINERS_RYUK_DISABLED"] === undefined) {
        process.env["TESTCONTAINERS_RYUK_DISABLED"] = "true";
      }

      fakeAi = new FakeAiServer();
      homeDir = await mkdtemp(
        path.join(os.tmpdir(), "boboddy-work-artifacts-it-home-"),
      );
      artifactsBaseDir = await mkdtemp(
        path.join(os.tmpdir(), "boboddy-work-artifacts-it-store-"),
      );
      originalHome = process.env["HOME"];
      process.env["HOME"] = homeDir;
    });

    afterEach(async () => {
      if (keepContainers) {
        containerRegistry = undefined;
        await fakeAi.stop().catch(() => undefined);
        if (originalHome === undefined) {
          delete process.env["HOME"];
        } else {
          process.env["HOME"] = originalHome;
        }
        return;
      }

      await containerRegistry?.stopAll();
      containerRegistry = undefined;
      await fakeAi.stop().catch(() => undefined);
      if (originalHome === undefined) {
        delete process.env["HOME"];
      } else {
        process.env["HOME"] = originalHome;
      }
      await rm(homeDir, { recursive: true, force: true }).catch(() => undefined);
      await rm(artifactsBaseDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
    });

    test(
      "collects seeded step-artifacts and persists them to the artifact store",
      async () => {
        const projectId = createUuidV7();
        const stepExecutionId = createUuidV7();
        const findings = { confidence: 1, summary: "artifact persistence ok" };

        const scenario = buildSingleStepScenario({
          projectId,
          stepExecutionId,
          stepDefinitionId: createUuidV7(),
          prompt: "Submit the integration findings.",
          findings,
        });

        // Two artifacts: a flat file and a nested file, to verify that the
        // recursive readdir walk in collectStepArtifacts preserves the relative
        // directory structure (relativeStorePath) when copying into the store.
        const seedArtifacts = [
          {
            relativePath: "report.txt",
            content: "artifact-report-contents",
          },
          {
            relativePath: path.join("logs", "run.log"),
            content: "artifact-run-log-contents",
          },
        ];

        const artifactStore = new LocalArtifactStore(artifactsBaseDir);

        const fakeAiPort = await fakeAi.start();
        fakeAi.configure(findings);
        await seedOpencodeConfig(homeDir, fakeAiPort);

        const workerClient = new FakeStepExecutionWorkerClient(scenario);
        const built = buildIntegrationDeps({
          workerClient,
          verbose: process.env["BOBODDY_INTEGRATION_VERBOSE"] === "true",
          seedArtifacts,
          artifactStore,
        });
        containerRegistry = built.containerRegistry;

        const result = await runProjectWork(
          {
            projectId,
            baseUrl: "http://127.0.0.1:1",
            concurrency: 1,
            batchSize: 1,
            pollIntervalMs: 5_000,
            leaseDurationSeconds: 60,
            once: true,
            preserveRuntimeOnComplete: keepContainers,
          },
          built.deps,
        );

        // Step still completes successfully despite the artifact collection.
        expect(result.claimedCount).toBe(1);
        expect(result.processedCount).toBe(1);
        expect(result.skippedCount).toBe(0);
        expect(workerClient.completeCalls).toHaveLength(1);
        expect(workerClient.failCalls).toHaveLength(0);
        expect(workerClient.completeCalls[0]?.resultJson).toEqual(findings);

        // Both artifact files were copied into the artifact store under the
        // correct stepExecutionId prefix with their relative paths intact.
        for (const seed of seedArtifacts) {
          const storedPath = path.join(
            artifactsBaseDir,
            stepExecutionId,
            seed.relativePath,
          );
          const storedContent = await readFile(storedPath, "utf8");
          expect(storedContent).toBe(seed.content);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
