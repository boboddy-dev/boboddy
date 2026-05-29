import { z } from "zod";
import type { ZodObject, ZodRawShape } from "zod";

// ─── Core types ───────────────────────────────────────────────────────────────

type FeatureSignalSpec = {
  key: string;
  sourcePath: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  required?: boolean;
  availableWhenResultStatusIn?: string[] | null;
};

export type StepFeature<
  TResultExtension extends Record<string, unknown> = Record<string, unknown>,
  TSignalKeys extends string = string,
> = {
  readonly _resultExtension: ZodObject<ZodRawShape>;
  readonly _promptAddition: string;
  readonly _signals: FeatureSignalSpec[];
  readonly __resultExtension?: TResultExtension; // phantom
  readonly __signalKeys?: TSignalKeys; // phantom
};

export type AnyStepFeature = StepFeature<Record<string, unknown>, string>;

type UnionToIntersection<U> = (
  U extends unknown ? (x: U) => void : never
) extends (x: infer I) => void
  ? I
  : never;

// Merges result extension types from all features into a single intersection.
export type FeatureResultExtensions<
  TFeatures extends readonly AnyStepFeature[],
> = [TFeatures[number]] extends [never]
  ? Record<never, never>
  : UnionToIntersection<
      TFeatures[number] extends StepFeature<infer R, string> ? R : never
    >;

// Unions all signal keys contributed by features.
// Uses phantom field access instead of infer to avoid disrupting const-literal inference
// for sibling generics (a TypeScript inference quirk with distributive infer in return types).
export type FeatureSignalKeys<TFeatures extends readonly AnyStepFeature[]> =
  NonNullable<TFeatures[number]["__signalKeys"]>;

// ─── Built-in: feedbackRequests ───────────────────────────────────────────────

export type FeedbackRequestUrgency =
  | "blocking"
  | "clarification"
  | "assumption"
  | "informational";

export type FeedbackRequestItem = {
  question: string;
  category: string;
  urgency: FeedbackRequestUrgency;
  suggestedKey?: string;
};

const FEEDBACK_REQUEST_SIGNAL_KEY = "$boboddy_feedback_request_v1" as const;
const FEEDBACK_REQUEST_RESULT_KEY = "$boboddy_feedbackRequests_v1" as const;

const feedbackRequestItemSchema = z
  .object({
    question: z
      .string()
      .describe("The specific question to pose to a human reviewer."),
    category: z
      .string()
      .describe(
        'A grouping label for the feedback (e.g. "accuracy", "completeness").',
      ),
    urgency: z
      .enum(["blocking", "clarification", "assumption", "informational"])
      .describe(
        [
          "How urgently a human response is needed:",
          '- "blocking": cannot proceed at all without an answer.',
          '- "clarification": genuinely ambiguous — unsure how to interpret, but not fully blocked.',
          '- "assumption": proceeded with a guess; please verify the assumption.',
          '- "informational": FYI only — agent proceeded fine and no reply is required.',
        ].join("\n"),
      ),
    suggestedKey: z
      .string()
      .optional()
      .describe("An optional suggested answer key for reference."),
  })
  .describe("A single feedback request item for human review.");

type FeedbackRequestsFeature = StepFeature<
  { [FEEDBACK_REQUEST_RESULT_KEY]?: FeedbackRequestItem[] },
  typeof FEEDBACK_REQUEST_SIGNAL_KEY
>;

const feedbackRequestsFeature: FeedbackRequestsFeature = {
  _resultExtension: z.object({
    [FEEDBACK_REQUEST_RESULT_KEY]: z
      .array(feedbackRequestItemSchema)
      .optional(),
  }),
  _promptAddition: [
    "## Feedback Requests",
    "",
    `If you encounter anything that warrants human review, populate the \`${FEEDBACK_REQUEST_RESULT_KEY}\` array.`,
    "Each item must include:",
    "- **question**: The specific question to pose to a human reviewer.",
    '- **category**: A grouping label for the feedback (e.g. `"accuracy"`, `"completeness"`).',
    "- **urgency**: How urgently a human response is needed. Must be one of:",
    '  - `"blocking"`: Cannot proceed at all without an answer.',
    '  - `"clarification"`: Genuinely ambiguous — unsure how to interpret, but not fully blocked.',
    '  - `"assumption"`: Proceeded with a guess; please verify the assumption.',
    '  - `"informational"`: FYI only — agent proceeded fine and no reply is required.',
    "- **suggestedKey** *(optional)*: A suggested answer key for reference.",
  ].join("\n"),
  _signals: [
    {
      key: FEEDBACK_REQUEST_SIGNAL_KEY,
      sourcePath: FEEDBACK_REQUEST_RESULT_KEY,
      type: "array",
      required: false,
    },
  ],
};

// ─── Features namespace ───────────────────────────────────────────────────────

export const Features = {
  feedbackRequests: Object.assign(
    (): FeedbackRequestsFeature => feedbackRequestsFeature,
    {
      signal: {
        key: FEEDBACK_REQUEST_SIGNAL_KEY,
        find(
          signals: Array<{ key: string; valueJson: unknown }>,
        ): FeedbackRequestItem[] | undefined {
          const match = signals.find(
            (s) => s.key === FEEDBACK_REQUEST_SIGNAL_KEY,
          );
          if (!match) return undefined;
          const parsed = z
            .array(feedbackRequestItemSchema)
            .safeParse(match.valueJson);
          return parsed.success ? parsed.data : undefined;
        },
      },
    },
  ),
} as const;
