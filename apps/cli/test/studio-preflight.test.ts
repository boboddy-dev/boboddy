import { describe, expect, test } from "bun:test";
import {
  MISSING_DEPENDENCIES_MESSAGE,
  runStudioPreflight,
  type StudioPreflightPorts,
} from "../src/lib/studio-preflight";
import { noopBaseReporter } from "../src/lib/reporter-types";
import { createReporterRecorder, reportedMessages } from "./utils";

type Calls = {
  scaffoldBuilderDir: number;
};

function createPorts(overrides: Partial<StudioPreflightPorts> = {}): {
  ports: StudioPreflightPorts;
  calls: Calls;
} {
  const calls: Calls = { scaffoldBuilderDir: 0 };

  const base: StudioPreflightPorts = {
    builderDirExists: () => true,
    scaffoldBuilderDir: () => {
      calls.scaffoldBuilderDir += 1;
    },
    dependenciesInstalled: () => true,
  };

  return { ports: { ...base, ...overrides }, calls };
}

describe("runStudioPreflight", () => {
  test("does nothing when the directory exists and deps are installed", () => {
    const { ports, calls } = createPorts();

    expect(() => {
      runStudioPreflight({ reporter: noopBaseReporter, ports });
    }).not.toThrow();
    expect(calls.scaffoldBuilderDir).toBe(0);
  });

  test("scaffolds the builder directory when missing", () => {
    const { ports, calls } = createPorts({ builderDirExists: () => false });

    runStudioPreflight({ reporter: noopBaseReporter, ports });

    expect(calls.scaffoldBuilderDir).toBe(1);
  });

  test("does not scaffold when the directory already exists", () => {
    const { ports, calls } = createPorts({ builderDirExists: () => true });

    runStudioPreflight({ reporter: noopBaseReporter, ports });

    expect(calls.scaffoldBuilderDir).toBe(0);
  });

  test("throws — rather than installing on the user's behalf — when deps are missing", () => {
    const { ports, calls } = createPorts({ dependenciesInstalled: () => false });

    expect(() => {
      runStudioPreflight({ reporter: noopBaseReporter, ports });
    }).toThrow(MISSING_DEPENDENCIES_MESSAGE);
    // The read-only command never runs an installer itself.
    expect(calls.scaffoldBuilderDir).toBe(0);
  });

  test("reports success for each satisfied step", () => {
    const { reporter, calls: reported } = createReporterRecorder();
    const { ports } = createPorts();

    runStudioPreflight({ reporter, ports });

    expect(reportedMessages(reported)).toContain(
      "Pipeline builder directory ready",
    );
  });

  test("reports the scaffold, not the ready message, when it had to create the directory", () => {
    const { reporter, calls: reported } = createReporterRecorder();
    const { ports } = createPorts({ builderDirExists: () => false });

    runStudioPreflight({ reporter, ports });

    const messages = reportedMessages(reported);
    expect(messages).toContain("Scaffolded the pipeline builder directory");
    expect(messages).not.toContain("Pipeline builder directory ready");
  });
});
