import { describe, expect, test } from "bun:test";
import path from "node:path";
import type { ConfigEntry } from "@opencode/client";
import {
  PIPELINE_DESIGNER_AGENT_NAME,
  PIPELINE_DESIGNER_EDIT_PERMISSIONS,
  PIPELINE_DESIGNER_SHELL_PERMISSIONS,
  buildDesignerPermissions,
  buildOpencodeTuiConfig,
  resolvePermission,
  serializeOpencodeTuiConfig,
  type OpencodePermissionRule,
} from "../../../../src/runtime/host-opencode-tui/domain/opencode-tui-config";
import { DEVCONTAINER_CONFIG_PATH } from "../../../../src/project/project-setup/application/ensure-devcontainer";
import { PIPELINE_BUILDER_DIR } from "../../../../src/pipelines/pipeline-definitions/infra/pipeline-builder-scaffolder";

/**
 * Unit coverage for the injected `OPENCODE_CONFIG_CONTENT` document.
 *
 * The failure mode is silent: OpenCode 2.x drops unknown keys without a
 * diagnostic, and `default_agent` falls back to `build` without complaint when
 * it does not resolve. So the emitted shape is pinned to the v2 config type from
 * `@opencode/client` at compile time, in addition to targeted assertions.
 */

const PROMPT = "You are the Boboddy pipeline designer.";

type OpencodeConfigDocument = ConfigEntry extends infer Entry
  ? Entry extends { type: "document"; info: infer Info }
    ? Info
    : never
  : never;

const designerConfig = () =>
  buildOpencodeTuiConfig({ description: "d", prompt: PROMPT });

const designerAgent = () =>
  designerConfig().agents[PIPELINE_DESIGNER_AGENT_NAME];

