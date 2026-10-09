import {
  assertInteractiveTerminal,
  hasFailedExitCode,
  launchOpencodeAuthLogin,
  type InstalledAiTool,
  type OpencodeProviderCredentialCheck,
} from "@boboddy/worker";
import { AnalyticsEvents } from "@boboddy/observability/analytics/events";
import type { BaseReporter } from "./reporter-types";
import { CliError } from "./cli-error";
import { captureMilestone } from "./telemetry";

/**
 * The design preflight's provider-connect step: make sure OpenCode has a
 * model to talk to before the TUI launches, and heal it in place when not.
 *
 * With no credential (auth.json entry or recognized API-key env var — see
 * `checkOpencodeProviderCredentials`), it names the AI tools the user already
 * has (see `detectInstalledAiTools`), tells them which entry to pick in
 * OpenCode's own `auth login` picker for each, hands the terminal to that
 * picker, then rechecks. Boboddy never reads, copies, or proxies another
 * tool's tokens — the connection is always the user's action in OpenCode.
 *
 * Picker labels below were transcribed from a live capture of
 * `~/.boboddy/runtimes/opencode/1.18.11/launch.sh auth login` (OpenCode
 * 1.18.11, the pinned `BOBODDY_OPENCODE_RUNTIME_VERSION`). Re-check them
 * whenever that pin moves.
 *
 *   ◆  Select provider            (searchable list; first entries shown)
 *   │  ● OpenCode Zen (recommended)
 *   │  ○ OpenAI                   (search hint: "OpenAI (ChatGPT Plus/Pro or API key)")
 *   │  ○ GitHub Copilot
 *   │  ○ Google
 *   │  ○ Anthropic
 *   │  ○ OpenRouter
 *   │  ○ Vercel AI Gateway
 *
 *   Anthropic      → no method picker; goes straight to "Enter your API key".
 *                    There is no Claude Pro/Max subscription option.
 *   OpenAI         → "Login method":
 *                      ● ChatGPT Pro/Plus (browser)
 *                      ○ ChatGPT Pro/Plus (headless)
 *                      ○ Manually enter API Key
 *   GitHub Copilot → "Select GitHub deployment type":
 *                      ● GitHub.com (Public)
 *                      ○ GitHub Enterprise
 *                    (the device-code screen after this was not captured, to
 *                    avoid starting a real device flow)
 */

export interface ProviderConnectPorts {
  /** Does a usable OpenCode credential exist (auth.json or env var)? */
  checkCredentials(
    launcherPath: string,
  ): Promise<OpencodeProviderCredentialCheck>;
  /** Which AI tools are installed on this machine — names only. */
  detectInstalledTools(): Promise<InstalledAiTool[]>;
  /**
   * Run `opencode auth login` attached to the terminal. Resolves once the
   * user finishes (or quits) it; throws on a non-interactive terminal or a
   * non-zero exit.
   */
  runAuthLogin(launcherPath: string): Promise<void>;
}

export const CONNECT_GUIDANCE_HEADER_LINES: readonly string[] = [
  "Connect an AI provider",
  "The designer runs on OpenCode, which needs its own connection to a model.",
  "This is one-time: the same connection runs your pipeline steps later.",
];

export const CONNECT_TOOL_LINES: Readonly<Record<InstalledAiTool, string>> = {
  claude:
    'You have Claude Code. In the picker choose "Anthropic" and paste an API ' +
    "key from console.anthropic.com — a Claude Pro/Max subscription can't be " +
    "reused here.",
  copilot:
    'You have GitHub Copilot. In the picker choose "GitHub Copilot", then ' +
    '"GitHub.com (Public)" (or "GitHub Enterprise"), and enter the device ' +
    "code it shows at github.com/login/device.",
  codex:
    'You have Codex. In the picker choose "OpenAI", then "ChatGPT Pro/Plus ' +
    '(browser)" to use your ChatGPT subscription (or "Manually enter API ' +
    'Key"), and approve in the browser.',
};

const CONNECT_TOOL_ORDER: readonly InstalledAiTool[] = [
  "claude",
  "copilot",
  "codex",
];

export const CONNECT_NO_TOOL_LINE =
  "In the picker choose a provider (Anthropic is recommended) and follow the prompts.";

export const CONNECT_HANDOFF_LINE = "Opening the provider connection…";

export const CONNECT_DID_NOT_COMPLETE_MESSAGE =
  "No AI provider was connected. Run `boboddy pipelines design` again to " +
  "retry, or export a provider API key such as ANTHROPIC_API_KEY first.";

const DESIGNER_TITLE = "Boboddy pipeline designer";

/** The guidance block, one entry per `reporter.info` line. */
export function buildConnectGuidance(
  detected: readonly InstalledAiTool[],
): string[] {
  const toolLines = CONNECT_TOOL_ORDER.filter((tool) =>
    detected.includes(tool),
  ).map((tool) => CONNECT_TOOL_LINES[tool]);
  return [
    ...CONNECT_GUIDANCE_HEADER_LINES,
    ...(toolLines.length > 0 ? toolLines : [CONNECT_NO_TOOL_LINE]),
  ];
}

export async function ensureProviderConnected(input: {
  launcherPath: string;
  reporter: BaseReporter;
  ports: ProviderConnectPorts;
}): Promise<{ providers: readonly string[] }> {
  const { launcherPath, reporter, ports } = input;

  const check = await ports.checkCredentials(launcherPath);
  if (check.ok) {
    reporter.success(providerReadyLine(check.providers));
    return { providers: check.providers };
  }

  const detected = await ports.detectInstalledTools();
  captureMilestone(AnalyticsEvents.CliProviderConnectStarted, { detected });
  for (const line of buildConnectGuidance(detected)) {
    reporter.info(line);
  }

  // The clack block must close before the attached child owns the tty.
  reporter.finish(CONNECT_HANDOFF_LINE);
  await ports.runAuthLogin(launcherPath);
  reporter.start(DESIGNER_TITLE);

  const recheck = await ports.checkCredentials(launcherPath);
  if (!recheck.ok) {
    throw new CliError(
      "opencode_login_failed",
      CONNECT_DID_NOT_COMPLETE_MESSAGE,
    );
  }
  reporter.success(providerReadyLine(recheck.providers));
  captureMilestone(AnalyticsEvents.CliProviderConnectCompleted, {
    providers: recheck.providers,
  });
  return { providers: recheck.providers };
}

/**
 * The real {@link ProviderConnectPorts.runAuthLogin}: `opencode auth login`
 * attached to the user's terminal.
 */
export async function runOpencodeAuthLogin(
  launcherPath: string,
): Promise<void> {
  assertInteractiveTerminal();
  const result = await launchOpencodeAuthLogin({
    launcherPath,
    cwd: process.cwd(),
  });
  if (hasFailedExitCode(result)) {
    throw new CliError(
      "opencode_login_failed",
      `\`opencode auth login\` exited with code ${String(result.exitCode)}. ` +
        "Run `boboddy pipelines design` again once you have signed in.",
    );
  }
}

function providerReadyLine(providers: readonly string[]): string {
  return `AI provider ready (${providers.join(", ")})`;
}
