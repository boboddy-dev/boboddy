import type { PipelineStudioServerHandle } from "@boboddy/worker";
import type { BaseReporter } from "./reporter-types";

/**
 * Starts the pipeline studio as a companion to another command (the design
 * session). It is never a gate: a server that fails to start or a browser
 * that fails to open is reported as a warning and the caller carries on.
 */

export const STUDIO_UNAVAILABLE_MESSAGE =
  "Continuing without the studio. Run `boboddy pipelines studio` in another terminal to open it later.";

export const STUDIO_HANDOFF_MESSAGE =
  "The graph is in your browser; the designer is in this terminal.";

export function browserOpenFailedMessage(url: string): string {
  return `Could not open a browser automatically. Open ${url} manually.`;
}

export interface DesignStudioPorts {
  startServer(input: {
    builderDir: string;
  }): Promise<PipelineStudioServerHandle>;
  openBrowser(url: string): Promise<void>;
}

export type DesignStudioHandle = {
  url: string;
  browserOpened: boolean;
  close(): Promise<void>;
};

export async function startDesignStudio(input: {
  builderDir: string;
  reporter: BaseReporter;
  ports: DesignStudioPorts;
}): Promise<DesignStudioHandle | null> {
  const { builderDir, reporter, ports } = input;

  const task = reporter.startTask("Starting the pipeline studio…");
  let server: PipelineStudioServerHandle;
  try {
    server = await ports.startServer({ builderDir });
  } catch (error) {
    task.fail("Could not start the pipeline studio");
    reporter.warn(error instanceof Error ? error.message : String(error));
    reporter.info(STUDIO_UNAVAILABLE_MESSAGE);
    return null;
  }
  task.succeed(`Studio running at ${server.url}`);

  let browserOpened = true;
  try {
    await ports.openBrowser(server.url);
  } catch {
    browserOpened = false;
    reporter.warn(browserOpenFailedMessage(server.url));
  }

  return {
    url: server.url,
    browserOpened,
    close: async () => {
      try {
        await server.close();
      } catch {
        return;
      }
    },
  };
}
