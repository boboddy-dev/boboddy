import { describe, expect } from "bun:test";
import { buildDesignerHandoffPorts } from "../src/commands/init";
import { concurrentTest as test } from "./utils";

/**
 * `init`'s handoff into the designer used to discard any work item resolved
 * upstream by hardcoding `workItemId: undefined`. This pins the fix: the
 * ports' `launchDesign` must carry `--work-item-id` (and `--base-url`)
 * straight through to `runPipelineDesign`, unchanged.
 */

describe("buildDesignerHandoffPorts", () => {
  test("carries the work item id through to the designer launch", async () => {
    let seen:
      | {
          projectId: string | undefined;
          baseUrl: string | undefined;
          workItemId: string | undefined;
        }
      | undefined;

    const ports = buildDesignerHandoffPorts({
      baseUrl: "https://app.example.com",
      workItemId: "0197f000-0000-7000-8000-000000000001",
      confirmLaunch: () => Promise.resolve(true),
      launchDesign: (args) => {
        seen = args;
        return Promise.resolve();
      },
    });

    await ports.launchDesign();

    expect(seen).toEqual({
      projectId: undefined,
      baseUrl: "https://app.example.com",
      workItemId: "0197f000-0000-7000-8000-000000000001",
    });
  });

  test("passes undefined through when init resolved no work item", async () => {
    let seenWorkItemId: string | undefined = "not-yet-set";

    const ports = buildDesignerHandoffPorts({
      baseUrl: undefined,
      workItemId: undefined,
      confirmLaunch: () => Promise.resolve(true),
      launchDesign: (args) => {
        seenWorkItemId = args.workItemId;
        return Promise.resolve();
      },
    });

    await ports.launchDesign();

    expect(seenWorkItemId).toBeUndefined();
  });

  test("delegates confirmLaunch unchanged", async () => {
    const ports = buildDesignerHandoffPorts({
      baseUrl: undefined,
      workItemId: undefined,
      confirmLaunch: () => Promise.resolve(false),
      launchDesign: () => Promise.resolve(),
    });

    expect(await ports.confirmLaunch()).toBe(false);
  });
});
