import { renderPromptTemplate } from "@boboddy/sdk/definitions/steps";
import type { AnyJsonValue } from "../../../common/contracts/json";

/** The longest commit subject the worker will hand to git. */
export const MAX_COMMIT_SUBJECT_LENGTH = 200;

export function defaultCommitMessage(stepExecutionId: string): string {
  return `boboddy: step ${stepExecutionId}`;
}

/**
 * Render a `readWrite` step's commit message. The template (`{{input.…}}` and
 * `{{result.…}}` tokens) is rendered against the step's additional input and
 * the findings the agent submitted. The rendered text carries agent output, so
 * it is reduced to a safe single-line subject: whitespace runs collapse to one
 * space, remaining control characters (NUL included, which Node rejects in an
 * argv entry) are stripped, and the subject is cut to
 * {@link MAX_COMMIT_SUBJECT_LENGTH} characters. A `null` template, or one that
 * renders to nothing, yields {@link defaultCommitMessage}, since git aborts on
 * an empty message.
 */
export function renderCommitMessage(input: {
  template: string | null;
  stepExecutionId: string;
  inputJson: unknown;
  result: AnyJsonValue;
}): string {
  const fallback = defaultCommitMessage(input.stepExecutionId);
  if (input.template === null) return fallback;

  const rendered = renderPromptTemplate(input.template, {
    input: input.inputJson,
    result: input.result,
  });
  const singleLine = rendered
    .replace(/\s+/gu, " ")
    .replace(/[\p{Cc}\u2028\u2029]/gu, "")
    .trim();
  const subject = Array.from(singleLine)
    .slice(0, MAX_COMMIT_SUBJECT_LENGTH)
    .join("")
    .trim();
  return subject === "" ? fallback : subject;
}
