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
//
// Zod is the one source of truth for this domain's shapes — every exported
// type below is `z.infer`'d from a schema, never hand-declared beside one.
// Duplicating a shape as both a schema and an independent `type` is exactly
// the "two things that must be kept in sync by hand" trap `codeStep()`'s own
// design goes out of its way to avoid; there's no reason this feature should
// reintroduce it.

const notificationKindSchema = z.enum([
  "feedback_request",
  "status_update",
  "blocked",
  "result_ready",
  "warning",
]);
export type NotificationKind = z.infer<typeof notificationKindSchema>;

const notificationPrioritySchema = z.enum(["low", "normal", "high", "urgent"]);
export type NotificationPriority = z.infer<typeof notificationPrioritySchema>;

const notificationChannelSchema = z.enum([
  "in_app",
  "work_item_platform_comment",
  "email",
  "slack",
]);
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;

export type FeedbackRequestUrgency =
  "blocking" | "clarification" | "assumption" | "informational";

const NOTIFICATION_SIGNAL_KEY = "$boboddy_notifications_v1" as const;
const NOTIFICATION_RESULT_KEY = "$boboddy_notifications_v1" as const;

/** `kind` used by `Notify.inApp(...)` when the caller doesn't name one
 * explicitly — `status_update` is the closest thing this domain has to a
 * generic "just tell the human something" kind. */
const DEFAULT_NOTIFICATION_KIND: NotificationKind = "status_update";

