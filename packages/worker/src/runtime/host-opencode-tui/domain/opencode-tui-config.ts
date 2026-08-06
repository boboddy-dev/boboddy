/**
 * Builds the inline OpenCode config injected into the interactive TUI via the
 * `OPENCODE_CONFIG_CONTENT` env var.
 *
 * Empirically verified against opencode 1.18.11 (darwin-arm64):
 *
 * 1. `OPENCODE_CONFIG_CONTENT` is honored by the TUI, not just by `serve`.
 * 2. Layering is a DEEP MERGE with the user's global
 *    `~/.config/opencode/opencode.json[c]`; our content wins on scalar
 *    conflicts. The user's `model`/`provider` defaults therefore survive — so we
 *    deliberately DO NOT emit `model`, or we would override their choice.
 * 3. `default_agent` alone is enough to boot into our agent, but it fails
 *    SILENTLY (falls back to `build`) when the name is invalid. Callers must
 *    also pass `--agent <name>` on argv as the guard.
 * 4. Omitting `permission` does NOT produce prompts — it resolves to
 *    blanket-allow (`{"permission":"*","action":"allow","pattern":"*"}`),
 *    confirmed against a pristine HOME. An explicit `permission` block is
 *    mandatory to get any interactive gating at all.
 * 5. Unknown top-level keys are HARD-REJECTED at startup
 *    (`Unrecognized key: …`). Only schema-valid keys may be emitted.
 * 6. `edit` permission patterns are matched against the file path RELATIVE TO
 *    THE GIT WORKTREE ROOT (`path.relative(worktree, filePath)`), not relative
 *    to the agent's cwd. `external_directory` fires only for paths OUTSIDE that
 *    worktree, so launching the agent in a subdirectory scopes its writes not at
 *    all: `edit: "allow"` is unattended write access to the whole repository.
 *    Confirmed by writing `<repo>/.devcontainer/devcontainer.json` from a cwd of
 *    `<repo>/.boboddy/pipeline-builder` with no prompt.
 * 7. In an `edit` pattern, `*` spans `/` — `a/b/*` matches `a/b/c/d.ts`. So a
 *    pattern with a leading `*` re-grants the whole repository.
 */

/** Actions an OpenCode permission rule can resolve to. */
export type OpencodePermissionAction = "ask" | "allow" | "deny";

/**
 * A pattern-keyed permission rule map (OpenCode's `PermissionObjectConfig`).
 *
 * Keys are glob patterns. What they are matched against depends on the tool: the
 * whole command string for `bash`, the worktree-relative file path for `edit`.
 * The matching itself is identical in both cases — see {@link resolvePermission}.
 */
export type OpencodePermissionRules = Record<string, OpencodePermissionAction>;

/** The subset of OpenCode's `PermissionConfig` object form that we emit. */
export type OpencodeAgentPermissionConfig = {
  read: OpencodePermissionAction;
  /** Keyed by worktree-relative path pattern — see finding #6. */
  edit: OpencodePermissionRules;
  glob: OpencodePermissionAction;
  grep: OpencodePermissionAction;
  list: OpencodePermissionAction;
  todowrite: OpencodePermissionAction;
  question: OpencodePermissionAction;
  task: OpencodePermissionAction;
  webfetch: OpencodePermissionAction;
  websearch: OpencodePermissionAction;
  external_directory: OpencodePermissionAction;
  bash: OpencodePermissionRules;
};

/**
 * An injected agent definition. Intentionally omits `model` (see #2 above) and
 * every other optional `AgentConfig` key we have no reason to pin.
 */
export type OpencodeInjectedAgentConfig = {
  description: string;
  mode: "primary";
  prompt: string;
  permission: OpencodeAgentPermissionConfig;
};

/** The whole injected config document. Every key is schema-valid (see #5). */
export type OpencodeInjectedConfig = {
  default_agent: string;
  agent: Record<string, OpencodeInjectedAgentConfig>;
};

/** Agent name used by `boboddy pipelines design`. */
export const PIPELINE_DESIGNER_AGENT_NAME = "pipeline-designer";

/**
 * Bash permission rules for the designer agent.
 *
 * Semantics: the LAST matching pattern wins, so the base is the first entry and
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
 * IS deny-by-default) plus the fact that a human is present, not this map.
 *
 * THE ONE EXCEPTION — and the only reason this map still exists:
 * `*pipelines push*` is `ask`, because that prompt IS the user's confirmation
 * that a pipeline should reach the server. It is the single point where the
 * session stops being local.
 *
 * INVARIANT: that pattern must stay wildcard-WRAPPED, `*…*`, not anchored.
 * Patterns match the whole command STRING, so an anchored `boboddy pipelines
 * push` would miss every real invocation: §9 of AUTHORING.md tells the agent to
 * run `cd ../.. && "$BOBODDY_CLI" pipelines push`, where `$BOBODDY_CLI` is an
 * absolute path that need not contain the word `boboddy` at all. Matching the
 * distinctive `pipelines push` substring is what catches the bare command, the
 * chained form, and any binary path alike. Under an allow-by-default base an
 * anchored pattern does not merely weaken the gate — it opens it completely.
 */