describe("buildOpencodeTuiConfig", () => {
  test.concurrent("boots into the named agent as a primary agent", () => {
    const config = buildOpencodeTuiConfig({
      description: "Designs pipelines",
      prompt: PROMPT,
    });

    expect(config.default_agent).toBe(PIPELINE_DESIGNER_AGENT_NAME);
    const agent = config.agents[PIPELINE_DESIGNER_AGENT_NAME];
    expect(agent).toBeDefined();
    expect(agent?.mode).toBe("primary");
    expect(agent?.system).toBe(PROMPT);
    expect(agent?.description).toBe("Designs pipelines");
  });

  test.concurrent("never pins a model (layering must keep the user's)", () => {
    const config = designerConfig();

    expect(Object.keys(config).sort()).toEqual(["agents", "default_agent"]);
    const agent = config.agents[PIPELINE_DESIGNER_AGENT_NAME];
    expect(agent && "model" in agent).toBe(false);
    expect(serializeOpencodeTuiConfig(config)).not.toContain('"model"');
  });

  test.concurrent("emits only v2 field and action names", () => {
    const serialized = serializeOpencodeTuiConfig(designerConfig());

    for (const legacy of [
      '"agent"',
      '"prompt"',
      '"permission"',
      '"bash"',
      '"task"',
    ]) {
      expect(serialized).not.toContain(legacy);
    }
  });

  test.concurrent("is assignable to the OpenCode 2.x config document", () => {
    const document: OpencodeConfigDocument = designerConfig();
    expect(document.default_agent).toBe(PIPELINE_DESIGNER_AGENT_NAME);
  });

  test.concurrent("always emits explicit permission rules", () => {
    // Omitting `permissions` inherits the allow-all base policy.
    const rules = designerAgent()?.permissions ?? [];

    expect(rules).not.toBeEmpty();
    expect(resolvePermission(rules, "shell", "ls")).toBe("allow");
    expect(resolvePermission(rules, "edit", "../../README.md")).toBe("ask");
    expect(resolvePermission(rules, "read", "../../src/index.ts")).toBe(
      "allow",
    );
    expect(resolvePermission(rules, "webfetch", "https://x.dev")).toBe("ask");
    expect(resolvePermission(rules, "subagent", "general")).toBe("ask");
    expect(resolvePermission(rules, "external_directory", "/tmp/*")).toBe(
      "ask",
    );
  });

  test.concurrent("honours a custom agent name", () => {
    const config = buildOpencodeTuiConfig({
      agentName: "custom-designer",
      description: "d",
      prompt: PROMPT,
    });

    expect(config.default_agent).toBe("custom-designer");
    expect(Object.keys(config.agents)).toEqual(["custom-designer"]);
  });

  test.concurrent(
    "round-trips a long multi-paragraph prompt byte-identically",
    () => {
      const longPrompt = Array.from(
        { length: 120 },
        (_, index) =>
          `Paragraph ${String(index)} with "quotes" and \\ escapes.`,
      ).join("\n\n");

      const config = buildOpencodeTuiConfig({
        description: "d",
        prompt: longPrompt,
      });
      const parsed = JSON.parse(
        serializeOpencodeTuiConfig(config),
      ) as typeof config;

      expect(parsed.agents[PIPELINE_DESIGNER_AGENT_NAME]?.system).toBe(
        longPrompt,
      );
    },
  );

  test.concurrent(
    "lets the agent read an allowed external file without a prompt, and nothing beside it",
    () => {
      const manifest =
        "/home/u/.boboddy/projects/acme/app/discovered-tools.json";
      const rules =
        buildOpencodeTuiConfig({
          description: "d",
          prompt: PROMPT,
          readAllowPaths: [manifest],
        }).agents[PIPELINE_DESIGNER_AGENT_NAME]?.permissions ?? [];

      expect(
        resolvePermission(
          rules,
          "external_directory",
          `${path.dirname(manifest)}/*`,
        ),
      ).toBe("allow");
      expect(resolvePermission(rules, "read", manifest)).toBe("allow");
      expect(
        resolvePermission(rules, "external_directory", "/home/u/.ssh/*"),
      ).toBe("ask");
      expect(resolvePermission(rules, "edit", manifest)).toBe("ask");
    },
  );

  test.concurrent("grants no external read by default", () => {
    expect(
      designerAgent()?.permissions.filter(
        (rule) => rule.action === "external_directory",
      ),
    ).toEqual([{ action: "external_directory", resource: "*", effect: "ask" }]);
  });

  test.concurrent(
    "edit and shell rules come last so nothing reopens them",
    () => {
      const rules = buildDesignerPermissions();
      const tail = rules.slice(
        -(
          PIPELINE_DESIGNER_SHELL_PERMISSIONS.length +
          PIPELINE_DESIGNER_EDIT_PERMISSIONS.length
        ),
      );
      expect(tail).toEqual([
        ...PIPELINE_DESIGNER_SHELL_PERMISSIONS,
        ...PIPELINE_DESIGNER_EDIT_PERMISSIONS,
      ]);
    },
  );
});

