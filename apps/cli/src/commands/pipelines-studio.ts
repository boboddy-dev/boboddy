import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  PIPELINE_BUILDER_DIR,
  runPipelineStudioServer,
  scaffoldPipelineBuilderDirectory,
  type PipelineStudioServerHandle,
} from "@boboddy/worker";
import { version as CLI_VERSION } from "../../package.json";
import { openBrowser } from "../auth/browser";
import { withReporter } from "../lib/command-output";
import {
  runStudioPreflight,
  type StudioPreflightPorts,
} from "../lib/studio-preflight";
import type { CommandContext } from "../lib/command-output";
import type { BaseReporter } from "../lib/reporter-types";

/**
 * `boboddy pipelines studio` — a read-only, local-only visual designer (see
 * docs/research/flat-pipeline-sdk-and-visual-designer.md §10). Unlike
 * `pipelines design`, this command's terminal handoff is NOT a TUI: it starts
 * a local HTTP server, opens the user's browser to it, then just watches
 * `.boboddy/pipeline-builder` until the user Ctrl-Cs.
 */

interface StudioArguments {
  port: number | undefined;
}

/**
 * A scaffold in the wrong directory is quietly expensive — see the identical
 * check (and comment) in `pipelines-design.ts`. Duplicated rather than
 * shared: it is eight lines with no state, and this command's preflight is
 * intentionally decoupled from `design-preflight.ts`'s (see
 * `lib/studio-preflight.ts`'s own doc comment on why).
 */
function assertProjectRoot(cwd: string): void {
  if (existsSync(join(cwd, ".git")) || existsSync(join(cwd, ".boboddy"))) {
    return;
  }
  throw new Error(
    "Run `boboddy pipelines studio` from the root of your repository. " +
      `No .git or .boboddy directory was found in ${cwd}.`,
  );
}

function buildPreflightPorts(builderDir: string): StudioPreflightPorts {
  return {
    builderDirExists: () => existsSync(builderDir),
    scaffoldBuilderDir: () => {
      assertProjectRoot(process.cwd());
      scaffoldPipelineBuilderDirectory(builderDir, CLI_VERSION);
    },
    dependenciesInstalled: () =>
      existsSync(join(builderDir, "node_modules", "@boboddy", "sdk")),
  };
}

/**
 * Everything past the preflight, behind ports — so this ordering (preflight,
 * then start the server, then open the browser, then wait for Ctrl-C, then
 * close) is unit-testable without a real `Bun.serve`, a real file watcher, or
 * a real browser launch. See `test/pipelines-studio.test.ts`.
 */
export interface StudioSessionPorts extends StudioPreflightPorts {
  startServer(input: {
    builderDir: string;
    port: number | undefined;
  }): Promise<PipelineStudioServerHandle>;
  openBrowser(url: string): Promise<void>;
  /** Resolves once the user asks to stop (SIGINT/SIGTERM). */
  waitForShutdownSignal(): Promise<void>;
}

export async function runStudioSession(input: {
  builderDir: string;
  port: number | undefined;
  reporter: BaseReporter;
  ports: StudioSessionPorts;
}): Promise<void> {
  const { builderDir, port, reporter, ports } = input;

  runStudioPreflight({ reporter, ports });

  const handle = await ports.startServer({ builderDir, port });
  reporter.success(`Watching ${PIPELINE_BUILDER_DIR}`);
  reporter.info(`Studio running at ${handle.url}`);

  try {
    await ports.openBrowser(handle.url);
  } catch (error) {
    reporter.warn(
      `Could not open a browser automatically. Open ${handle.url} manually.`,
    );
    if (error instanceof Error) reporter.warn(error.message);
  }

  reporter.finish("Press Ctrl+C to stop watching.");
  await ports.waitForShutdownSignal();
  await handle.close();
}

/** Resolves once SIGINT or SIGTERM arrives, and stops listening for the other. */
function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolvePromise) => {
    const onSignal = () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      resolvePromise();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
}

function buildRealPorts(builderDir: string): StudioSessionPorts {
  return {
    ...buildPreflightPorts(builderDir),
    startServer: (options) => runPipelineStudioServer(options),
    openBrowser,
    waitForShutdownSignal,
  };
}

export const runPipelineStudio = (args: StudioArguments): Promise<void> =>
  withReporter("pipelines-studio", async (ctx: CommandContext) => {
    const builderDir = join(process.cwd(), PIPELINE_BUILDER_DIR);
    ctx.reporter.start("Boboddy pipeline studio");

    await runStudioSession({
      builderDir,
      port: args.port,
      reporter: ctx.reporter,
      ports: buildRealPorts(builderDir),
    });
  });

export const studioCommand: CommandModule<object, StudioArguments> = {
  command: "studio",
  describe: `Launch a local, read-only visual designer for ${PIPELINE_BUILDER_DIR}`,
  builder: (argv: Argv<object>) =>
    argv.option("port", {
      type: "number",
      describe: "Port to serve the studio on (defaults to a random free port)",
    }),
  handler: (args: ArgumentsCamelCase<StudioArguments>) =>
    runPipelineStudio(args),
};
