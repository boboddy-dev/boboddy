import { describe, expect, test } from "bun:test";
import {
  buildDevcontainerCliCommand,
  resolveDevcontainerCliScriptPath,
} from "../../../../src/runtime/runtime-service/infra/devcontainer-cli-launcher";

describe("devcontainer CLI launcher", () => {
  test.concurrent("invokes the devcontainer bundle using the current executable", () => {
    expect(
      buildDevcontainerCliCommand("/tmp/devcontainer.js", ["up", "--help"]),
    ).toEqual([process.execPath, "/tmp/devcontainer.js", "up", "--help"]);
  });

  test.concurrent("resolves script path from BOBODDY_DEVCONTAINER_SCRIPT env var when set", () => {
    const original = process.env["BOBODDY_DEVCONTAINER_SCRIPT"];
    process.env["BOBODDY_DEVCONTAINER_SCRIPT"] = "/custom/path/devcontainer.js";
    try {
      expect(resolveDevcontainerCliScriptPath()).toBe("/custom/path/devcontainer.js");
    } finally {
      if (original === undefined) {
        delete process.env["BOBODDY_DEVCONTAINER_SCRIPT"];
      } else {
        process.env["BOBODDY_DEVCONTAINER_SCRIPT"] = original;
      }
    }
  });
});
