import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  patchDevcontainerAppPort,
  patchDevcontainerMounts,
  patchDevcontainerRunArgs,
  renderBindMountString,
} from "../../../../src/runtime/runtime-service/infra/devcontainer-mount-injection";

describe("devcontainer mount injection", () => {
  let workspacePath: string;
  const configRel = ".devcontainer/devcontainer.json";

  beforeEach(async () => {
    workspacePath = await mkdtemp(path.join(os.tmpdir(), "mount-inject-"));
    await mkdir(path.join(workspacePath, ".devcontainer"), { recursive: true });
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true });
  });

  async function writeConfig(content: string): Promise<void> {
    await writeFile(path.join(workspacePath, configRel), content, "utf8");
  }

  async function readConfig(): Promise<Record<string, unknown>> {
    const raw = await readFile(path.join(workspacePath, configRel), "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  }

  async function expectRejects(
    action: () => Promise<unknown>,
    pattern: RegExp,
  ): Promise<void> {
    let caught: unknown;
    try {
      await action();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(pattern);
  }

  test("renders a read-only long-form bind mount", () => {
    expect(
      renderBindMountString({
        source: "/host/payload",
        target: "/opt/boboddy/x",
        readOnly: true,
      }),
    ).toBe("type=bind,source=/host/payload,target=/opt/boboddy/x,readonly");
  });

  test("injects mounts into an image-based devcontainer (with comments)", async () => {
    await writeConfig(
      `{\n  // a comment\n  "image": "node:20"\n}\n`,
    );
    await patchDevcontainerMounts(workspacePath, configRel, [
      { source: "/host/a", target: "/opt/a", readOnly: true },
      { source: "/host/b", target: "/opt/b" },
    ]);
    const config = await readConfig();
    expect(config["mounts"]).toEqual([
      "type=bind,source=/host/a,target=/opt/a,readonly",
      "type=bind,source=/host/b,target=/opt/b",
    ]);
  });

  test("merges with existing user mounts", async () => {
    await writeConfig(
      `{"image":"node:20","mounts":["type=bind,source=/u,target=/user"]}`,
    );
    await patchDevcontainerMounts(workspacePath, configRel, [
      { source: "/host/a", target: "/opt/a" },
    ]);
    const config = await readConfig();
    expect(config["mounts"]).toEqual([
      "type=bind,source=/u,target=/user",
      "type=bind,source=/host/a,target=/opt/a",
    ]);
  });

  test("throws on a conflicting user mount target (string form)", async () => {
    await writeConfig(
      `{"image":"node:20","mounts":["type=bind,source=/u,target=/opt/a"]}`,
    );
    await expectRejects(
      () =>
        patchDevcontainerMounts(workspacePath, configRel, [
          { source: "/host/a", target: "/opt/a" },
        ]),
      /already defines a mount at '\/opt\/a'/u,
    );
  });

  test("throws on a conflicting user mount target (object form)", async () => {
    await writeConfig(
      `{"image":"node:20","mounts":[{"type":"bind","source":"/u","target":"/opt/a"}]}`,
    );
    await expectRejects(
      () =>
        patchDevcontainerMounts(workspacePath, configRel, [
          { source: "/host/a", target: "/opt/a" },
        ]),
      /conflicts with a Boboddy-managed runtime mount/u,
    );
  });

  test("throws for docker-compose based devcontainers", async () => {
    await writeConfig(
      `{"dockerComposeFile":"docker-compose.yml","service":"app"}`,
    );
    await expectRejects(
      () =>
        patchDevcontainerMounts(workspacePath, configRel, [
          { source: "/host/a", target: "/opt/a" },
        ]),
      /docker-compose-based devcontainer/u,
    );
  });

  test("no-op when no mounts are given", async () => {
    await writeConfig(`{"image":"node:20"}`);
    await patchDevcontainerMounts(workspacePath, configRel, []);
    const config = await readConfig();
    expect(config["mounts"]).toBeUndefined();
  });

  test("injects appPort and merges with existing", async () => {
    await writeConfig(`{"image":"node:20","appPort":"3000"}`);
    await patchDevcontainerAppPort(workspacePath, configRel, {
      hostPort: 49152,
      containerPort: 4096,
    });
    const config = await readConfig();
    expect(config["appPort"]).toEqual(["3000", "127.0.0.1:49152:4096"]);
  });

  test("injects appPort when none present", async () => {
    await writeConfig(`{"build":{"dockerfile":"Dockerfile"}}`);
    await patchDevcontainerAppPort(workspacePath, configRel, {
      hostPort: 50000,
      containerPort: 4096,
    });
    const config = await readConfig();
    expect(config["appPort"]).toEqual(["127.0.0.1:50000:4096"]);
  });

  test("appPort throws for compose configs", async () => {
    await writeConfig(`{"dockerComposeFile":"docker-compose.yml"}`);
    await expectRejects(
      () =>
        patchDevcontainerAppPort(workspacePath, configRel, {
          hostPort: 50000,
          containerPort: 4096,
        }),
      /docker-compose-based devcontainer/u,
    );
  });

  test("injects runArgs when none present (host-gateway alias)", async () => {
    await writeConfig(`{"image":"node:20"}`);
    await patchDevcontainerRunArgs(workspacePath, configRel, [
      "--add-host",
      "host.docker.internal:host-gateway",
    ]);
    const config = await readConfig();
    expect(config["runArgs"]).toEqual([
      "--add-host",
      "host.docker.internal:host-gateway",
    ]);
  });

  test("merges runArgs with existing without duplicating", async () => {
    await writeConfig(
      `{"image":"node:20","runArgs":["--cap-add","SYS_PTRACE","--add-host"]}`,
    );
    await patchDevcontainerRunArgs(workspacePath, configRel, [
      "--add-host",
      "host.docker.internal:host-gateway",
    ]);
    const config = await readConfig();
    // "--add-host" already present is not duplicated; the new value is appended.
    expect(config["runArgs"]).toEqual([
      "--cap-add",
      "SYS_PTRACE",
      "--add-host",
      "host.docker.internal:host-gateway",
    ]);
  });

  test("no-op when no runArgs are given", async () => {
    await writeConfig(`{"image":"node:20"}`);
    await patchDevcontainerRunArgs(workspacePath, configRel, []);
    const config = await readConfig();
    expect(config["runArgs"]).toBeUndefined();
  });

  test("runArgs throws for compose configs", async () => {
    await writeConfig(`{"dockerComposeFile":"docker-compose.yml"}`);
    await expectRejects(
      () =>
        patchDevcontainerRunArgs(workspacePath, configRel, [
          "--add-host",
          "host.docker.internal:host-gateway",
        ]),
      /docker-compose-based devcontainer/u,
    );
  });
});
