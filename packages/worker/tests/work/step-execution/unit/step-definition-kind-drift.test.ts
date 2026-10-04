/**
 * The worker does not depend on `@boboddy/core`, so its `StepDefinitionKind`
 * union cannot be derived from `stepDefinitionKindValues`. The SDK's generated
 * API types are produced from the server's `z.enum(stepDefinitionKindValues)`,
 * so pinning the worker union to them fails typecheck if either side drifts.
 */
import { describe, expect, test } from "bun:test";
import type { PostApiStepExecutionsByStepExecutionIdWorkerContextResponses } from "@boboddy/sdk";
import type { StepDefinitionKind } from "../../../../src/work/step-execution/contracts/step-execution-contracts";

type ServerStepDefinitionKind =
  PostApiStepExecutionsByStepExecutionIdWorkerContextResponses[200]["stepDefinition"]["kind"];

type MutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;

const kindsMatch: MutuallyAssignable<
  StepDefinitionKind,
  ServerStepDefinitionKind
> = true;

describe("StepDefinitionKind", () => {
  test("matches the server's step definition kinds", () => {
    expect(kindsMatch).toBe(true);
  });
});
