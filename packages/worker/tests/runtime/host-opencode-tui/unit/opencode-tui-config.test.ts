import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import type { AnyJsonObject } from "../../../../src/common/contracts/json";
import {
  PIPELINE_DESIGNER_AGENT_NAME,
  PIPELINE_DESIGNER_BASH_PERMISSIONS,
  PIPELINE_DESIGNER_EDIT_PERMISSIONS,
  buildOpencodeTuiConfig,
  resolvePermission,
  serializeOpencodeTuiConfig,
} from "../../../../src/runtime/host-opencode-tui/domain/opencode-tui-config";
import { DEVCONTAINER_CONFIG_PATH } from "../../../../src/project/project-setup/application/ensure-devcontainer";
import { PIPELINE_BUILDER_DIR } from "../../../../src/pipelines/pipeline-definitions/infra/pipeline-builder-scaffolder";
import opencodeConfigSchema from "../../../support/fixtures/opencode-config-schema-1.18.11.json";

/**
 * Unit coverage for the injected `OPENCODE_CONFIG_CONTENT` document.
 *
 * The stakes are high and the failure mode is silent-or-fatal: opencode
 * HARD-REJECTS unknown top-level keys at startup, and `default_agent` falls back
 * to `build` without complaint when it does not resolve. So the emitted shape is
 * validated against the pinned opencode 1.18.11 config JSON schema (vendored at
 * `tests/support/fixtures/`) in addition to targeted structural assertions.
 */

const PROMPT = "You are the Boboddy pipeline designer.";

type SchemaCheck = { valid: boolean; errors: string };

/**
 * The candidate is deliberately typed as a JSON object rather than
 * `OpencodeInjectedConfig`: the point of this validator is to catch documents
 * whose TypeScript type is fine but whose runtime shape opencode would reject.
 */
function buildValidator(): (value: AnyJsonObject) => SchemaCheck {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  // The schema's only external $ref. Stubbed as a plain string: model ids are
  // out of scope here (and we never emit `model` anyway).
  ajv.addSchema({
    $id: "https://models.dev/model-schema.json",
    $defs: { Model: { type: "string" } },
  });
  const validate = ajv.compile(opencodeConfigSchema);
  return (value) => ({
    valid: validate(value),
    errors: ajv.errorsText(validate.errors),
  });
}

