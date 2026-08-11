import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { posthogTestMock } from "../../src/analytics/test-mocks/posthog-browser";
import * as analytics from "../../src/analytics/browser";

describe("browser analytics wrapper", () => {
  beforeAll(() => {
    (globalThis as { window?: unknown }).window = globalThis;
    analytics.init({ key: "phc_test", host: "https://t.boboddy.dev" });
  });

  beforeEach(() => {
    posthogTestMock.capture.mockClear();
    posthogTestMock.identify.mockClear();
    posthogTestMock.reset.mockClear();
    posthogTestMock.captureException.mockClear();
  });

  test("init configures posthog with the supplied host and key", () => {
    const matching = posthogTestMock.init.mock.calls.find(
      (call) => call[0] === "phc_test",
    );
    expect(matching?.[1]).toMatchObject({
      api_host: "https://t.boboddy.dev",
      capture_exceptions: true,
    });
  });

  test("capture forwards event name and properties", () => {
    analytics.capture("clicked_thing", { foo: "bar" });
    expect(posthogTestMock.capture).toHaveBeenCalledWith("clicked_thing", {
      foo: "bar",
    });
  });

  test("pageView posts $pageview with the supplied url", () => {
    analytics.pageView("https://app.boboddy.dev/dashboard");
    expect(posthogTestMock.capture).toHaveBeenCalledWith("$pageview", {
      $current_url: "https://app.boboddy.dev/dashboard",
    });
  });

  test("identify forwards user id and traits", () => {
    analytics.identify("user-1", { email: "x@example.test" });
    expect(posthogTestMock.identify).toHaveBeenCalledWith("user-1", {
      email: "x@example.test",
    });
  });

  test("reset clears posthog state", () => {
    analytics.reset();
    expect(posthogTestMock.reset).toHaveBeenCalledTimes(1);
  });

  test("captureException forwards the error and context", () => {
    const err = new Error("boom");
    analytics.captureException(err, { digest: "abc" });
    expect(posthogTestMock.captureException).toHaveBeenCalledWith(err, {
      digest: "abc",
    });
  });

  test("captureException works without context", () => {
    const err = new Error("plain");
    analytics.captureException(err);
    expect(posthogTestMock.captureException).toHaveBeenCalledWith(
      err,
      undefined,
    );
  });
});
