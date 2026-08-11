import { describe, expect, test } from "bun:test";
import { buildPipelineDesignerPrompt } from "../src/lib/design-agent-assets";
import {
  expectNoPhrase,
  expectPhrase,
  PHASE,
  PHASE_HEADINGS,
  sectionBetween,
} from "./design-agent-prompt-helpers";

/**
 * What the pipeline-designer prompt actually *says*: the phase order, the
 * interview's anchoring to the seeded work item, the change-size gate, the
 * devcontainer-authoring phase, and the promises the assignment phase makes.
 *
 * Its sibling `design-agent-assets.test.ts` covers the same prompt as an
 * artifact — inlining, fences, size, and the committed snapshot.
 */

describe("composed prompt covers the required sections", () => {
  const prompt = buildPipelineDesignerPrompt();

  test.each([
    // Interview / behaviour, from AGENT_PROMPT.md
    ...Object.values(PHASE),
    "One question at a time",
    "default-pipeline-assignment.ts",
    "typecheck and push successfully",
  ])("agent-prompt section present: %s", (needle) => {
    expect(prompt).toContain(needle);
  });

  test("reachability still normalises the repo-only answer", () => {
    expectPhrase(
      prompt,
      '"Nothing but the repository" is a completely normal answer',
    );
  });

  test.each([
    // Authoring reference, from AUTHORING.md
    "## 7. Archetype catalog",
    "A. Browser / deployed-app reproduction",
    "B. Code-level failing-test reproduction",
    "C. Read-only data / state investigation",
    "D. Triage / intake quality scoring",
    "E. Router → other pipelines",
    "## 8. Writing a good `agentPrompt`",
    "## 9. Validate, then push",
    "bun run typecheck",
    '"$BOBODDY_CLI" pipelines push',
    "`sourcePath` is NOT type-checked",
  ])("authoring section present: %s", (needle) => {
    expect(prompt).toContain(needle);
  });

  test("the devcontainer phase is reached before anything is authored", () => {
    // Ordering is the requirement, not just presence: a pipeline is worthless in
    // a repo whose steps have no container to run in, and the agent finishes the
    // session at the push. Authoring the devcontainer after that never happens.
    expect(prompt.indexOf(PHASE.devcontainer)).toBeGreaterThan(
      prompt.indexOf(PHASE.proposals),
    );
    expect(prompt.indexOf(PHASE.devcontainer)).toBeLessThan(
      prompt.indexOf(PHASE.build),
    );
  });

  test("every phase cross-reference points at the phase it means", () => {
    // Inserting a phase renumbers every heading after it, and the prompt refers
    // to phases by number in both directions. The headings and the forward refs
    // are easy to spot; a backward ref buried mid-sentence is not, and a stale
    // one sends the agent to the wrong instruction with total confidence.
    for (const reference of prompt.matchAll(/phase (\d+)/gu)) {
      const phase = Number(reference[1]);
      expect(
        prompt,
        `prompt refers to "phase ${String(phase)}", which has no heading`,
      ).toContain(PHASE_HEADINGS[phase] ?? `## ${String(phase)}. `);
    }

    // The two that carry real meaning, pinned by what the phase is called rather
    // than by its number.
    expectPhrase(prompt, "you need real field names in phase 8");
    expect(PHASE_HEADINGS[8]).toBe(PHASE.assignment);
    expectPhrase(prompt, "writing one is phase 6");
    expect(PHASE_HEADINGS[6]).toBe(PHASE.devcontainer);
  });

  test("the devcontainer phase is reached before anything is authored", () => {
    // Ordering is the requirement, not just presence: a pipeline is worthless in
    // a repo whose steps have no container to run in, and the agent finishes the
    // session at the push. Authoring the devcontainer after that never happens.
    expect(prompt.indexOf(PHASE.devcontainer)).toBeGreaterThan(
      prompt.indexOf(PHASE.proposals),
    );
    expect(prompt.indexOf(PHASE.devcontainer)).toBeLessThan(
      prompt.indexOf(PHASE.build),
    );
  });

  test("the orient phase points at the repository, not a persisted analysis", () => {
    // `boboddy init` used to write `.boboddy/repo-analysis.json` for this agent
    // to read. Nothing writes it any more, so an instruction to read it would
    // send the agent after a file that never exists. The snapshot alone would
    // not catch a re-add — regenerating it accepts whatever the prompt says.
    expect(prompt).not.toContain("repo-analysis");
    expect(prompt).toContain("Look at the repository root");
  });
});