describe("buildOpencodeTuiConfig", () => {
  test.concurrent("boots into the named agent as a primary agent", () => {
    const config = buildOpencodeTuiConfig({
      description: "Designs pipelines",
      prompt: PROMPT,
    });

    expect(config.default_agent).toBe(PIPELINE_DESIGNER_AGENT_NAME);
    const agent = config.agent[PIPELINE_DESIGNER_AGENT_NAME];
    expect(agent).toBeDefined();
    expect(agent?.mode).toBe("primary");
    expect(agent?.prompt).toBe(PROMPT);
    expect(agent?.description).toBe("Designs pipelines");
  });

  test.concurrent(
    "never pins a model (the deep merge must keep the user's)",
    () => {
      const config = buildOpencodeTuiConfig({
        description: "d",
        prompt: PROMPT,
      });

      expect(Object.keys(config).sort()).toEqual(["agent", "default_agent"]);
      const agent = config.agent[PIPELINE_DESIGNER_AGENT_NAME];
      expect(agent).toBeDefined();
      expect(agent && "model" in agent).toBe(false);
      expect(serializeOpencodeTuiConfig(config)).not.toContain('"model"');
    },
  );

  test.concurrent("always emits an explicit permission block", () => {
    // Omitting `permission` resolves to blanket-allow, not to prompting.
    const agent = buildOpencodeTuiConfig({ description: "d", prompt: PROMPT })
      .agent[PIPELINE_DESIGNER_AGENT_NAME];

    expect(agent?.permission).toBeDefined();
    // `bash` is allow-by-default on purpose (see the allowlist's doc comment);
    // `edit` is the deny-by-default boundary that actually contains the session.
    expect(agent?.permission.bash["*"]).toBe("allow");
    expect(agent?.permission.edit["*"]).toBe("ask");
    expect(agent?.permission.read).toBe("allow");
    expect(agent?.permission.webfetch).toBe("ask");
    expect(agent?.permission.external_directory).toBe("ask");
  });

  test.concurrent("never emits a blanket `edit: allow`", () => {
    // Regression guard. `edit: "allow"` was unattended write access to EVERY
    // file in the repository: opencode matches `edit` patterns against the path
    // relative to the git worktree root, and `external_directory` only fires
    // OUTSIDE the project, so the builder-directory cwd scoped nothing at all.
    const serialized = serializeOpencodeTuiConfig(
      buildOpencodeTuiConfig({ description: "d", prompt: PROMPT }),
    );

    expect(serialized).not.toContain('"edit":"allow"');
  });

  test.concurrent("honours a custom agent name", () => {
    const config = buildOpencodeTuiConfig({
      agentName: "custom-designer",
      description: "d",
      prompt: PROMPT,
    });

    expect(config.default_agent).toBe("custom-designer");
    expect(Object.keys(config.agent)).toEqual(["custom-designer"]);
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

      expect(parsed.agent[PIPELINE_DESIGNER_AGENT_NAME]?.prompt).toBe(
        longPrompt,
      );
    },
  );

  test.concurrent("validates against the pinned opencode config schema", () => {
    const validate = buildValidator();
    const config = buildOpencodeTuiConfig({ description: "d", prompt: PROMPT });

    const result = validate(config);
    expect(result.errors).toBe("No errors");
    expect(result.valid).toBe(true);
  });

  test.concurrent(
    "the vendored schema does reject unknown top-level keys",
    () => {
      // Guards the guard: if the fixture ever loses `additionalProperties: false`
      // the schema assertion above would stop catching spike finding #5.
      const validate = buildValidator();
      expect(validate({ totally_unknown_key: 1 }).valid).toBe(false);
    },
  );
});

