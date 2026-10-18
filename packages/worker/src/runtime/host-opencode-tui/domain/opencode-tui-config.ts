/**
 * Builds the inline OpenCode config injected into the interactive TUI via the
 * `OPENCODE_CONFIG_CONTENT` env var.
 *
 * Verified on OpenCode 2.0.28 (darwin-arm64) against `opencode serve` with the
 * same overlay, a sandboxed HOME/XDG and a session location in a subdirectory of
 * a git repository. The interactive TUI itself was not driven (it needs a tty);
 * `--standalone` runs the same server in-process.
 *
 * 1. The overlay is one more config document layered over the user's global
 *    `opencode.json[c]`. Agent fields merge per key (a global `description`
 *    survives next to our `system`/`mode`), and permission rules CONCATENATE in
 *    order: shipped base policy, then global `permissions`, then the agent's
 *    `permissions`. We never emit `model`, so the user's choice stays in force.
 * 2. `default_agent` is the only selector (v2 has no `--agent` flag). An
 *    unresolvable name falls back SILENTLY: no diagnostic, sessions still start.
 * 3. An agent with no `permissions` inherits the base policy: allow everything,
 *    ask before reading `*.env` / `*.env.*`. Explicit rules are the only way to
 *    get interactive gating.
 * 4. Unknown top-level keys are silently DROPPED (no rejection, no diagnostic).
 *    Nothing may rely on the runtime rejecting a misspelt key.
 * 5. `edit` resources are paths RELATIVE TO THE SESSION LOCATION — the TUI's
 *    cwd, i.e. the builder directory — not to the git worktree root. A file in
 *    the worktree but outside the location arrives as `../…`; a file outside the
 *    worktree arrives as an absolute path, after an `external_directory` check.
 *    `a/../../../x` is normalised before matching.
 * 6. `*` spans `/`: a bare `*` matches `a/b.txt` and `../../README.md` alike.
 * 7. The last matching rule wins. A compound shell command is split into one
 *    resource per command (`ls && boboddy pipelines push` checks `ls` and
 *    `boboddy pipelines push`), and any `ask` among them asks.
 * 8. A read outside the worktree is checked as `external_directory` with
 *    resource `<containing dir>/*`, then as `read` with the absolute path.
 */

import path from "node:path";

/** Effects an OpenCode permission rule can resolve to. */
export type OpencodePermissionEffect = "ask" | "allow" | "deny";

/** One entry of OpenCode v2's ordered `permissions` array. */
export type OpencodePermissionRule = {
  action: string;
  resource: string;
  effect: OpencodePermissionEffect;
};

/**
 * An injected agent definition. Intentionally omits `model` (see #1 above) and
 * every other optional agent key we have no reason to pin.
 */
export type OpencodeInjectedAgentConfig = {
  description: string;
  mode: "primary";
  system: string;
  permissions: OpencodePermissionRule[];
};

/** The whole injected config document. */
export type OpencodeInjectedConfig = {
  default_agent: string;
  agents: Record<string, OpencodeInjectedAgentConfig>;
};

/** Agent name used by `boboddy pipelines design`. */
export const PIPELINE_DESIGNER_AGENT_NAME = "pipeline-designer";

/**
 * Shell permission rules for the designer agent.
 *
 * Semantics: the LAST matching rule wins, so the base is the first entry and
 * every subsequent entry narrows it.
 *
 * ALLOW BY DEFAULT, deliberately. A design session is a supervised, interactive
 * conversation — the user is watching the TUI — and the agent legitimately needs
 * to run the project's own toolchain, which nobody can enumerate in advance:
 * every package manager, every test runner, every lint and typecheck script.
 * Gating that on approval turned the interview into a series of modals, so the
 * session runs the way stock OpenCode runs. The cost is real and accepted: `rm`,
 * `git push`, `curl | sh` and `npm publish` all run unattended here. The
 * containment boundary for a design session is the `edit` allowlist below (which
 * IS deny-by-default) plus the fact that a human is present, not these rules.
 *
 * THE ONE EXCEPTION — and the only reason these rules still exist:
 * `*pipelines push*` is `ask`, because that prompt IS the user's confirmation
 * that a pipeline should reach the server. It is the single point where the
 * session stops being local.
 *
 * INVARIANT: that pattern must stay wildcard-WRAPPED, `*…*`, not anchored.
 * Patterns match a whole command string, so an anchored `boboddy pipelines push`
 * would miss every real invocation: §9 of AUTHORING.md tells the agent to run
 * `cd ../.. && "$BOBODDY_CLI" pipelines push`, where `$BOBODDY_CLI` is an
 * absolute path that need not contain the word `boboddy` at all. Matching the
 * distinctive `pipelines push` substring catches the bare command, each segment
 * of a chained form (finding #7), and any binary path alike. Under an
 * allow-by-default base an anchored pattern does not merely weaken the gate — it
 * opens it completely.
 */
