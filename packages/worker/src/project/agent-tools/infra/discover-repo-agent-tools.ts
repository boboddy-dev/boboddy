import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  anyJsonValueSchema,
  type AnyJsonObject,
  type AnyJsonValue,
} from "../../../common/contracts/json";
import { parseJsonc } from "../../../lib/jsonc";
import {
  MCP_CONFIG_FILES,
  SKILL_DIRECTORIES,
  type DiscoveredAgentTools,
  type DiscoveredMcpServer,
  type DiscoveredSkill,
  type McpConfigFormat,
  type SearchedMcpConfigFile,
  type SkippedAgentTool,
} from "../domain/discovered-agent-tools";
import { normalizeMcpServer } from "../domain/normalize-mcp-server";

/**
 * Finds the MCP servers and skills a repository already defines for coding
 * agents, reading only files inside `repoRoot` (never the user's global
 * config).
 *
 * Servers come from {@link MCP_CONFIG_FILES} in precedence order; the first
 * file to define a name wins and later definitions are recorded as
 * `shadowed`. Each is normalized to OpenCode v2 by `normalizeMcpServer`.
 * Skills are found the way OpenCode 2.0.28 finds them (see
 * {@link discoverSkills}): a skill is listed under the id the agent loads it
 * by, and when two files share an id the one OpenCode uses wins.
 *
 * Never throws for repository content: an unreadable or unparseable file and
 * every unusable entry are listed in `skipped` with the reason.
 */
export async function discoverRepoAgentTools(
  repoRoot: string,
): Promise<DiscoveredAgentTools> {
  const skipped: SkippedAgentTool[] = [];
  const searched: SearchedMcpConfigFile[] = [];
  const servers = new Map<string, DiscoveredMcpServer>();

  for (const { file, format } of MCP_CONFIG_FILES) {
    const filePath = path.join(repoRoot, file);
    const content = await readOptionalFile(filePath);
    searched.push({ file, path: filePath, present: content !== null });
    if (content === null) continue;

    const entries = readServerEntries({ format, content });
    if (entries.kind === "error") {
      skipped.push({
        kind: "server",
        source: file,
        name: null,
        reason: entries.reason,
      });
      continue;
    }

    for (const [name, entry] of Object.entries(entries.entries)) {
      const normalized = normalizeMcpServer({
        format,
        entry,
        generation: entries.generation,
      });
      if (normalized.kind === "not-a-definition") continue;
      if (normalized.kind === "skipped") {
        skipped.push({
          kind: "server",
          source: file,
          name,
          reason: normalized.reason,
        });
        continue;
      }
      const existing = servers.get(name);
      if (existing !== undefined) {
        existing.shadowed.push({ source: file });
        continue;
      }
      servers.set(name, {
        name,
        source: file,
        transport: normalized.config.type,
        config: normalized.config,
        requiredEnv: normalized.requiredEnv,
        inlineSecrets: normalized.inlineSecrets,
        shadowed: [],
      });
    }
  }

  const skills = await discoverSkills(repoRoot, skipped);
  return { servers: [...servers.values()], skills, skipped, searched };
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") {
      return null;
    }
    throw error;
  }
}

type ServerEntries =
  | {
      kind: "entries";
      entries: Readonly<AnyJsonObject>;
      generation: "v1" | "v2";
    }
  | { kind: "error"; reason: string };

function asObject(value: AnyJsonValue | undefined): AnyJsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : null;
}

function entriesUnder(
  document: AnyJsonValue,
  key: string,
  generation: "v1" | "v2" = "v2",
): ServerEntries {
  const root = asObject(document);
  if (root === null) {
    return { kind: "error", reason: "parse error: not an object" };
  }
  const value = root[key];
  if (value === undefined) return { kind: "entries", entries: {}, generation };
  const entries = asObject(value);
  return entries !== null
    ? { kind: "entries", entries, generation }
    : { kind: "error", reason: `parse error: "${key}" is not an object` };
}

/** OpenCode's `mcp` key holds v2 `servers.<name>` or v1 `<name>` entries. */
function opencodeEntries(document: AnyJsonValue): ServerEntries {
  const mcp = entriesUnder(document, "mcp");
  if (mcp.kind === "error") return mcp;
  const servers = asObject(mcp.entries["servers"]);
  if (servers !== null && typeof servers["type"] !== "string") {
    return { kind: "entries", entries: servers, generation: "v2" };
  }
  return { kind: "entries", entries: mcp.entries, generation: "v1" };
}

