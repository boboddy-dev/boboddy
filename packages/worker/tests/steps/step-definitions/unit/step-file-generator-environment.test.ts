import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  resolveRepoConfig,
  type RepoConfig,
  type RepoConfigInput,
} from "@boboddy/sdk/repo-config";
import {
  generateStepsFileContent,
  type StepDefContract,
} from "../../../../src/steps/step-definitions/infra/step-file-generator";

function makeStep(overrides: Partial<StepDefContract> = {}): StepDefContract {
  return {
    key: "browser-repro",
    name: "Browser Repro",
    description: null,
    prompt: "Open the app.",
    version: 1,
    status: "active",
    executionMode: "workspace",
    devcontainerConfigPath: null,
    repo: resolveRepoConfig(overrides.executionMode ?? "workspace"),
    inputSchemaJson: null,
    resultSchemaJson: null,
    opencodeMcpJson: null,
    opencodePluginJson: null,
    healthChecksJson: null,
    envJson: null,
    signalExtractorDefinitions: [],
    ...overrides,
  };
}

describe("generateStepsFileContent environment", () => {
  test("emits Runtime.host() and imports Runtime for a no_workspace step", () => {
    const content = generateStepsFileContent([
      makeStep({ executionMode: "no_workspace" }),
    ]);

    expect(content).toContain(
      "environment: {\n    runtime: Runtime.host(),\n  }",
    );
    expect(content).toContain(
      'import { defineStep, Runtime } from "@boboddy/sdk/definitions/steps";',
    );
    expect(content).not.toContain("executionMode");
  });

  test("emits Runtime.devcontainer with the config for a workspace step with a config path", () => {
    const content = generateStepsFileContent([
      makeStep({
        devcontainerConfigPath: ".devcontainer/frontend/devcontainer.json",
      }),
    ]);

    expect(content).toContain(
      'runtime: Runtime.devcontainer({ config: ".devcontainer/frontend/devcontainer.json" }),',
    );
    expect(content).toContain(
      'import { defineStep, Runtime } from "@boboddy/sdk/definitions/steps";',
    );
  });

  test("omits environment and the Runtime import for a default workspace step", () => {
    const content = generateStepsFileContent([
      makeStep({ executionMode: "workspace", devcontainerConfigPath: null }),
    ]);

    expect(content).not.toContain("environment:");
    expect(content).not.toContain("executionMode");
    expect(content).not.toContain("Runtime");
  });

  test("groups runtime and vars in one environment object and imports Runtime and Env", () => {
    const content = generateStepsFileContent([
      makeStep({
        devcontainerConfigPath: ".devcontainer/perf/devcontainer.json",
        envJson: [
          {
            name: "PROFILER_TOKEN",
            source: "inherit",
            from: "PROFILER_TOKEN",
            secret: true,
            optional: false,
          },
        ],
      }),
    ]);

    expect(content).toContain(
      [
        "  environment: {",
        '    runtime: Runtime.devcontainer({ config: ".devcontainer/perf/devcontainer.json" }),',
        "    vars: () => ({",
        "      PROFILER_TOKEN: Env.inherit({ secret: true }),",
        "    }),",
        "  },",
      ].join("\n"),
    );
    expect(content).toContain(
      'import { defineStep, Runtime, Env } from "@boboddy/sdk/definitions/steps";',
    );
  });

  test("imports Runtime only when some step needs it", () => {
    const content = generateStepsFileContent([
      makeStep({ key: "plain" }),
      makeStep({ key: "summarize", executionMode: "no_workspace" }),
    ]);

    expect(content).toContain(
      'import { defineStep, Runtime } from "@boboddy/sdk/definitions/steps";',
    );
    expect(content.match(/Runtime\.host\(\)/g)).toHaveLength(1);
  });

  test("a generated steps file round-trips executionMode and devcontainerConfigPath", async () => {
    const cases: Array<{
      key: string;
      executionMode: StepDefContract["executionMode"];
      devcontainerConfigPath: string | null;
    }> = [
      {
        key: "default-step",
        executionMode: "workspace",
        devcontainerConfigPath: null,
      },
      {
        key: "alt-config-step",
        executionMode: "workspace",
        devcontainerConfigPath: ".devcontainer/alt/devcontainer.json",
      },
      {
        key: "root-config-step",
        executionMode: "workspace",
        devcontainerConfigPath: ".devcontainer.json",
      },
      {
        key: "host-step",
        executionMode: "no_workspace",
        devcontainerConfigPath: null,
      },
    ];
    const content = generateStepsFileContent(
      cases.map((entry) => makeStep(entry)),
    );

    const dir = await mkdtemp(path.join(import.meta.dir, ".roundtrip-"));
    try {
      const file = path.join(dir, "steps.ts");
      await writeFile(file, content, "utf-8");
      const loaded = (await import(file)) as Record<
        string,
        { executionMode: string; devcontainerConfigPath: string | null }
      >;

      expect(loaded["defaultStep"]).toMatchObject(cases[0] ?? {});
      expect(loaded["altConfigStep"]).toMatchObject(cases[1] ?? {});
      expect(loaded["rootConfigStep"]).toMatchObject(cases[2] ?? {});
      expect(loaded["hostStep"]).toMatchObject(cases[3] ?? {});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("omits repo and the Repo import when it is the runtime default", () => {
    const content = generateStepsFileContent([
      makeStep({ key: "workspace-default" }),
      makeStep({
        key: "host-default",
        executionMode: "no_workspace",
        repo: { mode: "none" },
      }),
      makeStep({
        key: "explicit-default",
        repo: { mode: "readWrite", message: null, onPushFailure: "fail" },
      }),
    ]);

    expect(content).not.toContain("repo:");
    expect(content).not.toContain("Repo");
  });

  test("emits Repo.readOnly() inside a minimal environment", () => {
    const content = generateStepsFileContent([
      makeStep({ repo: { mode: "readOnly" } }),
    ]);

    expect(content).toContain(
      "  environment: {\n    repo: Repo.readOnly(),\n  },",
    );
    expect(content).toContain(
      'import { defineStep, Repo } from "@boboddy/sdk/definitions/steps";',
    );
    expect(content).not.toContain("Runtime");
  });

  test("emits the static form for a message without tokens", () => {
    const content = generateStepsFileContent([
      makeStep({
        repo: {
          mode: "readWrite",
          message: 'fix: "quoted"',
          onPushFailure: "fail",
        },
      }),
    ]);

    expect(content).toContain(
      '    repo: Repo.readWrite({ message: "fix: \\"quoted\\"" }),',
    );
  });

  test("emits onPushFailure only when it is not the default", () => {
    const content = generateStepsFileContent([
      makeStep({
        repo: { mode: "readWrite", message: null, onPushFailure: "warn" },
      }),
    ]);

    expect(content).toContain(
      '    repo: Repo.readWrite({ onPushFailure: "warn" }),',
    );
  });

  test("emits the function form and destructures only the proxies a message reads", () => {
    const content = generateStepsFileContent([
      makeStep({
        key: "result-only",
        repo: {
          mode: "readWrite",
          message: "fix: {{result.summary}}",
          onPushFailure: "fail",
        },
      }),
      makeStep({
        key: "both",
        repo: {
          mode: "readWrite",
          message: "{{result.summary}} for {{input.ticket-id}}",
          onPushFailure: "warn",
        },
      }),
    ]);

    expect(content).toContain(
      "    repo: ({ result }) => Repo.readWrite({ message: `fix: ${result.summary}` }),",
    );
    expect(content).toContain(
      '    repo: ({ input, result }) => Repo.readWrite({ message: `${result.summary} for ${input["ticket-id"]}`, onPushFailure: "warn" }),',
    );
  });

  test("escapes backticks, interpolation openers and backslashes beside tokens", () => {
    const content = generateStepsFileContent([
      makeStep({
        repo: {
          mode: "readWrite",
          message: "`a` ${b} \\ {{input.title}}",
          onPushFailure: "fail",
        },
      }),
    ]);

    expect(content).toContain("message: `\\`a\\` \\${b} \\\\ ${input.title}`");
  });

  test("places repo beside runtime and vars in one environment object", () => {
    const content = generateStepsFileContent([
      makeStep({
        devcontainerConfigPath: ".devcontainer/perf/devcontainer.json",
        repo: { mode: "readOnly" },
        envJson: [
          {
            name: "PROFILER_TOKEN",
            source: "inherit",
            from: "PROFILER_TOKEN",
            secret: true,
            optional: false,
          },
        ],
      }),
    ]);

    expect(content).toContain(
      [
        "  environment: {",
        '    runtime: Runtime.devcontainer({ config: ".devcontainer/perf/devcontainer.json" }),',
        "    vars: () => ({",
        "      PROFILER_TOKEN: Env.inherit({ secret: true }),",
        "    }),",
        "    repo: Repo.readOnly(),",
        "  },",
      ].join("\n"),
    );
    expect(content).toContain(
      'import { defineStep, Runtime, Repo, Env } from "@boboddy/sdk/definitions/steps";',
    );
  });

  test("a generated steps file round-trips repo through defineStep", async () => {
    const cases: Array<{
      key: string;
      varName: string;
      executionMode: StepDefContract["executionMode"];
      repo: RepoConfig;
      authored: RepoConfigInput | undefined;
    }> = [
      {
        key: "read-only",
        varName: "readOnly",
        executionMode: "workspace",
        repo: { mode: "readOnly" },
        authored: { mode: "readOnly" },
      },
      {
        key: "read-write-default",
        varName: "readWriteDefault",
        executionMode: "workspace",
        repo: { mode: "readWrite", message: null, onPushFailure: "fail" },
        authored: undefined,
      },
      {
        key: "static-message",
        varName: "staticMessage",
        executionMode: "workspace",
        repo: {
          mode: "readWrite",
          message: "chore: tidy",
          onPushFailure: "fail",
        },
        authored: { mode: "readWrite", message: "chore: tidy" },
      },
      {
        key: "result-token",
        varName: "resultToken",
        executionMode: "workspace",
        repo: {
          mode: "readWrite",
          message: "fix: {{result.summary}}",
          onPushFailure: "fail",
        },
        authored: { mode: "readWrite", message: "fix: {{result.summary}}" },
      },
      {
        key: "input-and-result-tokens",
        varName: "inputAndResultTokens",
        executionMode: "workspace",
        repo: {
          mode: "readWrite",
          message: "{{input.ticket}}: {{result.summary}}",
          onPushFailure: "fail",
        },
        authored: {
          mode: "readWrite",
          message: "{{input.ticket}}: {{result.summary}}",
        },
      },
      {
        key: "warn-only",
        varName: "warnOnly",
        executionMode: "workspace",
        repo: { mode: "readWrite", message: null, onPushFailure: "warn" },
        authored: { mode: "readWrite", onPushFailure: "warn" },
      },
      {
        key: "message-and-warn",
        varName: "messageAndWarn",
        executionMode: "workspace",
        repo: {
          mode: "readWrite",
          message: "wip: {{result.summary}}",
          onPushFailure: "warn",
        },
        authored: {
          mode: "readWrite",
          message: "wip: {{result.summary}}",
          onPushFailure: "warn",
        },
      },
      {
        key: "host-none",
        varName: "hostNone",
        executionMode: "no_workspace",
        repo: { mode: "none" },
        authored: undefined,
      },
    ];
    const content = generateStepsFileContent(
      cases.map(({ key, executionMode, repo }) =>
        makeStep({ key, executionMode, repo }),
      ),
    );

    const dir = await mkdtemp(path.join(import.meta.dir, ".roundtrip-"));
    try {
      const file = path.join(dir, "steps.ts");
      await writeFile(file, content, "utf-8");
      const loaded = (await import(file)) as Record<
        string,
        { repo?: RepoConfigInput }
      >;

      for (const entry of cases) {
        const spec = loaded[entry.varName];
        expect({ key: entry.key, repo: spec?.repo }).toEqual({
          key: entry.key,
          repo: entry.authored,
        });
        expect({
          key: entry.key,
          repo: resolveRepoConfig(entry.executionMode, spec?.repo),
        }).toEqual({ key: entry.key, repo: entry.repo });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
