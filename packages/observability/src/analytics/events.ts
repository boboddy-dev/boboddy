export const AnalyticsEvents = {
  UserSignedUp: "user_signed_up",
  CtaClicked: "cta_clicked",
  DocsClicked: "docs_clicked",
  GithubClicked: "github_clicked",
  ApiEndpointTimed: "api_endpoint_timed",
  // CLI onboarding funnel (see apps/cli/src/lib/telemetry.ts) — one event per
  // milestone, keyed by distinct-id/session rather than by command, so the
  // funnel reads the same across `boboddy init`'s guided path and every
  // self-healing shortcut (e.g. `pipelines design`'s own sign-in check) that
  // reaches the same milestone.
  CliInitStarted: "cli_init_started",
  CliRequirementsVerified: "cli_requirements_verified",
  CliAuthCompleted: "cli_auth_completed",
  CliProjectLinked: "cli_project_linked",
  CliDesignerLaunched: "cli_designer_launched",
  CliDryRunPassed: "cli_dry_run_passed",
  CliPipelinePushed: "cli_pipeline_pushed",
  CliRunQueued: "cli_run_queued",
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
