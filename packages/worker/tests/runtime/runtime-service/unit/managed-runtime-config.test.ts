/**
 * The synthesized managed devcontainer config: the rendered JSON per
 * (identifier, lockfile), the written file and its path, and that the real
 * devcontainer patcher can still read what we wrote (it strips `//...` before
 * parsing, so the config must contain no `//`).
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MANAGED_RUNTIME_IDS } from "@boboddy/sdk/managed-runtimes";
import { PIPELINE_BUILDER_DIR } from "@boboddy/sdk/push";
import { patchDevcontainerEnv } from "../../../../src/work/step-execution/infra/local-project-runtime-environment-helpers";
import { PIPELINE_BUILDER_LOCKFILES } from "../../../../src/runtime/runtime-service/domain/pipeline-builder-lockfiles";
import {
  managedRuntimeConfigPath,
  renderManagedRuntimeConfig,
  writeManagedRuntimeConfig,
} from "../../../../src/runtime/runtime-service/infra/managed-runtime-config";

const LOCKFILE_CASES = [
  null,
  ...PIPELINE_BUILDER_LOCKFILES.map((lockfile) => lockfile.name),
] as const;

describe("renderManagedRuntimeConfig", () => {
  test("renders every (identifier, lockfile) pair", () => {
    const rendered = Object.fromEntries(
      MANAGED_RUNTIME_IDS.flatMap((id) =>
        LOCKFILE_CASES.map((lockfile) => [
          `${id} / ${lockfile ?? "no lockfile"}`,
          JSON.parse(
            renderManagedRuntimeConfig({
              id,
              lockfilePresence: new Set(lockfile ? [lockfile] : []),
            }),
          ) as unknown,
        ]),
      ),
    );

    expect(rendered).toMatchSnapshot();
  });

  test.each([...MANAGED_RUNTIME_IDS])(
    "%s renders no // anywhere, which the devcontainer patcher would strip",
    (id) => {
      for (const lockfile of LOCKFILE_CASES) {
        const text = renderManagedRuntimeConfig({
          id,
          lockfilePresence: new Set(lockfile ? [lockfile] : []),
        });

        expect(text).not.toContain("//");
      }
    },
  );

  test("carries no cache volume, mounts or env of its own", () => {
    const config = JSON.parse(
      renderManagedRuntimeConfig({ id: "bun1", lockfilePresence: new Set() }),
    ) as Record<string, unknown>;

    expect(Object.keys(config).sort()).toEqual([
      "image",
      "name",
      "onCreateCommand",
      "remoteUser",
    ]);
  });
});

describe("managedRuntimeConfigPath", () => {
  test.each([...MANAGED_RUNTIME_IDS])(
    "%s lives at a devcontainer.json under the managed directory",
    (id) => {
      expect(managedRuntimeConfigPath(id)).toBe(
        `.boboddy/managed-devcontainers/${id}/devcontainer.json`,
      );
    },
  );
});

describe("writeManagedRuntimeConfig", () => {
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = await mkdtemp(path.join(os.tmpdir(), "managed-config-"));
    await mkdir(path.join(workspacePath, PIPELINE_BUILDER_DIR), {
      recursive: true,
    });
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true });
  });

  test("writes the config into the clone and returns its relative path", async () => {
    const relativePath = await writeManagedRuntimeConfig({
      workspacePath,
      id: "bun1",
    });

    expect(relativePath).toBe(
      ".boboddy/managed-devcontainers/bun1/devcontainer.json",
    );
    const written = JSON.parse(
      await readFile(path.join(workspacePath, relativePath), "utf8"),
    ) as { image: string; remoteUser: string };
    expect(written).toMatchObject({
      image: "oven/bun:1.4.0-debian",
      remoteUser: "bun",
    });
  });

  test("chooses the install from the lockfile the clone carries", async () => {
    await writeFile(
      path.join(workspacePath, PIPELINE_BUILDER_DIR, "pnpm-lock.yaml"),
      "lockfileVersion: 9\n",
    );

    const relativePath = await writeManagedRuntimeConfig({
      workspacePath,
      id: "node24",
    });

    const written = JSON.parse(
      await readFile(path.join(workspacePath, relativePath), "utf8"),
    ) as { onCreateCommand: string };
    expect(written.onCreateCommand).toBe(
      "cd .boboddy/pipeline-builder && corepack pnpm install --prod",
    );
  });

  test("a clone with no lockfile gets a plain install", async () => {
    const relativePath = await writeManagedRuntimeConfig({
      workspacePath,
      id: "bun1",
    });

    const written = JSON.parse(
      await readFile(path.join(workspacePath, relativePath), "utf8"),
    ) as { onCreateCommand: string };
    expect(written.onCreateCommand).toBe(
      "cd .boboddy/pipeline-builder && bun install --production && rm -f bun.lock",
    );
  });

  test("a clone with no pipeline-builder directory still gets a config", async () => {
    await rm(path.join(workspacePath, PIPELINE_BUILDER_DIR), {
      recursive: true,
    });

    const relativePath = await writeManagedRuntimeConfig({
      workspacePath,
      id: "node24",
    });

    expect(relativePath).toBe(
      ".boboddy/managed-devcontainers/node24/devcontainer.json",
    );
  });

  test("the devcontainer env patcher can read and extend the written config", async () => {
    const relativePath = await writeManagedRuntimeConfig({
      workspacePath,
      id: "bun1",
    });

    await patchDevcontainerEnv(workspacePath, relativePath, { API_KEY: "k" });

    const patched = JSON.parse(
      await readFile(path.join(workspacePath, relativePath), "utf8"),
    ) as { containerEnv: Record<string, string>; image: string };
    expect(patched.containerEnv).toEqual({ API_KEY: "k" });
    expect(patched.image).toBe("oven/bun:1.4.0-debian");
  });
});
