import { describe, expect, test } from "bun:test";
import {
  buildAiContainerBaseArgs,
  resolveWorkspaceOwnership,
} from "../../../../src/runtime/runtime-service/infra/docker-ai-container-launcher";

describe("DockerAiContainerLauncher helpers", () => {
  test.concurrent("builds docker args with workspace owner as container user", () => {
    expect(
      buildAiContainerBaseArgs({
        workspacePath: "/tmp/workspace",
        sessionHomePath: "/tmp/workspace/.boboddy/ai-home",
        workspaceOwnership: { uid: 501, gid: 20 },
        projectId: "project-1",
        sessionId: "session-1",
        requestedByUserId: "user-1",
        extraEnv: { FOO: "bar" },
        hasHostOpencodeConfig: true,
        hostOpencodeConfigPath: "/tmp/opencode-config",
        hasHostOpencodeData: true,
        hostOpencodeDataPath: "/tmp/opencode-data",
        image: "boboddy/ai-worker:test",
      }),
    ).toEqual([
      "--user",
      "501:20",
      "-v",
      "/tmp/workspace:/workspace",
      "-v",
      "/tmp/workspace/.boboddy/ai-home:/home/node",
      "-w",
      "/workspace",
      "-e",
      "HOME=/home/node",
      "--label",
      "boboddy.ai-project-id=project-1",
      "--label",
      "boboddy.ai-project-runtime-session-id=session-1",
      "--label",
      "boboddy.ai-requested-by-user-id=user-1",
      "--label",
      "boboddy.runtime-role=ai",
      "-e",
      "FOO=bar",
      "-v",
      "/tmp/opencode-config:/home/node/.config/opencode",
      "-v",
      "/tmp/opencode-data:/opencode-host-share:ro",
      "boboddy/ai-worker:test",
    ]);
  });

  test.concurrent("resolves numeric uid and gid from workspace path", async () => {
    const ownership = await resolveWorkspaceOwnership(process.cwd());

    expect(ownership.uid).toBeNumber();
    expect(ownership.gid).toBeNumber();
    expect(ownership.uid).toBeGreaterThanOrEqual(0);
    expect(ownership.gid).toBeGreaterThanOrEqual(0);
  });
});
