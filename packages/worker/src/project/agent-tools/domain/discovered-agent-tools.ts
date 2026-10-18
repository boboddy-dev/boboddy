import type { ResolvedOpenCodeMcpServerConfig } from "../../../common/contracts/opencode-mcp";

/**
 * The MCP servers and skills a repository already defines for coding agents,
 * as found by `discoverRepoAgentTools`. Nothing here carries a secret value:
 * variables are `{env:VAR}` placeholders and credential-looking literals are
 * recorded by key name only.
 */

/** The file shapes discovery understands. */
export type McpConfigFormat =
  "opencode" | "claude" | "cursor" | "vscode" | "codex";

/**
 * Repo-relative MCP config files, in precedence order: the first file that
 * defines a server name wins.
 */
export const MCP_CONFIG_FILES = [
  { file: ".opencode/opencode.json", format: "opencode" },
  { file: ".opencode/opencode.jsonc", format: "opencode" },
  { file: "opencode.json", format: "opencode" },
  { file: "opencode.jsonc", format: "opencode" },
  { file: ".mcp.json", format: "claude" },
  { file: ".cursor/mcp.json", format: "cursor" },
  { file: ".vscode/mcp.json", format: "vscode" },
  { file: ".codex/config.toml", format: "codex" },
] as const satisfies readonly { file: string; format: McpConfigFormat }[];

/**
 * Repo-relative skill directories in the order OpenCode 2.0.28 loads them:
 * its compatibility plugin reads `.claude` then `.agents`, and its skill
 * plugin then reads `.opencode/skill` and `.opencode/skills`. A skill id
 * defined in more than one place resolves to the LAST one loaded.
 */
export const SKILL_DIRECTORIES = [
  ".claude/skills",
  ".agents/skills",
  ".opencode/skill",
  ".opencode/skills",
] as const;

/** A literal credential found in a server definition and removed from it. */
export type InlineSecret = {
  /** `oauth` means `oauth.client_secret`. */
  field: "environment" | "headers" | "oauth";
  key: string;
  inlineSecret: true;
};

export type DiscoveredMcpServer = {
  name: string;
  /** Repo-relative file the winning definition came from. */
  source: string;
  transport: ResolvedOpenCodeMcpServerConfig["type"];
  /**
   * The definition in OpenCode v2 shape, with every variable as `{env:VAR}`
   * and every inline secret removed.
   */
  config: ResolvedOpenCodeMcpServerConfig;
  /** Every `{env:VAR}` name the definition reads, sorted. */
  requiredEnv: string[];
  inlineSecrets: InlineSecret[];
  /** Lower-precedence files that also define this name. */
  shadowed: { source: string }[];
};

export type DiscoveredSkill = {
  /**
   * The id the agent loads the skill by, which OpenCode takes from the path:
   * the parent directory's name for a `SKILL.md`, the file stem for a
   * `<skills dir>/<name>.md`. A frontmatter `name` does not change it.
   */
  name: string;
  description: string;
  /** Repo-relative path of the skill file. */
  path: string;
  /** Files with the same id that OpenCode loads earlier, so never uses. */
  shadowed: { path: string }[];
};

/** An entry discovery found but cannot use, and why. */
export type SkippedAgentTool = {
  kind: "server" | "skill";
  /** Repo-relative file the entry is in. */
  source: string;
  /** The server or skill name, or `null` when the whole file was unusable. */
  name: string | null;
  reason: string;
};

export type SearchedMcpConfigFile = {
  /** Repo-relative path. */
  file: string;
  /** Absolute path. */
  path: string;
  present: boolean;
};

export type DiscoveredAgentTools = {
  servers: DiscoveredMcpServer[];
  skills: DiscoveredSkill[];
  skipped: SkippedAgentTool[];
  /** Every MCP config file looked at, in precedence order. */
  searched: SearchedMcpConfigFile[];
};
