/**
 * `DevcontainerCliLauncher.resolveConfigPath`: an explicitly requested config is
 * validated, contained in the workspace by `realpath`, and never falls back to
 * the canonical search; with no request, the candidate search is unchanged.
 */
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DevcontainerCliLauncher } from "../../../../src/runtime/runtime-service/infra/devcontainer-cli-launcher";

describe("DevcontainerCliLauncher.resolveConfigPath", () => {
  let root: string;
  let workspacePath: string;
  const launcher = new DevcontainerCliLauncher();

  async function writeConfig(relativePath: string, base = workspacePath) {
    const absolute = path.join(base, relativePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, "{}", "utf8");
  }

  async function failureOf(promise: Promise<unknown>): Promise<Error> {
    try {
      await promise;
    } catch (error) {
      return error as Error;
    }
    throw new Error("expected resolveConfigPath to reject");
  }

  beforeEach(async () => {
    root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "devcontainer-resolve-")),
    );
    workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("with a requested config", () => {
    test("returns the requested path when it exists", async () => {
      await writeConfig(".devcontainer/alt/devcontainer.json");

      expect(
        await launcher.resolveConfigPath({
          workspacePath,
          configPath: ".devcontainer/alt/devcontainer.json",
        }),
      ).toBe(".devcontainer/alt/devcontainer.json");
    });

    test("normalizes a leading ./", async () => {
      await writeConfig(".devcontainer/alt/devcontainer.json");

      expect(
        await launcher.resolveConfigPath({
          workspacePath,
          configPath: "./.devcontainer/alt/devcontainer.json",
        }),
      ).toBe(".devcontainer/alt/devcontainer.json");
    });

    test("accepts a .devcontainer.json basename", async () => {
      await writeConfig("tools/.devcontainer.json");

      expect(
        await launcher.resolveConfigPath({
          workspacePath,
          configPath: "tools/.devcontainer.json",
        }),
      ).toBe("tools/.devcontainer.json");
    });

    test("fails naming the path when it is missing, without falling back to the canonical config", async () => {
      await writeConfig(".devcontainer/devcontainer.json");

      const error = await failureOf(
        launcher.resolveConfigPath({
          workspacePath,
          configPath: ".devcontainer/alt/devcontainer.json",
        }),
      );

      expect(error.message).toBe(
        'Devcontainer config ".devcontainer/alt/devcontainer.json" not found in the cloned repository',
      );
    });

    test("rejects a path with a .. segment even when the file exists outside the workspace", async () => {
      await writeConfig("outside/devcontainer.json", root);

      const error = await failureOf(
        launcher.resolveConfigPath({
          workspacePath,
          configPath: "../outside/devcontainer.json",
        }),
      );

      expect(error.message).toContain("../outside/devcontainer.json");
      expect(error.message).toContain('must not contain a ".." segment');
    });

    test("rejects an absolute path and a wrong basename", async () => {
      await writeConfig(".devcontainer/other.json");

      const absolute = await failureOf(
        launcher.resolveConfigPath({
          workspacePath,
          configPath: path.join(workspacePath, "devcontainer.json"),
        }),
      );
      const wrongBasename = await failureOf(
        launcher.resolveConfigPath({
          workspacePath,
          configPath: ".devcontainer/other.json",
        }),
      );

      expect(absolute.message).toContain("relative");
      expect(wrongBasename.message).toContain("devcontainer.json");
    });

    test("rejects a symlinked config that points outside the workspace", async () => {
      await writeConfig("outside/devcontainer.json", root);
      await mkdir(path.join(workspacePath, ".devcontainer", "linked"), {
        recursive: true,
      });
      await symlink(
        path.join(root, "outside", "devcontainer.json"),
        path.join(
          workspacePath,
          ".devcontainer",
          "linked",
          "devcontainer.json",
        ),
      );

      const error = await failureOf(
        launcher.resolveConfigPath({
          workspacePath,
          configPath: ".devcontainer/linked/devcontainer.json",
        }),
      );

      expect(error.message).toBe(
        'Devcontainer config ".devcontainer/linked/devcontainer.json" resolves outside the cloned repository',
      );
    });

    test("rejects a config reached through a symlinked directory that escapes the workspace", async () => {
      await writeConfig("outside/devcontainer.json", root);
      await mkdir(path.join(workspacePath, ".devcontainer"), {
        recursive: true,
      });
      await symlink(
        path.join(root, "outside"),
        path.join(workspacePath, ".devcontainer", "escape"),
      );

      const error = await failureOf(
        launcher.resolveConfigPath({
          workspacePath,
          configPath: ".devcontainer/escape/devcontainer.json",
        }),
      );

      expect(error.message).toContain("resolves outside the cloned repository");
    });

    test("accepts a symlink that stays inside the workspace", async () => {
      await writeConfig(".devcontainer/devcontainer.json");
      await mkdir(path.join(workspacePath, ".devcontainer", "alias"), {
        recursive: true,
      });
      await symlink(
        path.join(workspacePath, ".devcontainer", "devcontainer.json"),
        path.join(workspacePath, ".devcontainer", "alias", "devcontainer.json"),
      );

      expect(
        await launcher.resolveConfigPath({
          workspacePath,
          configPath: ".devcontainer/alias/devcontainer.json",
        }),
      ).toBe(".devcontainer/alias/devcontainer.json");
    });
  });

  describe("without a requested config", () => {
    test.each([undefined, null])(
      "prefers .devcontainer/devcontainer.json (configPath %p)",
      async (configPath) => {
        await writeConfig(".devcontainer/devcontainer.json");
        await writeConfig("devcontainer.json");

        expect(
          await launcher.resolveConfigPath({ workspacePath, configPath }),
        ).toBe(".devcontainer/devcontainer.json");
      },
    );

    test("falls back to a root-level devcontainer.json", async () => {
      await writeConfig("devcontainer.json");

      expect(await launcher.resolveConfigPath({ workspacePath })).toBe(
        "devcontainer.json",
      );
    });

    test("ignores configs in other directories and fails when no canonical config exists", async () => {
      await writeConfig(".devcontainer/alt/devcontainer.json");

      const error = await failureOf(
        launcher.resolveConfigPath({ workspacePath }),
      );

      expect(error.message).toContain("No devcontainer spec found");
    });
  });
});
