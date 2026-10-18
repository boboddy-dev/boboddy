import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { Info as ToolInfo } from "@opencode/plugin/promise/tool";

export const PLAYWRIGHT_TRACE_ANALYZER_TOOL = "playwright-trace-analyzer";

const subcommands = ["actions", "console", "network"] as const;

type Subcommand = (typeof subcommands)[number];

type PlaywrightTraceAnalyzerInput = {
  subcommand: Subcommand;
  tracePath: string;
};

function runPlaywrightTraceAnalyzer(
  subcommand: Subcommand,
  tracePath: string,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("playwright-trace-analyzer", [subcommand, tracePath], {
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });

    let output = "";

    child.stdout.on("data", (chunk: string | Buffer) => {
      output += chunk.toString();
    });

    child.stderr.on("data", (chunk: string | Buffer) => {
      output += chunk.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", () => {
      resolve(output);
    });
  });
}

export function createPlaywrightTraceAnalyzerTool(): ToolInfo {
  return {
    name: PLAYWRIGHT_TRACE_ANALYZER_TOOL,
    description:
      "Run playwright-trace-analyzer subcommands against a trace zip on Unix systems",
    input: {
      type: "object",
      properties: {
        subcommand: {
          type: "string",
          enum: [...subcommands],
          description: "Trace analyzer subcommand to run",
        },
        tracePath: {
          type: "string",
          description: "Path to the Playwright trace.zip file",
        },
      },
      required: ["subcommand", "tracePath"],
      additionalProperties: false,
    },
    options: { codemode: false },
    execute: async (input, context) => {
      const { subcommand, tracePath } = input as PlaywrightTraceAnalyzerInput;
      await access(tracePath, constants.R_OK);
      return {
        content: await runPlaywrightTraceAnalyzer(
          subcommand,
          tracePath,
          context.signal,
        ),
      };
    },
  };
}
