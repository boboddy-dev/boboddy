import { z } from "zod";
import { defineStep } from "@boboddy/sdk/definitions/steps";
import { definePipeline } from "@boboddy/sdk/definitions/pipelines";

/**
 * Linear chain — three sequential steps then a terminal `succeed`. The
 * simplest shape a pipeline graph can take: no branching, no fan-out, no
 * loop. Authored with `definePipeline()` — the same builder real pipelines
 * are written with (see `docs/research/flat-pipeline-sdk-and-visual-designer.md`
 * §4) — rather than the compiled `PipelineDefinitionSpec` wire shape it
 * produces. The steps below are illustrative stand-ins, never pushed or
 * executed (see `docs/research/pipeline-graph-docs-catalog.md` §7).
 */

const readReportStep = defineStep({
  key: "intake-step",
  name: "Read report",
  agentPrompt: "Read the incoming bug report and extract its key details.",
  result: z.object({ reportText: z.string() }),
});

const analyzeSeverityStep = defineStep({
  key: "analyze-step",
  name: "Analyze severity",
  agentPrompt: "Analyze how severe the bug report is.",
  result: z.object({ severity: z.string() }),
});

const writeSummaryStep = defineStep({
  key: "summarize-step",
  name: "Write summary",
  agentPrompt: "Write a short summary of the triage outcome.",
  result: z.object({ summary: z.string() }),
});

export const linearChainSpec = definePipeline({
  key: "catalog-linear-chain",
  name: "Triage a bug report",
  description: "Reads the report, analyzes its severity, and writes a summary.",
  startAt: "intake",
  states: {
    intake: { kind: "step", step: readReportStep, next: "analyze" },
    analyze: { kind: "step", step: analyzeSeverityStep, next: "summarize" },
    summarize: { kind: "step", step: writeSummaryStep, next: "done" },
    done: { kind: "succeed" },
  },
});