export const PIPELINE_DESIGNER_SHELL_PERMISSIONS: readonly OpencodePermissionRule[] =
  [
    { action: "shell", resource: "*", effect: "allow" },
    { action: "shell", resource: "*pipelines push*", effect: "ask" },
  ];

/**
 * File-write permission rules for the designer agent.
 *
 * Resources are paths relative to the session location (finding #5), and the
 * TUI is launched with the pipeline builder directory as its cwd. So:
 *
 * - `*` → allow: anything INSIDE the builder directory. Authoring definitions is
 *   the whole job, and `*` spans `/` so nested files are covered.
 * - `../*` and `/*` → ask: anything that leaves the builder directory, whether
 *   elsewhere in the repository (`../…`) or outside it (absolute). These two
 *   rules are what make the bare `*` above a builder-directory grant rather
 *   than a repository grant; they must come after it.
 * - `../../.devcontainer/*` → allow. A repo without a devcontainer cannot run a
 *   pipeline, so the agent authors one in-session; a config using
 *   `build.dockerfile` is useless without the Dockerfile beside it, so the grant
 *   is the directory whose only purpose is that config — not the repository.
 * - `../.env.example` → allow, one exact file. The interview records the *name*
 *   of any secret a new tool needs there — never a real value — so the user
 *   knows what to fill in when they create `.boboddy/.env` themselves.
 *   `.boboddy/.env` (the real secrets) is deliberately absent: it is not a file
 *   the agent may ever write, and this is the enforcement of that, independent
 *   of what the prompt says.
 *
 * INVARIANT: every `allow` after the escape rules must start with `../` and
 * contain no further wildcard before its directory name — a leading wildcard
 * there silently re-grants the entire repository.
 *
 * The `../` prefixes encode the builder directory's depth (`PIPELINE_BUILDER_DIR`
 * in the scaffolder) and `DEVCONTAINER_CONFIG_PATH` in `ensure-devcontainer`.
 * They are spelled out here rather than imported, to keep a domain module free
 * of a cross-context dependency on an infra and an application module. The unit
 * tests import both constants and assert these rules still *resolve* their
 * paths to `allow`, so renaming or moving either fails there rather than
 * silently costing the agent an approval prompt on every write.
 */
export const PIPELINE_DESIGNER_EDIT_PERMISSIONS: readonly OpencodePermissionRule[] =
  [
    { action: "edit", resource: "*", effect: "allow" },
    { action: "edit", resource: "../*", effect: "ask" },
    { action: "edit", resource: "/*", effect: "ask" },
    { action: "edit", resource: "../../.devcontainer/*", effect: "allow" },
    { action: "edit", resource: "../.env.example", effect: "allow" },
  ];

/**
 * Read grants for files OUTSIDE the worktree — today only the preflight's
 * `discovered-tools.json`. OpenCode checks an external read twice: first
 * `external_directory` against `<containing dir>/*`, then `read` against the
 * absolute path. Both are granted, scoped to the one file's directory and the
 * one file, so the generic `external_directory: ask` never prompts for it.
 */
export function buildExternalReadPermissions(
  paths: readonly string[],
): OpencodePermissionRule[] {
  return paths.flatMap((file) => [
    {
      action: "external_directory",
      resource: `${path.dirname(file)}/*`,
      effect: "allow" as const,
    },
    { action: "read", resource: file, effect: "allow" as const },
  ]);
}

