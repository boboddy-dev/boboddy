export const AnalyticsEvents = {
  UserSignedUp: "user_signed_up",
  CtaClicked: "cta_clicked",
  DocsClicked: "docs_clicked",
  GithubClicked: "github_clicked",
  DemoClicked: "demo_clicked",
  // Docs site (apps/docs/src/components/Head.astro), Quickstart page only.
  DocsQuickstartViewed: "docs_quickstart_viewed",
  DocsQuickstartScrolled: "docs_quickstart_scrolled",
  DocsQuickstartCommandCopied: "docs_quickstart_command_copied",
  ApiEndpointTimed: "api_endpoint_timed",
  // Server-side onboarding funnel (see docs/analytics.md). Captured from use
  // cases and routes through core's `AnalyticsPort`, always after the
  // persisting transaction has committed.
  UsernameChosen: "username_chosen",
  ProjectCreated: "project_created",
  PipelineCreated: "pipeline_created",
  PipelineRunCompleted: "pipeline_run_completed",
  InviteAccepted: "invite_accepted",
  GithubAppInstalled: "github_app_installed",
  // Captured by `@boboddy/growth` when a visitor opens a `/s/<code>` share
  // link, under the visitor's browser distinct id.
  ShareLinkClicked: "share_link_clicked",
  // CLI onboarding funnel (see apps/cli/src/lib/telemetry.ts) — one event per
  // milestone, keyed by distinct-id/session rather than by command, so the
  // funnel reads the same across `boboddy init`'s guided path and every
  // self-healing shortcut (e.g. `pipelines design`'s own sign-in check) that
  // reaches the same milestone.
  CliInitStarted: "cli_init_started",
  CliRequirementsVerified: "cli_requirements_verified",
  CliAuthCompleted: "cli_auth_completed",
  CliProjectLinked: "cli_project_linked",
  CliProviderConnectStarted: "cli_provider_connect_started",
  CliProviderConnectCompleted: "cli_provider_connect_completed",
  CliDesignerLaunched: "cli_designer_launched",
  CliStudioOpened: "cli_studio_opened",
  CliDryRunPassed: "cli_dry_run_passed",
  CliPipelinePushed: "cli_pipeline_pushed",
  CliRunQueued: "cli_run_queued",
  CliRunOfferSkipped: "cli_run_offer_skipped",
  CliCommandFailed: "cli_command_failed",
} as const;

export type AnalyticsEventName =
  (typeof AnalyticsEvents)[keyof typeof AnalyticsEvents];

export type SignupProvider = "github" | "google" | "email";

export type SignupProperties = {
  provider: SignupProvider;
  email_verified: boolean;
};

export type ApiEndpointTimedProperties = {
  method: string;
  route: string;
  status_code: number;
  duration_ms: number;
  ok: boolean;
  operation_id?: string;
  tags?: string[];
  error_code?: string;
};

export type NoProperties = Record<string, never>;

export type ProjectCreatedProperties = {
  project_id: string;
  source: "github" | "manual";
  origin: "web" | "cli_handoff" | "cli_api";
};

export type PipelineCreatedProperties = {
  project_id: string;
  pipeline_definition_id: string;
  via: "push" | "web";
};

export type PipelineRunCompletedStatus =
  "succeeded" | "failed" | "cancelled" | "blocked" | "routed";

export type PipelineRunCompletedProperties = {
  project_id: string;
  pipeline_run_id: string;
  status: PipelineRunCompletedStatus;
  trigger: "user" | "system";
  duration_ms: number;
};

export type InviteAcceptedProperties = {
  project_id: string;
  role: string;
  new_member: boolean;
};

export type GithubAppInstalledProperties = {
  intent: "create" | "link";
  new_installation: boolean;
};

/**
 * `link_name`, `source` and `campaign` are the share link's human-readable
 * labels, never the opaque code. `$set_once` pins the visitor's first share
 * link on their person; `$set` tracks the latest. Unset `source`/`campaign`
 * are sent as `null` so `initial_*` always describes the first link.
 */
export type ShareLinkClickedProperties = {
  link_name: string;
  source: string | null;
  campaign: string | null;
  code: string;
  destination: string;
  referrer: string | null;
  $set: {
    last_share_link: string;
    last_share_source: string | null;
    last_share_campaign: string | null;
  };
  $set_once: {
    initial_share_link: string;
    initial_share_source: string | null;
    initial_share_campaign: string | null;
  };
};