function parseDocument(
  format: McpConfigFormat,
  content: string,
): { document: AnyJsonValue } | { reason: string } {
  let raw: ReturnType<typeof parseJsonc>;
  try {
    raw = format === "codex" ? Bun.TOML.parse(content) : parseJsonc(content);
  } catch (error) {
    return {
      reason: `parse error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const parsed = anyJsonValueSchema.safeParse(raw);
  return parsed.success
    ? { document: parsed.data }
    : { reason: "parse error: contains values that are not plain JSON" };
}

function readServerEntries(input: {
  format: McpConfigFormat;
  content: string;
}): ServerEntries {
  const parsed = parseDocument(input.format, input.content);
  if ("reason" in parsed) return { kind: "error", reason: parsed.reason };
  const { document } = parsed;
  switch (input.format) {
    case "opencode":
      return opencodeEntries(document);
    case "claude":
    case "cursor":
      return entriesUnder(document, "mcpServers");
    case "vscode":
      return entriesUnder(document, "servers");
    case "codex":
      return entriesUnder(document, "mcp_servers");
  }
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;

const frontmatterSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().trim().min(1),
  })
  .loose();

/** OpenCode 2.0.28's skill file pattern, relative to a skills directory. */
const SKILL_FILE_PATTERNS = ["*.md", "**/SKILL.md"] as const;

/**
 * Every skill file under `dir`, as `dir`-relative posix paths sorted the way
 * OpenCode sorts them (by absolute path, which shares the `dir` prefix).
 */
async function listSkillFiles(dir: string): Promise<string[]> {
  const files = new Set<string>();
  try {
    for (const pattern of SKILL_FILE_PATTERNS) {
      for await (const file of new Bun.Glob(pattern).scan({
        cwd: dir,
        dot: true,
        followSymlinks: true,
        onlyFiles: true,
      })) {
        files.add(file.split(path.sep).join("/"));
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
  return [...files].sort();
}

/**
 * The id OpenCode gives a skill file: the stem of a `<dir>/<name>.md`, the
 * parent directory's name for any `SKILL.md`.
 */
function skillId(skillsDir: string, relativeFile: string): string {
  const atRoot = !relativeFile.includes("/");
  if (atRoot && relativeFile !== "SKILL.md") {
    return path.posix.basename(relativeFile, ".md");
  }
  return path.posix.basename(
    path.posix.dirname(path.posix.join(skillsDir, relativeFile)),
  );
}

function readSkill(
  content: string,
): { description: string } | { reason: string } {
  const match = FRONTMATTER_PATTERN.exec(content);
  if (match === null) return { reason: "skill file has no frontmatter" };
  let frontmatter: ReturnType<typeof Bun.YAML.parse>;
  try {
    frontmatter = Bun.YAML.parse(match[1] ?? "");
  } catch (error) {
    return {
      reason: `parse error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const parsed = frontmatterSchema.safeParse(frontmatter);
  if (!parsed.success) {
    return { reason: "frontmatter has no description" };
  }
  return { description: parsed.data.description };
}

/**
 * Mirrors how OpenCode 2.0.28 loads skills, so the list matches what an agent
 * can actually load: files matching `{*.md,**\/SKILL.md}` in each of
 * {@link SKILL_DIRECTORIES}, named by path (see {@link skillId}), with a
 * later definition of an id replacing an earlier one.
 */
async function discoverSkills(
  repoRoot: string,
  skipped: SkippedAgentTool[],
): Promise<DiscoveredSkill[]> {
  const skills = new Map<string, DiscoveredSkill>();
  for (const skillsDir of SKILL_DIRECTORIES) {
    for (const file of await listSkillFiles(path.join(repoRoot, skillsDir))) {
      const relativePath = path.posix.join(skillsDir, file);
      const content = await readOptionalFile(path.join(repoRoot, relativePath));
      if (content === null) continue;

      const name = skillId(skillsDir, file);
      const skill = readSkill(content);
      if ("reason" in skill) {
        skipped.push({
          kind: "skill",
          source: relativePath,
          name,
          reason: skill.reason,
        });
        continue;
      }
      const existing = skills.get(name);
      const shadowed =
        existing === undefined
          ? []
          : [...existing.shadowed, { path: existing.path }];
      skills.delete(name);
      skills.set(name, {
        name,
        description: skill.description,
        path: relativePath,
        shadowed,
      });
    }
  }
  return [...skills.values()];
}
