import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { discoverRepoAgentTools } from "../../../../src/project/agent-tools/infra/discover-repo-agent-tools";

/**
 * Skill discovery must agree with OpenCode 2.0.28 on which skills exist and
 * what they are called: the designer offers the user exactly these.
 */
describe("discoverRepoAgentTools: skills, as OpenCode 2.0.28 loads them", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), "agent-skills-"));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  async function write(file: string, content: string) {
    const filePath = path.join(repo, file);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }

  const skill = (description: string) =>
    `---\nname: from-frontmatter\ndescription: ${description}\n---\n`;

  test("a skill is named by its path, never its frontmatter name", async () => {
    await write(".claude/skills/review/SKILL.md", skill("dir"));
    await write(".claude/skills/commit.md", skill("root file"));
    await write(".agents/skills/group/nested/SKILL.md", skill("nested"));
    await write(".agents/skills/group/notes.md", skill("ignored"));

    const tools = await discoverRepoAgentTools(repo);
    expect(
      tools.skills.map(({ name, path: file }) => ({ name, path: file })),
    ).toEqual([
      { name: "commit", path: ".claude/skills/commit.md" },
      { name: "review", path: ".claude/skills/review/SKILL.md" },
      { name: "nested", path: ".agents/skills/group/nested/SKILL.md" },
    ]);
  });

  test("a later source wins: .claude < .agents < .opencode/skill < .opencode/skills", async () => {
    await write(".claude/skills/triage/SKILL.md", skill("claude"));
    await write(".agents/skills/triage.md", skill("agents"));
    await write(".opencode/skill/triage/SKILL.md", skill("opencode skill"));
    await write(".opencode/skills/triage/SKILL.md", skill("opencode skills"));

    const tools = await discoverRepoAgentTools(repo);
    expect(tools.skills).toEqual([
      {
        name: "triage",
        description: "opencode skills",
        path: ".opencode/skills/triage/SKILL.md",
        shadowed: [
          { path: ".claude/skills/triage/SKILL.md" },
          { path: ".agents/skills/triage.md" },
          { path: ".opencode/skill/triage/SKILL.md" },
        ],
      },
    ]);
  });
});