/**
 * The designer agent's full ordered rule list. Reading is unattended and
 * repo-wide — the agent has to orient itself. Writing is confined to the
 * allowlist above; anything that reaches the network, spawns a subagent, or
 * escapes the worktree asks first, except the exact external files in
 * `readAllowPaths` (see {@link buildExternalReadPermissions}).
 */
export function buildDesignerPermissions(
  shell: readonly OpencodePermissionRule[] = PIPELINE_DESIGNER_SHELL_PERMISSIONS,
  edit: readonly OpencodePermissionRule[] = PIPELINE_DESIGNER_EDIT_PERMISSIONS,
  readAllowPaths: readonly string[] = [],
): OpencodePermissionRule[] {
  const rule = (
    action: string,
    effect: OpencodePermissionEffect,
  ): OpencodePermissionRule => ({ action, resource: "*", effect });
  return [
    rule("read", "allow"),
    rule("glob", "allow"),
    rule("grep", "allow"),
    rule("question", "allow"),
    rule("subagent", "ask"),
    rule("webfetch", "ask"),
    rule("websearch", "ask"),
    rule("external_directory", "ask"),
    ...buildExternalReadPermissions(readAllowPaths),
    ...shell.map((entry) => ({ ...entry })),
    ...edit.map((entry) => ({ ...entry })),
  ];
}

export type BuildOpencodeTuiConfigInput = {
  /** Agent name, emitted as `default_agent`. */
  agentName?: string | undefined;
  /** Shown in the TUI agent picker. */
  description: string;
  /** The full system prompt, emitted as the agent's `system`. */
  prompt: string;
  /** Override the shell rules. Defaults to the designer rules above. */
  shellPermissions?: readonly OpencodePermissionRule[] | undefined;
  /** Absolute paths outside the worktree the agent may read without asking. */
  readAllowPaths?: readonly string[] | undefined;
};

/**
 * Build the injected config document for a primary TUI agent.
 *
 * Note `model` is never emitted: layering means the user's global
 * `model`/`providers` selection flows through untouched.
 */
export function buildOpencodeTuiConfig(
  input: BuildOpencodeTuiConfigInput,
): OpencodeInjectedConfig {
  const agentName = input.agentName ?? PIPELINE_DESIGNER_AGENT_NAME;
  return {
    default_agent: agentName,
    agents: {
      [agentName]: {
        description: input.description,
        mode: "primary",
        system: input.prompt,
        permissions: buildDesignerPermissions(
          input.shellPermissions,
          undefined,
          input.readAllowPaths,
        ),
      },
    },
  };
}

/** Serialize an injected config for the `OPENCODE_CONFIG_CONTENT` env var. */
export function serializeOpencodeTuiConfig(
  config: OpencodeInjectedConfig,
): string {
  return JSON.stringify(config);
}

/**
 * Resolve the effect for one `action`/`resource` pair using OpenCode's
 * last-matching-rule-wins semantics, with `ask` when nothing matches. The
 * resource is one command for `shell` (a compound command is several checks)
 * and a location-relative path for `edit`.
 *
 * This mirrors the runtime's resolution so the allowlists can be asserted in
 * unit tests without spawning a real TUI. Patterns support `*` (any run of
 * characters, including `/` and none) and `?`; everything else is literal. A
 * shell pattern ending in ` *` also matches the command without arguments.
 */
export function resolvePermission(
  rules: readonly OpencodePermissionRule[],
  action: string,
  resource: string,
): OpencodePermissionEffect {
  let effect: OpencodePermissionEffect = "ask";
  for (const rule of rules) {
    if (
      globMatches(rule.action, action) &&
      resourceMatches(rule, action, resource)
    ) {
      effect = rule.effect;
    }
  }
  return effect;
}

function resourceMatches(
  rule: OpencodePermissionRule,
  action: string,
  resource: string,
): boolean {
  if (globMatches(rule.resource, resource)) {
    return true;
  }
  return (
    action === "shell" &&
    rule.resource.endsWith(" *") &&
    globMatches(rule.resource.slice(0, -2), resource)
  );
}

function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  const source = `^${escaped.replaceAll("*", ".*").replaceAll("?", ".")}$`;
  return new RegExp(source, "su").test(value);
}