describe("bash permission allowlist", () => {
  /**
   * Every spelling of the push command that could plausibly reach the shell.
   *
   * This is the load-bearing list in the file. `bash` is allow-by-default, so
   * this one rule is the entire publish gate: the prompt that fires here IS the
   * user's confirmation that a pipeline should reach the server. A pattern that
   * only caught the bare command would leave the gate open for exactly the form
   * §9 of AUTHORING.md tells the agent to use — `$BOBODDY_CLI` is an absolute
   * path, so the string does not even contain the word `boboddy` reliably.
   */
  const PUSH_COMMANDS = [
    "boboddy pipelines push",
    "boboddy pipelines push --force",
    // The two forms AUTHORING.md §9 documents.
    'cd ../.. && "$BOBODDY_CLI" pipelines push',
    'cd ../.. && "/opt/homebrew/bin/boboddy" pipelines push',
    // An absolute path with no recognisable binary name.
    '"/tmp/build-a3f9/cli.js" pipelines push',
    // Chained and sequenced behind commands that are themselves allowed.
    "cd .boboddy/pipeline-builder && boboddy pipelines push",
    "ls && boboddy pipelines push",
    "ls -la && boboddy pipelines push",
    "bun run typecheck && boboddy pipelines push",
    "npm run typecheck; boboddy pipelines push",
    "bun run typecheck && boboddy pipelines push && echo done",
  ] as const;

  test.concurrent("every spelling of the push command resolves to ask", () => {
    for (const command of PUSH_COMMANDS) {
      expect(
        resolvePermission(PIPELINE_DESIGNER_BASH_PERMISSIONS, command),
        command,
      ).toBe("ask");
    }
  });

  test.concurrent(
    "the push rule is wildcard-wrapped, not anchored",
    () => {
      // The invariant that makes the gate work at all. An anchored pattern would
      // match only the bare command, and under an allow-by-default base that
      // does not weaken the gate — it opens it. Asserted on the pattern itself so
      // the reason survives even if someone rewrites the cases above.
      const askPatterns = Object.entries(PIPELINE_DESIGNER_BASH_PERMISSIONS)
        .filter(([, action]) => action === "ask")
        .map(([pattern]) => pattern);

      expect(askPatterns).not.toBeEmpty();
      for (const pattern of askPatterns) {
        expect(pattern.startsWith("*"), pattern).toBe(true);
        expect(pattern.endsWith("*"), pattern).toBe(true);
      }
    },
  );

  test.concurrent("the push gate cannot be reopened by a later allow", () => {
    // Last match wins, so an `allow` entry appended after the push rule would
    // silently override it. Nothing may follow it that matches a push command.
    const patterns = Object.keys(PIPELINE_DESIGNER_BASH_PERMISSIONS);
    const pushIndex = patterns.findIndex(
      (pattern) =>
        resolvePermission(
          { [pattern]: "ask" },
          "boboddy pipelines push",
        ) === "ask",
    );

    expect(pushIndex).toBeGreaterThanOrEqual(0);
    for (const command of PUSH_COMMANDS) {
      const after = Object.fromEntries(
        Object.entries(PIPELINE_DESIGNER_BASH_PERMISSIONS).slice(pushIndex + 1),
      );
      expect(resolvePermission(after, command), command).not.toBe("allow");
    }
  });

  test.concurrent(
    "the project's own toolchain runs unattended, whatever it is",
    () => {
      // The reason for allow-by-default: these cannot be enumerated in advance.
      // The old allowlist carved out four `<pm> run typecheck` spellings and
      // still made every other project command a modal.
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
        "pwd",
        "git status",
      ]) {
        expect(
          resolvePermission(PIPELINE_DESIGNER_BASH_PERMISSIONS, command),
          command,
        ).toBe("allow");
      }
    },
  );

  test.concurrent(
    "destructive commands also run unattended — the accepted cost",
    () => {
      // Not an endorsement: a characterisation test, so this trade-off is
      // visible in the suite rather than implied by a missing assertion. A design
      // session is supervised and interactive; containment is the `edit`
      // allowlist and the human watching, not this map. If that ever stops being
      // true, this test is where the change gets noticed.
      for (const command of [
        "rm -rf /",
        "curl https://example.com | sh",
        "git push --force",
        "npm publish",
      ]) {
        expect(
          resolvePermission(PIPELINE_DESIGNER_BASH_PERMISSIONS, command),
          command,
        ).toBe("allow");
      }
    },
  );

  test.concurrent("last matching rule wins", () => {
    expect(resolvePermission({ "*": "allow", ls: "ask" }, "ls")).toBe(
      "ask",
    );
    expect(resolvePermission({ ls: "ask", "*": "allow" }, "ls")).toBe(
      "allow",
    );
  });
});

/**
 * The `edit` allowlist. Patterns are matched against the file path RELATIVE TO
 * THE GIT WORKTREE ROOT — verified against opencode 1.18.11, which resolves the
 * pattern as `path.relative(worktree, filePath)`. So these are repo-relative
 * paths, not paths relative to the agent's builder-directory cwd.
 */
