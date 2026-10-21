import { describe, expect, test } from "bun:test";
import { buildPipelineDesignerPrompt } from "../src/lib/design-agent-assets";
import {
  expectNoPhrase,
  expectPhrase,
  PHASE,
  sectionBetween,
} from "./design-agent-prompt-helpers";

/**
 * How the pipeline-designer prompt handles the repository's own MCP servers
 * and skills: discovered in orientation, offered in the interview, and wired
 * into steps with health checks. Split from `design-agent-interview.test.ts`.
 */

describe("orientation discovers project tools before the interview asks about them", () => {
  // Phase 1 is "read first, never ask for something you can discover" — the
  // preflight's discovered-tools manifest records every MCP server and skill
  // the repository defines, with each server's listed tools. A step reaches
  // a server only through a `ref` (D12), so phase 3 asks which ones to use
  // and phase 6 asks which listed tool each health check calls (D14).
  const prompt = buildPipelineDesignerPrompt();
  const orient = sectionBetween(prompt, PHASE.orient, PHASE.goal);
  const reachability = sectionBetween(
    prompt,
    PHASE.reachability,
    PHASE.changeSize,
  );
  const build = sectionBetween(prompt, PHASE.build, PHASE.assignment);

  test("phase 1 reads the discovered-tools manifest, falling back to the config files", () => {
    expectPhrase(
      orient,
      "Read the discovered-tools manifest at the path the opening message names",
    );
    expectPhrase(
      orient,
      "If no manifest was written, read the repository's MCP config files",
    );
    expectPhrase(orient, "list `.opencode/tools/`");
  });

  test("phase 1 says a step reaches a server only through a defineMcp, never natively", () => {
    expectPhrase(
      orient,
      "A `workspace` step gets only the MCP servers it lists",
    );
    expectPhrase(
      orient,
      "a step reaches one with a `defineMcp` mounted under `mcps`",
    );
    expect(orient).not.toContain("loads natively");
    expect(orient).not.toContain("do not redeclare");
  });

  test("what phase 1 finds there is not re-asked about in phase 3", () => {
    expectPhrase(orient, "You do not ask the user whether any of these exist");
    expectPhrase(
      reachability,
      "Already defined as an MCP server in the repository? Say",
    );
  });

  test("phase 3 presents the servers and asks which the investigate step uses", () => {
    expectPhrase(
      reachability,
      "Show the repository's MCP servers from phase 1",
    );
    expectPhrase(
      reachability,
      "ask which of them the investigate step should use",
    );
    expectPhrase(reachability, "`unavailable` (name the missing env var");
  });

  test("phase 6 asks per chosen server which listed tool its health check calls, and with what args", () => {
    expectPhrase(
      build,
      "**Every server the user picked in phase 3 gets a health check**",
    );
    expectPhrase(build, "`readOnlyHint: true` first");
    expectPhrase(build, "ask what arguments to call it with");
  });

  test("phase 6 gives every step mounting a server its check, required or warn by dependence, plus cli checks", () => {
    expectPhrase(
      build,
      "Define each server once per file and mount it on every step that uses it",
    );
    expectPhrase(build, "every such step gets that server's check");
    expectPhrase(
      build,
      "Keep its checks `required` when the step cannot do its job",
    );
    expectPhrase(build, "set its checks to `warn` when it only helps");
    expectPhrase(build, "never by copying the server");
    expectPhrase(
      build,
      "the Playwright CLI on the step that drives the browser",
    );
    expectPhrase(
      build,
      "the test runner on every step that writes or runs tests",
    );
    expectPhrase(build, "`npx --no-install`");
  });

  test("mcps in the authoring reference says a step gets only the servers it lists", () => {
    expectPhrase(prompt, "A step gets **only** the servers it lists in `mcps`");
    expectPhrase(
      prompt,
      "`defineMcp` is the only way to give a step an MCP server or an MCP health check",
    );
    expectNoPhrase(prompt, "mcpServers");
    expectPhrase(
      prompt,
      "**Define each server once per file, and override it per step.**",
    );
    expectPhrase(
      prompt,
      "against the repository only — never the user's global OpenCode config",
    );
  });
});