describe("the interview is anchored to the seeded work item", () => {
  // The preflight guarantees a real work item reaches the agent in the seed
  // prompt, so the interview is conducted through that item rather than in the
  // abstract. These assertions are the only thing keeping the prompt in step
  // with that guarantee: the snapshot accepts whatever the prompt says.
  const prompt = buildPipelineDesignerPrompt();

  test("the session opens on the goal question", () => {
    expectPhrase(
      prompt,
      "what should come out the other end when a ticket like this one arrives",
    );
  });

  test("the goal question is asked conversationally, with follow-ups", () => {
    const goal = sectionBetween(prompt, PHASE.goal, PHASE.reachability);
    expect(goal).toContain("one question");
    // Follow-ups, not a single question and done.
    expect(goal.match(/^- /gm)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  test("the reachability probe is phrased through the item", () => {
    expectPhrase(
      prompt,
      "To make progress on this ticket yourself, what's the first thing you'd do",
    );
  });

  test("the no-touch probe is phrased through the item", () => {
    const noTouch = sectionBetween(
      prompt,
      "**c. What must never be touched.**",
      PHASE.changeSize,
    );
    expectPhrase(noTouch, "Ask it about this item");
  });

  test("there is no item-less fallback path", () => {
    // The old abstract opening asked what kinds of items land here and for a
    // real recent example. Both are answered by the seeded item now, and
    // keeping either would re-open the path this ticket deletes.
    expectNoPhrase(prompt, "What kinds of work items land here");
    expectNoPhrase(prompt, "Ask for a real recent example");
    expectPhrase(prompt, "Every session starts with a work item");
  });

  test("one change per session is guidance, not a prohibition", () => {
    expectPhrase(prompt, "one confirmed change per session");
    expectPhrase(prompt, "guidance, not a prohibition");
    // The old wording forbade a second pipeline outright.
    expectNoPhrase(prompt, "name them, do not build them");
  });
});

describe("edit sessions gate file edits behind a confirmed verdict", () => {
  const gate = sectionBetween(
    buildPipelineDesignerPrompt(),
    PHASE.changeSize,
    PHASE.proposals,
  );

  test.each(["**tweak**", "**route**", "**new pipeline**"])(
    "names the verdict: %s",
    (needle) => {
      expect(gate).toContain(needle);
    },
  );

  test("the gate precedes any file edit and requires confirmation", () => {
    expectPhrase(gate, "Before you edit, create, or delete a single file");
    expectPhrase(gate, "get an explicit yes");
  });

  test("states the preference order and when to escalate", () => {
    expectPhrase(gate, "tweak > route > new pipeline");
    expectPhrase(
      gate,
      "Escalate only when the cheaper change cannot express the difference",
    );
  });

  test("states the anti-duplication rule", () => {
    expect(gate).toContain("Anti-duplication rule");
    expectPhrase(gate, "more than half its steps");
  });

  test("greenfield sessions skip the gate rather than inventing a verdict", () => {
    expect(gate).toContain("greenfield");
  });
});

describe("the devcontainer phase is write-only", () => {
  // A repo without a devcontainer used to be blocked at `boboddy init`. It is
  // now the agent's job, mid-session — but authoring is all it is. Building the
  // image is minutes of silence in the middle of an interview, and the first
  // pipeline run verifies it for real, so no build may be attempted here.
  const devcontainer = sectionBetween(
    buildPipelineDesignerPrompt(),
    PHASE.devcontainer,
    PHASE.build,
  );

  test("only fires when the repository has none", () => {
    expectPhrase(
      devcontainer,
      "Skip this phase if phase 1 found a devcontainer",
    );
  });

  test("attempts no build, by any of the routes available to it", () => {
    // `bash` is `ask`, so a build attempt would surface as an approval prompt
    // rather than run — but the prompt is what stops it being tried at all.
    expectPhrase(devcontainer, "**Do not build it.**");
    for (const command of [
      "devcontainer build",
      "devcontainer up",
      "docker build",
      "docker compose up",
    ]) {
      expect(devcontainer).toContain(command);
    }
    expectPhrase(
      devcontainer,
      "the first pipeline run is what verifies the image",
    );
  });

  test("says out loud that what it wrote is unverified", () => {
    // The user is being handed an unbuilt config. Presenting it as done would
    // make the first pipeline run look like a pipeline bug.
    expectPhrase(devcontainer, "unverified until that first run");
  });

  test("names the one path it may write, and that it has no more", () => {
    expect(devcontainer).toContain(".devcontainer/devcontainer.json");
    expectPhrase(
      devcontainer,
      "the only thing outside this one you are permitted to write",
    );
    expectPhrase(devcontainer, "no other repository-root write access");
  });

  test("bases the config on the orientation it already performed", () => {
    // The whole reason this belongs to the agent rather than a template: it has
    // already read the repo, so it should not be interviewing about the stack.
    expectPhrase(devcontainer, "Base it on what you already read in phase 1");
    expect(devcontainer).toContain("docker-compose.yml");
    expect(devcontainer).toContain("onCreateCommand");
  });

  test("does not install OpenCode into the container", () => {
    // Boboddy mounts its own pinned runtime; installing another one is wasted
    // image layers and a version mismatch waiting to happen.
    expectPhrase(devcontainer, "Do not install OpenCode");
  });

  test("is narrated rather than done silently", () => {
    expectPhrase(devcontainer, "Tell the user what you are doing");
    expectPhrase(devcontainer, "Show the user the config you wrote");
  });

  test("yields to a user who already knows what they want", () => {
    expectPhrase(devcontainer, "take their answer over yours");
  });
});

describe("the assignment phase tells the truth about when it fires", () => {
  // `POST /api/work-items` — the endpoint the design preflight creates the
  // seeded item through — does not evaluate the default assignment
  // (`create-work-item.ts` never calls `maybeAssignDefaultPipelines`; only the
  // upsert path does). A prompt that promises the seeded item is about to move
  // sends the user to watch a dashboard where nothing happens.
  const assignment = sectionBetween(
    buildPipelineDesignerPrompt(),
    PHASE.build,
    "# How to behave",
  );

  test("does not claim pushing starts a run for the seeded item", () => {
    expectPhrase(assignment, "the assignment will never pick it up");
    expectNoPhrase(assignment, "starts the pipeline on its own");
  });

  test("points at the paths that do start a run today", () => {
    // The command's own post-session offer is the main one, and it is gated on a
    // devcontainer and a pushed assignment — so the fallback has to be named too
    // or the agent sends half its users at a prompt they will never see.
    expectPhrase(assignment, "`design` offers to run this pipeline on the");
    expectPhrase(assignment, "executions drawer");
    expectPhrase(assignment, "run `boboddy work`");
  });

  test("a confirmed tweak does not also mandate rewriting the assignment", () => {
    // Phase 4 defines `route` as the escalation from `tweak`, so an
    // unconditional "update the assignment" here would contradict a confirmed
    // tweak — the agent would edit the file it was just told to leave alone.
    expectPhrase(assignment, "If the confirmed verdict was a **tweak**");
    expectPhrase(assignment, "leave the file alone");
  });
});

describe("orientation discovers project tools before the interview asks about them", () => {
  // Phase 1 is "read first, never ask for something you can discover" — a
  // project's own `.opencode/opencode.json[c]` and `.opencode/tools/` are
  // exactly that kind of discoverable fact, and every MCP server or tool
  // declared there is already reachable for every workspace step without the
  // designer redeclaring it.
  const prompt = buildPipelineDesignerPrompt();
  const orient = sectionBetween(prompt, PHASE.orient, PHASE.goal);

  test("phase 1 reads the project's own opencode config and tools", () => {
    expectPhrase(orient, "Read `.opencode/opencode.json` or");
    expectPhrase(orient, "list `.opencode/tools/`");
  });

  test("what phase 1 finds there is not re-asked about in phase 3", () => {
    expectPhrase(
      orient,
      "you do not ask the user whether it exists",
    );
    const reachability = sectionBetween(prompt, PHASE.reachability, PHASE.changeSize);
    expectPhrase(
      reachability,
      "Already declared in `.opencode/opencode.json[c]` or `.opencode/tools/`? Say",
    );
  });

  test("mcpServers in the authoring reference points back at the same discovery", () => {
    expectPhrase(
      prompt,
      "per-step MCP servers **beyond what the project already configures**",
    );
  });
});

describe("reachability is elicited as the user's own step-by-step process", () => {
  const reachability = sectionBetween(
    buildPipelineDesignerPrompt(),
    PHASE.reachability,
    PHASE.changeSize,
  );

  test("asks for an ordered walkthrough naming a tool per step, not a checklist", () => {
    expectPhrase(reachability, "Get it as their **step-by-step process**");
    expectPhrase(reachability, "what tool would you use for it");
  });

  test("keeps the concrete-category fallback for items with nothing to walk through", () => {
    expectPhrase(
      reachability,
      'the item has no real "how would I do this"',
    );
    // The original menu survives as a fallback, not the primary ask.
    expectPhrase(reachability, "A read-only database, warehouse, or read replica?");
  });
});

describe("secrets are named, never asked for or written as values", () => {
  const prompt = buildPipelineDesignerPrompt();
  const build = sectionBetween(prompt, PHASE.build, PHASE.assignment);
  const close = sectionBetween(prompt, PHASE.close, "# How to behave");

  test("phase 7 tells the agent to ask for the variable name, never the value", () => {
    expectPhrase(
      build,
      "Secrets are a fact you never ask for directly",
    );
    expectPhrase(build, "never the value itself");
  });

  test("phase 7 routes new secrets into .boboddy/.env.example, never .env", () => {
    expectPhrase(build, "Add `VAR=` to `.boboddy/.env.example`");
    expectPhrase(build, "never write to `.boboddy/.env` itself");
  });

  test("phase 10 tells the user by name that .env needs real values", () => {
    expectPhrase(
      close,
      "name every variable in",
    );
    expectPhrase(close, "fill in the real values themselves");
  });

  test("the authoring reference repeats the same rule for a step's mcpServers", () => {
    expectPhrase(
      prompt,
      "Never write a secret **value** into a step file",
    );
    expectPhrase(
      prompt,
      "`.boboddy/.env` itself is never a file you create or edit",
    );
  });
});