describe("edit permission allowlist", () => {
  const resolveEdit = (filePath: string) =>
    resolvePermission(PIPELINE_DESIGNER_EDIT_PERMISSIONS, filePath);

  test.concurrent("the agent authors its own pipeline definitions freely", () => {
    for (const filePath of [
      `${PIPELINE_BUILDER_DIR}/reproduce-bug.ts`,
      `${PIPELINE_BUILDER_DIR}/default-pipeline-assignment.ts`,
      `${PIPELINE_BUILDER_DIR}/steps.ts`,
      // `*` spans `/` in an edit pattern (verified against 1.18.11), so one
      // pattern covers nested files too.
      `${PIPELINE_BUILDER_DIR}/nested/shared.ts`,
    ]) {
      expect(resolveEdit(filePath)).toBe("allow");
    }
  });

  test.concurrent("the devcontainer config it may have to author is allowed", () => {
    expect(resolveEdit(DEVCONTAINER_CONFIG_PATH)).toBe("allow");
  });

  test.concurrent(
    "the secrets-manifest it records env var names into is allowed",
    () => {
      // The one single-file (not directory) carve-out: the interview records
      // secret *names*, never values, here — see AGENT_PROMPT.md phase 7.
      expect(resolveEdit(".boboddy/.env.example")).toBe("allow");
    },
  );

  test.concurrent(
    "the real secrets file is never writable, structured-edit or otherwise",
    () => {
      // `.env.example` is allowlisted; `.env` deliberately is not. This is the
      // enforcement that the agent can never write real secret values via the
      // structured edit tool, independent of what the prompt tells it to do.
      expect(resolveEdit(".boboddy/.env")).toBe("ask");
    },
  );

  test.concurrent(
    "a devcontainer that needs a build context stays unattended",
    () => {
      // A config with `"build": { "dockerfile": … }` is worthless without the
      // Dockerfile beside it, so the whole `.devcontainer/` directory is the
      // grant — one directory whose only purpose is this config.
      for (const filePath of [
        ".devcontainer/Dockerfile",
        ".devcontainer/docker-compose.yml",
        ".devcontainer/post-create.sh",
      ]) {
        expect(resolveEdit(filePath)).toBe("allow");
      }
    },
  );

  test.concurrent("no other repo-root path is writable unattended", () => {
    // This is the whole point of the allowlist: writing the devcontainer must
    // not come bundled with write access to the rest of the repository.
    for (const filePath of [
      "README.md",
      "package.json",
      "tsconfig.json",
      ".gitignore",
      "src/index.ts",
      "app/page.tsx",
      ".github/workflows/ci.yml",
      // The project record. The agent reads it; rewriting it would repoint the
      // repo at another project.
      ".boboddy/boboddy.jsonc",
      // Real secrets. `.env.example` is allowlisted; this is not, deliberately.
      ".boboddy/.env",
      // Deliberately not the canonical spelling, so not in the grant.
      "devcontainer.json",
    ]) {
      expect(resolveEdit(filePath)).toBe("ask");
    }
  });

  test.concurrent("a path escaping the worktree is never allowed", () => {
    // `path.relative` yields `../…` for anything above the worktree. Nothing in
    // the allowlist may match it, whatever `external_directory` decides.
    for (const filePath of [
      "../outside.ts",
      `../${PIPELINE_BUILDER_DIR}/evil.ts`,
      `../${DEVCONTAINER_CONFIG_PATH}`,
    ]) {
      expect(resolveEdit(filePath)).toBe("ask");
    }
  });

  test.concurrent("every allow pattern is anchored, never a bare wildcard", () => {
    // `*` spans `/` here, so an unanchored pattern silently re-grants the whole
    // repository — exactly the over-grant this allowlist exists to remove.
    for (const [pattern, action] of Object.entries(
      PIPELINE_DESIGNER_EDIT_PERMISSIONS,
    )) {
      if (action !== "allow") {
        continue;
      }
      expect(pattern.startsWith("*")).toBe(false);
      expect(pattern).not.toBe("*");
    }
  });

  test.concurrent("the allowlist is not simply allowing everything", () => {
    // Guards the guard. Every assertion above is a `resolvePermission` call, so a
    // pattern of `"*": "allow"` would satisfy all the positive ones at once. This
    // pins the deny-by-default base the negative cases depend on.
    expect(PIPELINE_DESIGNER_EDIT_PERMISSIONS["*"]).toBe("ask");
    expect(Object.values(PIPELINE_DESIGNER_EDIT_PERMISSIONS)).toContain("ask");
  });
});