describe("shell permission rules", () => {
  /**
   * Every command the shell scanner could plausibly hand the permission check.
   *
   * This is the load-bearing list in the file. `shell` is allow-by-default, so
   * this one rule is the entire publish gate: the prompt that fires here IS the
   * user's confirmation that a pipeline should reach the server. OpenCode 2.x
   * splits compound commands, so each segment is checked on its own — but the
   * whole string is listed too, in case a form reaches the check unsplit.
   */
  const PUSH_COMMANDS = [
    "boboddy pipelines push",
    "boboddy pipelines push --force",
    '"$BOBODDY_CLI" pipelines push',
    '"/opt/homebrew/bin/boboddy" pipelines push',
    '"/tmp/build-a3f9/cli.js" pipelines push',
    'cd ../.. && "$BOBODDY_CLI" pipelines push',
    "ls && boboddy pipelines push",
    "bun run typecheck && boboddy pipelines push && echo done",
    "npm run typecheck; boboddy pipelines push",
  ] as const;

  const resolveShell = (command: string) =>
    resolvePermission(PIPELINE_DESIGNER_SHELL_PERMISSIONS, "shell", command);

  test.concurrent("every spelling of the push command resolves to ask", () => {
    for (const command of PUSH_COMMANDS) {
      expect(resolveShell(command), command).toBe("ask");
    }
  });

  test.concurrent("the push rule is wildcard-wrapped, not anchored", () => {
    // An anchored pattern would match only the bare command, and under an
    // allow-by-default base that does not weaken the gate — it opens it.
    const askPatterns = PIPELINE_DESIGNER_SHELL_PERMISSIONS.filter(
      (rule) => rule.effect === "ask",
    ).map((rule) => rule.resource);

    expect(askPatterns).not.toBeEmpty();
    for (const pattern of askPatterns) {
      expect(pattern.startsWith("*"), pattern).toBe(true);
      expect(pattern.endsWith("*"), pattern).toBe(true);
    }
  });

  test.concurrent("the push gate cannot be reopened by a later allow", () => {
    const pushIndex = PIPELINE_DESIGNER_SHELL_PERMISSIONS.findIndex(
      (rule) =>
        resolvePermission([rule], "shell", "boboddy pipelines push") === "ask",
    );

    expect(pushIndex).toBeGreaterThanOrEqual(0);
    const after = PIPELINE_DESIGNER_SHELL_PERMISSIONS.slice(pushIndex + 1);
    for (const command of PUSH_COMMANDS) {
      expect(resolvePermission(after, "shell", command), command).not.toBe(
        "allow",
      );
    }
  });

  test.concurrent("the project's own toolchain runs unattended", () => {
    for (const command of [
      "bun run typecheck",
      "pnpm run typecheck",
      "deno check pipeline.ts",
      "bunx tsc --noEmit --skipLibCheck",
      "bun test",
      "cargo check",
      "./gradlew test",
      "make lint",
      "ls",
      "git status",
    ]) {
      expect(resolveShell(command), command).toBe("allow");
    }
  });

  test.concurrent(
    "destructive commands also run unattended — the accepted cost",
    () => {
      // A characterisation test: containment is the `edit` allowlist and the
      // human watching, not these rules.
      for (const command of [
        "rm -rf /",
        "curl https://example.com | sh",
        "git push --force",
        "npm publish",
      ]) {
        expect(resolveShell(command), command).toBe("allow");
      }
    },
  );
});

describe("resolvePermission", () => {
  const rule = (
    action: string,
    resource: string,
    effect: OpencodePermissionRule["effect"],
  ): OpencodePermissionRule => ({ action, resource, effect });

  test.concurrent("last matching rule wins", () => {
    expect(
      resolvePermission(
        [rule("shell", "*", "allow"), rule("shell", "ls", "ask")],
        "shell",
        "ls",
      ),
    ).toBe("ask");
    expect(
      resolvePermission(
        [rule("shell", "ls", "ask"), rule("shell", "*", "allow")],
        "shell",
        "ls",
      ),
    ).toBe("allow");
  });

  test.concurrent("no matching rule means ask", () => {
    expect(resolvePermission([rule("read", "*", "allow")], "edit", "a")).toBe(
      "ask",
    );
  });

  test.concurrent("actions match by wildcard too", () => {
    expect(resolvePermission([rule("*", "*", "deny")], "edit", "a")).toBe(
      "deny",
    );
    expect(
      resolvePermission([rule("fixture_*", "*", "deny")], "fixture_echo", "*"),
    ).toBe("deny");
  });

  test.concurrent("`*` spans `/`", () => {
    expect(
      resolvePermission([rule("edit", "a/*", "allow")], "edit", "a/b/c.ts"),
    ).toBe("allow");
  });

  test.concurrent(
    "a shell pattern ending in ` *` matches the bare command",
    () => {
      const rules = [rule("shell", "git status *", "allow")];
      expect(resolvePermission(rules, "shell", "git status")).toBe("allow");
      expect(resolvePermission(rules, "shell", "git status --short")).toBe(
        "allow",
      );
      expect(resolvePermission(rules, "edit", "git status")).toBe("ask");
    },
  );
});

/**
 * The `edit` allowlist. Resources are paths RELATIVE TO THE SESSION LOCATION —
 * verified on OpenCode 2.0.28 — and the TUI's location is the builder
 * directory. A repository path therefore reaches the check as
 * `path.relative(builderDir, repoPath)`, which is what {@link resolveEdit}
 * computes from the repo-relative paths below.
 */