/**
 * `via` says how a new project came to exist: created by `init` through the
 * API from a GitHub repo, or by the user in the browser hand-off.
 */
export type CliProjectLinkedProperties =
  { linked: "existing" } | { linked: "new"; via: "api" | "browser" };

/**
 * Deliberately no free-text `message`: CLI error messages can carry local
 * paths, remote URLs, or tokens. `code` is a closed vocabulary.
 */
export type CliCommandFailedProperties = {
  command: string;
  code: string;
};

export type CliRunOfferSkippedReason =
  | "tui_not_clean"
  | "no_devcontainer"
  | "no_pipeline"
  | "dry_run_failed"
  | "declined";

export type CliRunOfferSkippedProperties = {
  reason: CliRunOfferSkippedReason;
};

/**
 * AI tools found installed on the machine — names only. Mirrors
 * `InstalledAiTool` in `@boboddy/worker`, redeclared here so observability
 * does not depend on the worker.
 */
export type CliDetectedAiTool = "claude" | "codex" | "copilot";

export type CliProviderConnectStartedProperties = {
  detected: readonly CliDetectedAiTool[];
};

/** Provider names only (e.g. `anthropic`), never credential material. */
export type CliProviderConnectCompletedProperties = {
  providers: readonly string[];
};

/** Provider names the designer session can run on. */
export type CliDesignerLaunchedProperties = {
  providers: readonly string[];
};

/**
 * `via` separates the studio auto-opened by `pipelines design` from a
 * deliberate `pipelines studio`; `browser_opened` is false when no browser
 * tab could be opened (e.g. no display).
 */
export type CliStudioOpenedProperties = {
  via: "design" | "studio";
  browser_opened: boolean;
};

export type DocsQuickstartScrollDepth = "25" | "50" | "75" | "100";

/**
 * Sent once per depth per page view. Strings, not numbers, so the managed
 * funnels can filter on them with the same exact-match filter as every other
 * property.
 */
export type DocsQuickstartScrolledProperties = {
  depth: DocsQuickstartScrollDepth;
};

/** `step`: the 1-based number of the Quickstart `<Steps>` item, as a string. */
export type DocsQuickstartCommandCopiedProperties = {
  step: string;
};

/** Sent on every CLI event by `captureMilestone`, on top of the event's own properties. */
export type CliContextProperties = {
  cli_version: string;
  os: string;
  arch: string;
  cli_key_source: "baked" | "env";
};

/** Free-form properties for events that have no typed shape yet. */
export type UntypedEventProperties = Record<string, unknown>;

/**
 * Property shape per event, so a typed `capture` rejects a misspelled or
 * missing property at compile time.
 */
export type AnalyticsEventProperties = {
  user_signed_up: SignupProperties;
  cta_clicked: UntypedEventProperties;
  docs_clicked: UntypedEventProperties;
  github_clicked: UntypedEventProperties;
  demo_clicked: UntypedEventProperties;
  docs_quickstart_viewed: NoProperties;
  docs_quickstart_scrolled: DocsQuickstartScrolledProperties;
  docs_quickstart_command_copied: DocsQuickstartCommandCopiedProperties;
  api_endpoint_timed: ApiEndpointTimedProperties;
  username_chosen: NoProperties;
  project_created: ProjectCreatedProperties;
  pipeline_created: PipelineCreatedProperties;
  pipeline_run_completed: PipelineRunCompletedProperties;
  invite_accepted: InviteAcceptedProperties;
  github_app_installed: GithubAppInstalledProperties;
  share_link_clicked: ShareLinkClickedProperties;
  cli_init_started: UntypedEventProperties;
  cli_requirements_verified: UntypedEventProperties;
  cli_auth_completed: UntypedEventProperties;
  cli_project_linked: CliProjectLinkedProperties;
  cli_provider_connect_started: CliProviderConnectStartedProperties;
  cli_provider_connect_completed: CliProviderConnectCompletedProperties;
  cli_designer_launched: CliDesignerLaunchedProperties;
  cli_studio_opened: CliStudioOpenedProperties;
  cli_dry_run_passed: UntypedEventProperties;
  cli_pipeline_pushed: UntypedEventProperties;
  cli_run_queued: UntypedEventProperties;
  cli_run_offer_skipped: CliRunOfferSkippedProperties;
  cli_command_failed: CliCommandFailedProperties;
};
