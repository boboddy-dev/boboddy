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
  });
});