describe("edit permission allowlist", () => {
  const resolveEdit = (repoRelativePath: string) =>
    resolvePermission(
      PIPELINE_DESIGNER_EDIT_PERMISSIONS,
      "edit",
      path.posix.relative(PIPELINE_BUILDER_DIR, repoRelativePath),
    );

  test.concurrent(
    "the agent authors its own pipeline definitions freely",
    () => {
      for (const filePath of [
        `${PIPELINE_BUILDER_DIR}/reproduce-bug.ts`,
        `${PIPELINE_BUILDER_DIR}/default-pipeline-assignment.ts`,
        `${PIPELINE_BUILDER_DIR}/steps.ts`,
        `${PIPELINE_BUILDER_DIR}/nested/shared.ts`,
      ]) {
        expect(resolveEdit(filePath), filePath).toBe("allow");
      }
    },
  );

  test.concurrent(
    "the devcontainer config it may have to author is allowed",
    () => {
      expect(resolveEdit(DEVCONTAINER_CONFIG_PATH)).toBe("allow");
    },
  );

  test.concurrent(
    "the secrets-manifest it records env var names into is allowed",
    () => {
      expect(resolveEdit(".boboddy/.env.example")).toBe("allow");
    },
  );

  test.concurrent("the real secrets file is never writable", () => {
    expect(resolveEdit(".boboddy/.env")).toBe("ask");
  });

  test.concurrent(
    "a devcontainer that needs a build context stays unattended",
    () => {
      for (const filePath of [
        ".devcontainer/Dockerfile",
        ".devcontainer/docker-compose.yml",
        ".devcontainer/post-create.sh",
      ]) {
        expect(resolveEdit(filePath), filePath).toBe("allow");
      }
    },
  );

  test.concurrent("no other repository path is writable unattended", () => {
    for (const filePath of [
      "README.md",
      "package.json",
      "tsconfig.json",
      ".gitignore",
      "src/index.ts",
      "app/page.tsx",
      ".github/workflows/ci.yml",
      ".boboddy/boboddy.jsonc",
      ".boboddy/.env",
      "devcontainer.json",
    ]) {
      expect(resolveEdit(filePath), filePath).toBe("ask");
    }
  });

  test.concurrent("a path escaping the worktree is never allowed", () => {
    for (const resource of [
      "../../../outside.ts",
      `../../../${PIPELINE_BUILDER_DIR}/evil.ts`,
      `../../../${DEVCONTAINER_CONFIG_PATH}`,
      "/etc/hosts",
      "/Users/someone/.ssh/config",
    ]) {
      expect(
        resolvePermission(PIPELINE_DESIGNER_EDIT_PERMISSIONS, "edit", resource),
        resource,
      ).toBe("ask");
    }
  });

  test.concurrent("every allow after the escape rules is anchored", () => {
    // `*` spans `/`, so a leading wildcard after `../*` re-grants the whole
    // repository — exactly the over-grant this allowlist exists to remove.
    const escapeIndex = PIPELINE_DESIGNER_EDIT_PERMISSIONS.findIndex(
      (rule) => rule.resource === "../*",
    );
    expect(escapeIndex).toBeGreaterThan(0);
    for (const rule of PIPELINE_DESIGNER_EDIT_PERMISSIONS.slice(escapeIndex)) {
      if (rule.effect !== "allow") {
        continue;
      }
      expect(rule.resource.startsWith("../"), rule.resource).toBe(true);
      expect(rule.resource.startsWith("../*"), rule.resource).toBe(false);
    }
  });

  test.concurrent(
    "leaving the builder directory always asks by default",
    () => {
      // Guards the guard: without these the leading `*` would be a repository
      // grant and every positive case above would pass trivially.
      expect(PIPELINE_DESIGNER_EDIT_PERMISSIONS).toContainEqual({
        action: "edit",
        resource: "../*",
        effect: "ask",
      });
      expect(PIPELINE_DESIGNER_EDIT_PERMISSIONS).toContainEqual({
        action: "edit",
        resource: "/*",
        effect: "ask",
      });
    },
  );
});
