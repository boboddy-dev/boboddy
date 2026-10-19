import { describe, expect, setDefaultTimeout } from "bun:test";
import type { LaunchOpencodeTuiInput } from "@boboddy/worker";
import {
  runDesignSession,
  type DesignArguments,
  type DesignSessionPorts,
} from "../src/lib/design-session";
import { STUDIO_HANDOFF_MESSAGE } from "../src/lib/design-studio";
import { createCliLogger } from "../src/lib/logger";
import {
  concurrentTest as test,
  createReporterRecorder,
  runCli,
} from "./utils";

// Spawns the CLI from source; under a loaded machine (test-all-workspaces)
// that overruns bun's 5s default.
setDefaultTimeout(15_000);

/**
 * The studio is a companion to the design session: it starts after the
 * preflight and before the TUI takes the terminal, reaches the agent only
 * through `BOBODDY_STUDIO_URL`, and is closed once the run offer is done or
 * the TUI exits non-zero — before the exit-code passthrough. Every port is a
 * fake; this file is about ordering and wiring.
 */

const STUDIO_URL = "http://localhost:54321";
const MANIFEST_PATH =
  "/home/test/.boboddy/projects/acme/project-1/discovered-tools.json";

const ARGS: DesignArguments = {
  project: undefined,
  baseUrl: "https://app.example.com",
  workItemId: undefined,
  studio: true,
  repoRoot: "/nonexistent/boboddy-design-studio-test",
};

type Recorded = {
  order: string[];
  tuiInput: LaunchOpencodeTuiInput | undefined;
  exitCodes: number[];
};

function createPorts(
  options: {
    studioStarts?: boolean;
    tuiExitCode?: number;
  } = {},
): { ports: DesignSessionPorts; recorded: Recorded } {
  const { studioStarts = true, tuiExitCode = 0 } = options;
  const recorded: Recorded = { order: [], tuiInput: undefined, exitCodes: [] };

  const ports: DesignSessionPorts = {
    preflight: () => {
      recorded.order.push("preflight");
      return Promise.resolve({
        projectId: "project-1",
        project: "acme/project-1",
        workItem: {
          id: "work-item-1",
          title: "Fix the flaky test",
          description: "",
          platform: "github",
        },
        launcherPath: "/runtime/launch.sh",
        providers: ["anthropic"],
        agentToolsManifestPath: MANIFEST_PATH,
      });
    },
    startStudio: () => {
      recorded.order.push("startStudio");
      if (!studioStarts) return Promise.resolve(null);
      return Promise.resolve({
        url: STUDIO_URL,
        browserOpened: true,
        close: () => {
          recorded.order.push("closeStudio");
          return Promise.resolve();
        },
      });
    },
    launchTui: (input) => {
      recorded.order.push("launchTui");
      recorded.tuiInput = input;
      return Promise.resolve({ exitCode: tuiExitCode, signal: null });
    },
    runOffer: () => {
      recorded.order.push("runOffer");
      return Promise.resolve({ ran: false });
    },
    exit: (code) => {
      recorded.order.push("exit");
      recorded.exitCodes.push(code);
    },
  };

  return { ports, recorded };
}

function createContext() {
  const recorder = createReporterRecorder();
  return {
    recorder,
    ctx: {
      reporter: recorder.reporter,
      logger: createCliLogger("test"),
      logFilePath: "",
    },
  };
}

describe("runDesignSession — studio companion", () => {
  test("starts the studio after the preflight and before the TUI, and hands its URL to the agent", async () => {
    const { ports, recorded } = createPorts();
    const { ctx, recorder } = createContext();

    await runDesignSession({ args: ARGS, ctx, ports });

    expect(recorded.order).toEqual([
      "preflight",
      "startStudio",
      "launchTui",
      "runOffer",
      "closeStudio",
    ]);
    expect(recorded.tuiInput?.env?.["BOBODDY_STUDIO_URL"]).toBe(STUDIO_URL);
    expect(recorder.calls.at(-1)).toEqual({
      method: "finish",
      message: `Starting the designer… ${STUDIO_HANDOFF_MESSAGE}`,
    });
  });

  test("--no-studio never starts the studio and sets no studio URL", async () => {
    const { ports, recorded } = createPorts();
    const { ctx, recorder } = createContext();

    await runDesignSession({ args: { ...ARGS, studio: false }, ctx, ports });

    expect(recorded.order).toEqual(["preflight", "launchTui", "runOffer"]);
    expect(recorded.tuiInput?.env).not.toHaveProperty("BOBODDY_STUDIO_URL");
    expect(recorder.calls.at(-1)).toEqual({
      method: "finish",
      message: "Starting the designer…",
    });
  });

  test("a studio that fails to start leaves the session running without a studio URL", async () => {
    const { ports, recorded } = createPorts({ studioStarts: false });
    const { ctx } = createContext();

    await runDesignSession({ args: ARGS, ctx, ports });

    expect(recorded.order).toEqual([
      "preflight",
      "startStudio",
      "launchTui",
      "runOffer",
    ]);
    expect(recorded.tuiInput?.env).not.toHaveProperty("BOBODDY_STUDIO_URL");
  });

  test("closes the studio before passing a non-zero TUI exit code through", async () => {
    const { ports, recorded } = createPorts({ tuiExitCode: 3 });
    const { ctx } = createContext();

    await runDesignSession({ args: ARGS, ctx, ports });

    expect(recorded.order).toEqual([
      "preflight",
      "startStudio",
      "launchTui",
      "runOffer",
      "closeStudio",
      "exit",
    ]);
    expect(recorded.exitCodes).toEqual([3]);
  });

  test("closes the studio when the run offer throws", async () => {
    const { ports, recorded } = createPorts();
    const { ctx } = createContext();

    let rejected = false;
    try {
      await runDesignSession({
        args: ARGS,
        ctx,
        ports: {
          ...ports,
          runOffer: () => Promise.reject(new Error("worker crashed")),
        },
      });
    } catch {
      rejected = true;
    }

    expect(rejected).toBe(true);

    expect(recorded.order.at(-1)).toBe("closeStudio");
  });
});

describe("runDesignSession — discovered-tools manifest", () => {
  test("names the manifest in the seed prompt and lets the agent read it without asking", async () => {
    const { ports, recorded } = createPorts();
    const { ctx } = createContext();

    await runDesignSession({ args: { ...ARGS, studio: false }, ctx, ports });

    expect(recorded.tuiInput?.seedPrompt).toContain(MANIFEST_PATH);
    const config = JSON.parse(recorded.tuiInput?.configContent ?? "{}") as {
      agents: Record<string, { permissions: unknown[] }>;
    };
    const permissions = Object.values(config.agents)[0]?.permissions;
    expect(permissions).toContainEqual({
      action: "read",
      resource: MANIFEST_PATH,
      effect: "allow",
    });
  });
});

// ─── Command wiring — spawns the real CLI, mirroring pipelines-studio.test.ts ─

async function help(args: readonly string[]): Promise<string> {
  const result = await runCli([...args, "--help"]);
  return `${result.stdout}${result.stderr}`;
}

describe("--studio flag wiring", () => {
  test("pipelines design --help lists --studio", async () => {
    expect(await help(["pipelines", "design"])).toContain("--studio");
  });

  test("init --help lists --studio", async () => {
    expect(await help(["init"])).toContain("--studio");
  });
});
