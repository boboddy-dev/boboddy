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
    "## 7. The default pipeline",
    "#### `bug-pipeline.ts`",
    "## 8. Writing a good `agentPrompt`",
    "## 9. Validate, then push",
    "bun run typecheck",
    '"$BOBODDY_CLI" pipelines push',
    "`sourcePath` is NOT type-checked",
  ])("authoring section present: %s", (needle) => {
    expect(prompt).toContain(needle);
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
    expectPhrase(prompt, 'see "Secrets" in phase 6');
    expect(PHASE_HEADINGS[6]).toBe(PHASE.build);
    expectPhrase(prompt, "writing one is phase 5");
    expect(PHASE_HEADINGS[5]).toBe(PHASE.devcontainer);
  });

  test("the devcontainer phase is reached before anything is authored", () => {
    // Ordering is the requirement, not just presence: a pipeline is worthless in
    // a repo whose steps have no container to run in, and the agent finishes the
    // session at the push. Authoring the devcontainer after that never happens.
    expect(prompt.indexOf(PHASE.devcontainer)).toBeGreaterThan(
      prompt.indexOf(PHASE.changeSize),
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

  test("the goal question proposes the default deliverable (D3)", () => {
    const goal = sectionBetween(prompt, PHASE.goal, PHASE.reachability);
    expectPhrase(
      goal,
      "an investigation report and a Playwright trace that reproduces the bug; when the reproduction is confident, a failing test and a proposed fix waiting for your approval",
    );
  });

  test("the goal question is the overnight question, asked on its own", () => {
    // A session once folded it into the orientation summary as "is that what
    // you want, or something else?", so the user never saw the question.
    const goal = sectionBetween(prompt, PHASE.goal, PHASE.reachability);
    expectPhrase(goal, "it is the only question in that message");
    expectPhrase(goal, "landed overnight and an agent picked it up");
    expectPhrase(goal, "What do you want waiting for you in the morning?");
    expectPhrase(goal, "Never fold it into the orientation summary");
  });

  test("the goal question offers tailored suggestions, the default first", () => {
    const goal = sectionBetween(prompt, PHASE.goal, PHASE.reachability);
    expectPhrase(goal, "Give two to four suggestions, tailored to this item");
    expectPhrase(goal, "The first is always the default pipeline's deliverable");
    expectPhrase(goal, "Pick one, mix them, or tell me something else.");
  });

  test("orientation is summarised briefly so the goal question stands out", () => {
    const orient = sectionBetween(prompt, PHASE.orient, PHASE.goal);
    expectPhrase(orient, "in **one or two lines**");
    expectPhrase(orient, "wait for phase 3");
  });

  test("the item frames the interview but the pipeline stays generic", () => {
    // A session once wrote "billing-onboarding-bug" with every prompt about the
    // seeded ticket's feature, unusable for the next bug that arrived.
    expectPhrase(
      prompt,
      "The item frames the interview; it does not define the pipeline.",
    );
    expectPhrase(prompt, "never after this ticket's feature, customer, or symptom");
    expectPhrase(prompt, "Never paste this ticket's feature names");
    expectPhrase(prompt, "turn it into the general rule");
    const build = sectionBetween(prompt, PHASE.build, PHASE.assignment);
    expectPhrase(build, "against an imagined, unrelated item of the same kind");
    expectPhrase(prompt, "**Keep it generic.**");
  });

  test("the reachability probe is phrased through the item", () => {
    expectPhrase(prompt, "To reproduce this one, is there a running instance");
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
    PHASE.devcontainer,
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

describe("the interview configures the default pipeline rather than choosing one", () => {
  const prompt = buildPipelineDesignerPrompt();
  const reachability = sectionBetween(
    prompt,
    PHASE.reachability,
    PHASE.changeSize,
  );
  const build = sectionBetween(prompt, PHASE.build, PHASE.assignment);

  test("phase 3 asks only about reach, tools, and what must never be touched", () => {
    expect(reachability).toContain("You need three things, and nothing else");
    expect(reachability).toContain("**a. What the agent can reach.**");
    expect(reachability).toContain("**b. Which discovered tools to use.**");
    expect(reachability).toContain("**c. What must never be touched.**");
    expect(reachability.match(/^\*\*[a-z]\. /gmu)?.length).toBe(3);
    // The old phase 3 also asked how representative the item was.
    expectNoPhrase(reachability, "How representative this item is");
  });

  test("reachability configures investigateAndReproduce, not a pipeline shape", () => {
    expectPhrase(
      reachability,
      "this phase only decides how its `investigateAndReproduce` step is configured",
    );
    expectPhrase(build, "Keep the shape unless the user asks for a different one");
  });

  test("no reachable app means no trace, said out loud", () => {
    expectPhrase(
      reachability,
      "there is no trace, and the report and the failing test carry the evidence",
    );
    expectPhrase(
      build,
      "With no reachable app it gets no browser and writes no trace",
    );
  });

  test("ranked options and the archetype catalog are gone", () => {
    expectNoPhrase(prompt, "ranked options");
    expectNoPhrase(prompt, "archetype");
  });

  test("only the default pipeline's two stops, no other gates", () => {
    expectNoPhrase(build, "Gate on `block`");
    expectNoPhrase(build, "define what confidence means");
    expectPhrase(build, "`proposeFix` blocks until a human approves");
    expectPhrase(
      build,
      "add no other `blockWhen` gates unless they ask for one",
    );
  });

  test("the scaffolded starter is edited in place, not copied beside itself", () => {
    expectPhrase(build, "edit that file in place, never a second copy beside it");
    expectPhrase(build, "it is the step everything else depends on");
  });
});

describe("secrets are named, never asked for or written as values", () => {
  const prompt = buildPipelineDesignerPrompt();
  const build = sectionBetween(prompt, PHASE.build, PHASE.assignment);
  const close = sectionBetween(prompt, PHASE.close, "# How to behave");

  test("phase 6 tells the agent to ask for the variable name, never the value", () => {
    expectPhrase(build, "Secrets are a fact you never ask for directly");
    expectPhrase(build, "never the value itself");
  });

  test("phase 6 routes new secrets into .boboddy/.env.example, never .env", () => {
    expectPhrase(build, "Add `VAR=` to `.boboddy/.env.example`");
    expectPhrase(build, "never write to `.boboddy/.env` itself");
  });

  test("phase 9 tells the user by name that .env needs real values", () => {
    expectPhrase(close, "name every variable in");
    expectPhrase(close, "fill in the real values themselves");
  });

  test("the authoring reference repeats the same rule for a step's MCP servers", () => {
    expectPhrase(prompt, "Never write a secret **value** into a step file");
    expectPhrase(
      prompt,
      "`.boboddy/.env` itself is never a file you create or edit",
    );
  });
});
