import { spawn } from "node:child_process";
import { arch, platform, release } from "node:os";
import * as clack from "@clack/prompts";
import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import { withReporter } from "../lib/command-output";
import { repository, version as CLI_VERSION } from "../../package.json";

export interface ReportBugArguments {
  title?: string;
  description?: string;
  browser: boolean;
}

interface Diagnostics {
  cliVersion: string;
  node: string;
  platform: string;
  arch: string;
  osRelease: string;
}

function collectDiagnostics(): Diagnostics {
  return {
    cliVersion: CLI_VERSION,
    node: process.version,
    platform: platform(),
    arch: arch(),
    osRelease: release(),
  };
}

export function issuesBaseUrl(): string {
  const raw = typeof repository === "string" ? repository : repository.url;
  return raw.replace(/^git\+/, "").replace(/\.git$/, "");
}

export function formatBody(
  description: string,
  diagnostics: Diagnostics,
): string {
  return [
    "## Description",
    description,
    "",
    "## Diagnostics",
    "```",
    `CLI version: ${diagnostics.cliVersion}`,
    `Node:        ${diagnostics.node}`,
    `Platform:    ${diagnostics.platform} (${diagnostics.arch})`,
    `OS release:  ${diagnostics.osRelease}`,
    "```",
  ].join("\n");
}

export function buildIssueUrl(title: string, body: string): string {
  const params = new URLSearchParams({ title, body, labels: "bug" });
  return `${issuesBaseUrl()}/issues/new?${params.toString()}`;
}

async function promptIfMissing(
  value: string | undefined,
  question: string,
): Promise<string> {
  const trimmed = value?.trim();
  if (trimmed && trimmed.length > 0) {
    return trimmed;
  }

  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  if (!interactive) {
    throw new Error(
      `Missing required input for non-interactive mode: ${question.trim()}`,
    );
  }

  const answer = await clack.text({
    message: question.trim(),
    validate: (input: string | undefined) => {
      if (!input || input.trim().length === 0) {
        return "Please enter a value.";
      }
      return undefined;
    },
  });

  if (clack.isCancel(answer)) {
    throw new Error("Bug report cancelled.");
  }

  return answer.trim();
}

function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? (["open", [url]] as const)
      : process.platform === "win32"
        ? (["cmd", ["/c", "start", "", url]] as const)
        : (["xdg-open", [url]] as const);

  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => {
    // Browser launch is best-effort; the URL is always logged.
  });
  child.unref();
}

async function runReportBug(
  argv: ArgumentsCamelCase<ReportBugArguments>,
): Promise<void> {
  await withReporter("report-bug", async ({ reporter }) => {
    const title = await promptIfMissing(
      argv.title,
      "Short title for the bug: ",
    );
    const description = await promptIfMissing(
      argv.description,
      "Describe what happened: ",
    );
    const url = buildIssueUrl(
      title,
      formatBody(description, collectDiagnostics()),
    );

    if (argv.browser) {
      reporter.info("Opening prefilled bug report in your browser");
      openInBrowser(url);
      process.stdout.write(url + "\n");
      return;
    }

    reporter.info("Submit this URL to file the bug report");
    process.stdout.write(url + "\n");
  });
}

export const reportBugCommand: CommandModule<object, ReportBugArguments> = {
  command: "report-bug",
  describe: "File a bug report against the CLI",
  builder: (argv: Argv<object>) =>
    argv
      .option("title", {
        type: "string",
        describe: "Short summary of the bug",
      })
      .option("description", {
        type: "string",
        describe: "Detailed description of what happened",
      })
      .option("browser", {
        type: "boolean",
        default: true,
        describe: "Open the prefilled issue in your browser (use --no-browser to print the URL only)",
      }),
  handler: runReportBug,
};
