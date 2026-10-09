import { describe, expect, test } from "bun:test";
import { AnalyticsEvents } from "../../src/analytics/events";

describe("AnalyticsEvents", () => {
  test("UserSignedUp uses the snake_case wire name", () => {
    expect(AnalyticsEvents.UserSignedUp).toBe("user_signed_up");
  });

  test("link click events use the snake_case wire name", () => {
    expect(AnalyticsEvents.CtaClicked).toBe("cta_clicked");
    expect(AnalyticsEvents.DocsClicked).toBe("docs_clicked");
    expect(AnalyticsEvents.GithubClicked).toBe("github_clicked");
    expect(AnalyticsEvents.DemoClicked).toBe("demo_clicked");
  });

  test("docs Quickstart events use the snake_case wire name", () => {
    expect(AnalyticsEvents.DocsQuickstartViewed).toBe("docs_quickstart_viewed");
    expect(AnalyticsEvents.DocsQuickstartScrolled).toBe(
      "docs_quickstart_scrolled",
    );
    expect(AnalyticsEvents.DocsQuickstartCommandCopied).toBe(
      "docs_quickstart_command_copied",
    );
  });

  test("server funnel events use the snake_case wire name", () => {
    expect(AnalyticsEvents.UsernameChosen).toBe("username_chosen");
    expect(AnalyticsEvents.ProjectCreated).toBe("project_created");
    expect(AnalyticsEvents.PipelineCreated).toBe("pipeline_created");
    expect(AnalyticsEvents.PipelineRunCompleted).toBe("pipeline_run_completed");
    expect(AnalyticsEvents.InviteAccepted).toBe("invite_accepted");
    expect(AnalyticsEvents.GithubAppInstalled).toBe("github_app_installed");
  });

  test("CLI failure events use the snake_case wire name", () => {
    expect(AnalyticsEvents.CliCommandFailed).toBe("cli_command_failed");
    expect(AnalyticsEvents.CliRunOfferSkipped).toBe("cli_run_offer_skipped");
  });

  test("CLI provider-connect and designer events use the snake_case wire name", () => {
    expect(AnalyticsEvents.CliProviderConnectStarted).toBe(
      "cli_provider_connect_started",
    );
    expect(AnalyticsEvents.CliProviderConnectCompleted).toBe(
      "cli_provider_connect_completed",
    );
    expect(AnalyticsEvents.CliDesignerLaunched).toBe("cli_designer_launched");
  });

  test("CLI studio event uses the snake_case wire name", () => {
    expect(AnalyticsEvents.CliStudioOpened).toBe("cli_studio_opened");
  });

  test("every wire name is unique", () => {
    const names = Object.values(AnalyticsEvents);
    expect(new Set(names).size).toBe(names.length);
  });
});