const notificationItemSchema = z
  .object({
    kind: notificationKindSchema.describe("The kind of user notification."),
    title: z.string().describe("Short, human-readable notification title."),
    body: z.string().describe("The notification body / details."),
    priority: notificationPrioritySchema.describe(
      "How important this notification is for the user.",
    ),
    suggestedChannels: z
      .array(notificationChannelSchema)
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

/** A single notification. Inferred from `notificationItemSchema` — the
 * schema is the source of truth; this type can never drift from what's
 * actually validated and pushed as JSON Schema. */
export type NotificationItem = z.infer<typeof notificationItemSchema>;

/**
 * The shape `Notify.*` returns: a step result fragment carrying one or more
 * notifications. Spread it into a larger result object, or return it
 * directly if the notification *is* the step's whole result — either way it
 * slots into the same `$boboddy_notifications_v1` field `Features.notifications()`
 * wires a signal extractor for.
 */
export type NotificationResultFragment = {
  readonly [NOTIFICATION_RESULT_KEY]: NotificationItem[];
};

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
    '- **suggestedChannels** *(optional)*: Channels you think are worth using (e.g. `["in_app", "work_item_platform_comment"]`).',
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

// ─── Built-in: feedbackRequests (a real specialization, not an alias) ──────────

export type FeedbackRequestItem = {
  question: string;
  category: string;
  urgency: FeedbackRequestUrgency;
  suggestedKey?: string;
};

/**
 * Unlike `notificationsFeature`, this narrows `kind` to the literal
 * `"feedback_request"` — a step attaching this feature can only ever emit
 * feedback-request notifications, both in the pushed JSON Schema and in the
 * prompt section the agent reads. A "convenience wrapper" that returned the
 * exact same feature as `notifications()` wouldn't actually be one.
 */
const feedbackRequestsFeature: NotificationsFeature = {
  _resultExtension: z.object({
    [NOTIFICATION_RESULT_KEY]: z
      .array(
        notificationItemSchema.extend({ kind: z.literal("feedback_request") }),
      )
      .optional(),
  }),
  _promptAddition: [
    "## Feedback Requests",
    "",
    `If you need to ask a human a clarifying question, populate the \`${NOTIFICATION_RESULT_KEY}\` array with items of kind \`"feedback_request"\`.`,
    "Each item must include:",
    "- **title**: A short, human-readable summary of the question.",
    "- **body**: The full question.",
    "- **priority**: One of `low`, `normal`, `high`, `urgent`.",
    '- **payload**: `{ "category": string, "urgency": "blocking"|"clarification"|"assumption"|"informational", "suggestedKey"?: string }`.',
  ].join("\n"),
  _signals: notificationsFeature._signals,
};

// ─── Features namespace — attach a capability to a step definition ────────────
//
// `Features.*` is exclusively for `features: [...]`. It never carries value
// constructors or signal-reading helpers — see `Notify` and
// `NotificationSignal` below for those, kept separate on purpose so
// `Features.` autocomplete only ever shows things you attach to a step.

export const Features = {
  notifications: (): NotificationsFeature => notificationsFeature,
  /**
   * A real specialization of `notifications()`, not an alias: narrows every
   * emitted item to `kind: "feedback_request"` and swaps in a
   * feedback-request-specific prompt section. Backed by the same
   * `$boboddy_notifications_v1` signal.
   */
  feedbackRequests: (): NotificationsFeature => feedbackRequestsFeature,
} as const;

// ─── NotificationSignal — read notifications back out of execution signals ────

export const NotificationSignal = {
  key: NOTIFICATION_SIGNAL_KEY,
  find(
    signals: Array<{ key: string; valueJson: unknown }>,
  ): NotificationItem[] | undefined {
    const match = signals.find((s) => s.key === NOTIFICATION_SIGNAL_KEY);
    if (!match) return undefined;
    const parsed = z.array(notificationItemSchema).safeParse(match.valueJson);
    return parsed.success ? parsed.data : undefined;
  },
} as const;

// ─── Notify — construct a notification result value at runtime ────────────────
//
// A flat namespace of pure builder functions, the same shape as `Rule`/
// `Computed` in `@boboddy/sdk/definitions/pipelines` — nothing here attaches
// a feature or reads a signal, it only builds the plain data value a step's
// `fn` (most useful in a `codeStep`, where there's no agent to follow a
// prompt) or `agentPrompt`-driven result can return.
//
// Only `inApp` gets dedicated sugar: it's the one channel the platform
// actually delivers today (`in_app`'s adapter is real; `work_item_platform_comment`/
// `email`/`slack` are all unimplemented and will fail delivery even when a
// policy rule allows them). Use `Notify.create({ ...,  suggestedChannels })`
// directly to suggest any other channel — the field is a suggestion the
// platform's notification policy decides on, not a delivery guarantee, so it
// deliberately isn't hidden behind one dedicated function per channel that
// would otherwise look equally supported.
export const Notify = {
  /** The one generic constructor. Field names match `NotificationItem`
   * exactly, so a new optional field never forces a call-site rewrite. */
  create: (item: NotificationItem): NotificationResultFragment => ({
    [NOTIFICATION_RESULT_KEY]: [item],
  }),
  /** Build a notification for the in-app inbox — the one channel the
   * platform always delivers, so it's the safest default when the caller
   * doesn't need a specific channel. */
  inApp: (
    title: string,
    body: string,
    priority: NotificationPriority,
    options?: { kind?: NotificationKind; payload?: Record<string, unknown> },
  ): NotificationResultFragment =>
    Notify.create({
      kind: options?.kind ?? DEFAULT_NOTIFICATION_KIND,
      title,
      body,
      priority,
      suggestedChannels: ["in_app"],
      ...(options?.payload ? { payload: options.payload } : {}),
    }),
  /** Build a `kind: "feedback_request"` notification — the value-builder
   * counterpart to `Features.feedbackRequests()`. */
  feedbackRequest: (
    question: string,
    category: string,
    urgency: FeedbackRequestUrgency,
    suggestedKey?: string,
  ): NotificationResultFragment =>
    Notify.create({
      kind: "feedback_request",
      title: question,
      body: question,
      priority: "normal",
      payload: {
        category,
        urgency,
        ...(suggestedKey ? { suggestedKey } : {}),
      },
    }),
  /** Combine several notification result fragments (e.g. more than one
   * `Notify.*` call) into a single result value. */
  merge: (
    ...fragments: NotificationResultFragment[]
  ): NotificationResultFragment => ({
    [NOTIFICATION_RESULT_KEY]: fragments.flatMap(
      (fragment) => fragment[NOTIFICATION_RESULT_KEY],
    ),
  }),
} as const;
