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

export type AnyStepFeature = StepFeature;

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
      TFeatures[number] extends StepFeature<infer R> ? R : never
    >;

// Unions all signal keys contributed by features.
// Uses phantom field access instead of infer to avoid disrupting const-literal inference
// for sibling generics (a TypeScript inference quirk with distributive infer in return types).
export type FeatureSignalKeys<TFeatures extends readonly AnyStepFeature[]> =
  NonNullable<TFeatures[number]["__signalKeys"]>;

// ─── Built-in: notifications (general user notification primitive) ─────────────

export type NotificationKind =
  | "feedback_request"
  | "status_update"
  | "blocked"
  | "result_ready"
  | "warning";

export type NotificationPriority = "low" | "normal" | "high" | "urgent";

export type NotificationChannel =
  | "in_app"
  | "work_item_platform_comment"
  | "email"
  | "slack";

export type FeedbackRequestUrgency =
  | "blocking"
  | "clarification"
  | "assumption"
  | "informational";

export type NotificationItem = {
  kind: NotificationKind;
  title: string;
  body: string;
  priority: NotificationPriority;
  suggestedChannels?: NotificationChannel[];
  /**
   * Kind-specific structured payload. For `feedback_request`:
   * `{ category, urgency, suggestedKey? }`.
   */
  payload?: Record<string, unknown>;
};

const NOTIFICATION_SIGNAL_KEY = "$boboddy_notifications_v1" as const;
const NOTIFICATION_RESULT_KEY = "$boboddy_notifications_v1" as const;

const notificationItemSchema = z
  .object({
    kind: z
      .enum([
        "feedback_request",
        "status_update",
        "blocked",
        "result_ready",
        "warning",
      ])
      .describe("The kind of user notification."),
    title: z.string().describe("Short, human-readable notification title."),
    body: z.string().describe("The notification body / details."),
    priority: z
      .enum(["low", "normal", "high", "urgent"])
      .describe("How important this notification is for the user."),
    suggestedChannels: z
      .array(z.enum(["in_app", "work_item_platform_comment", "email", "slack"]))
      .optional()
      .describe(
        "Channels the agent thinks are worth using. The platform policy decides the final channels.",
      ),
    payload: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'Kind-specific structured data. For "feedback_request": { category, urgency, suggestedKey? }.',
      ),
  })
  .describe("A single user notification emitted by the agent.");

type NotificationsFeature = StepFeature<
  { [NOTIFICATION_RESULT_KEY]?: NotificationItem[] },
  typeof NOTIFICATION_SIGNAL_KEY
>;

const notificationsFeature: NotificationsFeature = {
  _resultExtension: z.object({
    [NOTIFICATION_RESULT_KEY]: z.array(notificationItemSchema).optional(),
  }),
  _promptAddition: [
    "## User Notifications",
    "",
    `If you need to communicate something to a human, populate the \`${NOTIFICATION_RESULT_KEY}\` array.`,
    "Each item must include:",
    "- **kind**: One of `feedback_request`, `status_update`, `blocked`, `result_ready`, `warning`.",
    "- **title**: A short, human-readable title.",
    "- **body**: The details of the notification.",
    "- **priority**: One of `low`, `normal`, `high`, `urgent`.",
    "- **suggestedChannels** *(optional)*: Channels you think are worth using (e.g. `[\"in_app\", \"work_item_platform_comment\"]`).",
    "  You only *suggest* channels — the platform policy decides the final delivery channels.",
    '- **payload** *(optional)*: Kind-specific data. For `feedback_request`, include `{ "category": string, "urgency": "blocking"|"clarification"|"assumption"|"informational", "suggestedKey"?: string }`.',
  ].join("\n"),
  _signals: [
    {
      key: NOTIFICATION_SIGNAL_KEY,
      sourcePath: NOTIFICATION_RESULT_KEY,
      type: "array",
      required: false,
    },
  ],
};

// ─── Built-in: feedbackRequests (convenience wrapper over notifications) ───────

export type FeedbackRequestItem = {
  question: string;
  category: string;
  urgency: FeedbackRequestUrgency;
  suggestedKey?: string;
};

// ─── Features namespace ───────────────────────────────────────────────────────

export const Features = {
  notifications: Object.assign(
    (): NotificationsFeature => notificationsFeature,
    {
      signal: {
        key: NOTIFICATION_SIGNAL_KEY,
        find(
          signals: Array<{ key: string; valueJson: unknown }>,
        ): NotificationItem[] | undefined {
          const match = signals.find((s) => s.key === NOTIFICATION_SIGNAL_KEY);
          if (!match) return undefined;
          const parsed = z
            .array(notificationItemSchema)
            .safeParse(match.valueJson);
          return parsed.success ? parsed.data : undefined;
        },
      },
    },
  ),
  /**
   * Convenience wrapper that emits `feedback_request` notifications.
   * Backed by the same `$boboddy_notifications_v1` signal.
   */
  feedbackRequests: Object.assign(
    (): NotificationsFeature => notificationsFeature,
    {
      signal: {
        key: NOTIFICATION_SIGNAL_KEY,
      },
    },
  ),
} as const;