export const PIPELINE_DESIGNER_BASH_PERMISSIONS: OpencodePermissionRules = {
  "*": "allow",
  "*pipelines push*": "ask",
};

/**
 * File-write permission rules for the designer agent.
 *
 * Same last-match-wins semantics as the bash allowlist, so `"*": "ask"` is the
 * deny-by-default base. Patterns are worktree-relative paths (finding #6), which
 * makes this the ONLY thing scoping the agent's writes: its builder-directory cwd
 * scopes nothing, and `external_directory` never fires for a path inside the
 * repository.
 *
 * Two carve-outs, both directories rather than single files:
 *
 * - The pipeline builder directory. Authoring definitions is the whole job, and
 *   `*` spans `/` so nested files are covered.
 * - `.devcontainer/`. A repo without a devcontainer cannot run a pipeline, so the
 *   agent authors one in-session; a config using `build.dockerfile` is useless
 *   without the Dockerfile beside it, so the grant is the directory whose only
 *   purpose is that config — not the repository root.
 *
 * INVARIANT: no `allow` pattern may begin with `*`. Because `*` spans `/`, a
 * leading wildcard silently re-grants the entire repository — the over-grant this
 * allowlist exists to remove.
 *
 * Both prefixes are load-bearing elsewhere: `PIPELINE_BUILDER_DIR` in the
 * scaffolder, and `DEVCONTAINER_CONFIG_PATH` in `ensure-devcontainer`. They are
 * spelled out here rather than imported, to keep a domain module free of a
 * cross-context dependency on an infra and an application module. The unit tests
 * import both constants and assert this allowlist still *resolves* their paths to
 * `allow`, so renaming either one fails here rather than silently costing the
 * agent an approval prompt on every write.
 */
export const PIPELINE_DESIGNER_EDIT_PERMISSIONS: OpencodePermissionRules = {
  "*": "ask",
  ".boboddy/pipeline-builder/*": "allow",
  ".devcontainer/*": "allow",
};

/**
 * Non-bash tool permissions for the designer agent. Reading is unattended and
 * repo-wide — the agent has to orient itself. Writing is confined to the
 * allowlist above; anything that reaches the network, spawns a subagent, or
 * escapes the worktree asks first.
 */
export function buildDesignerPermissions(
  bash: OpencodePermissionRules = PIPELINE_DESIGNER_BASH_PERMISSIONS,
  edit: OpencodePermissionRules = PIPELINE_DESIGNER_EDIT_PERMISSIONS,
): OpencodeAgentPermissionConfig {
  return {
    read: "allow",
    edit: { ...edit },
    glob: "allow",
    grep: "allow",
    list: "allow",
    todowrite: "allow",
    question: "allow",
    task: "ask",
    webfetch: "ask",
    websearch: "ask",
    external_directory: "ask",
    bash: { ...bash },
  };
}

export type BuildOpencodeTuiConfigInput = {
  /** Agent name. Must match the `--agent` argv flag the launcher passes. */
  agentName?: string | undefined;
  /** Shown in the TUI agent picker. */
  description: string;
  /** The full system prompt. Supplied by the caller (Phase 2 authors it). */
  prompt: string;
  /** Override the bash allowlist. Defaults to the designer rules above. */
  bashPermissions?: OpencodePermissionRules | undefined;
};

/**
 * Build the injected config document for a primary TUI agent.
 *
 * Note `model` is never emitted: the deep merge means the user's global
 * `model`/`provider` selection flows through untouched.
 */
export function buildOpencodeTuiConfig(
  input: BuildOpencodeTuiConfigInput,
): OpencodeInjectedConfig {
  const agentName = input.agentName ?? PIPELINE_DESIGNER_AGENT_NAME;
  return {
    default_agent: agentName,
    agent: {
      [agentName]: {
        description: input.description,
        mode: "primary",
        prompt: input.prompt,
        permission: buildDesignerPermissions(input.bashPermissions),
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
 * Resolve which action a value lands on, using OpenCode's last-matching-rule-wins
 * semantics. The value is a command string for `bash` rules and a
 * worktree-relative file path for `edit` rules; the matching is the same either
 * way, including `*` spanning `/`.
 *
 * This mirrors the runtime's resolution so the allowlists can be asserted in
 * unit tests without spawning a real TUI. Patterns support `*` (matches any run
 * of characters, including none) and `?`; everything else is literal.
 */
export function resolvePermission(
  rules: OpencodePermissionRules,
  subject: string,
): OpencodePermissionAction {
  let action: OpencodePermissionAction = "ask";
  for (const [pattern, candidate] of Object.entries(rules)) {
    if (globMatches(pattern, subject)) {
      action = candidate;
    }
  }
  return action;
}

function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  const source = `^${escaped.replaceAll("*", ".*").replaceAll("?", ".")}$`;
  return new RegExp(source, "u").test(value);
}
