import { z } from "zod";
import { defineStep } from "@boboddy/sdk/definitions/steps";
import { definePipeline, Rule } from "@boboddy/sdk/definitions/pipelines";

/**
 * Choice — one step feeds a routing node with a matched case (`critical`)
 * and a `default` fallback, each continuing to its own terminal `succeed`.
 * Authored with `definePipeline()` — the same builder real pipelines are
 * written with — rather than the compiled `PipelineDefinitionSpec` wire
 * shape it produces (see `linear-chain.ts`'s note). A `choice` state's
 * `choices[].when` is the routing source of truth; `definePipeline()`
 * derives the graph's edges from it.
 */

const classifySeverityStep = defineStep({
  key: "classify-step",
  name: "Classify severity",
  agentPrompt: "Classify the incident's severity.",
  result: z.object({ severity: z.string() }),
  signals: [{ sourcePath: "severity", key: "severity" }],
});

const pageOncallStep = defineStep({
  key: "page-oncall-step",
  name: "Page on-call",
  agentPrompt: "Page the on-call engineer about this incident.",
  result: z.object({ paged: z.boolean() }),
});

const fileTicketStep = defineStep({
  key: "file-ticket-step",
  name: "File a ticket",
  agentPrompt: "File a tracking ticket for this incident.",
  result: z.object({ ticketId: z.string() }),
});

export const choiceSpec = definePipeline({
  key: "catalog-choice",
  name: "Route an incident by severity",
  description: "Classifies an incident, then pages on-call or files a ticket.",
  startAt: "classify",
  states: {
    classify: { kind: "step", step: classifySeverityStep, next: "routeBySeverity" },
    routeBySeverity: {
      kind: "choice",
      choices: [
        { when: Rule.when("severity", "equal", "critical"), next: "pageOncall" },
      ],
      default: "fileTicket",
    },
    pageOncall: { kind: "step", step: pageOncallStep, next: "paged" },
    fileTicket: { kind: "step", step: fileTicketStep, next: "ticketed" },
    paged: { kind: "succeed" },
    ticketed: { kind: "succeed" },
  },
});
