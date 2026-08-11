import { spyOn } from "bun:test";
import posthog from "posthog-js";

export const posthogTestMock = {
  init: spyOn(posthog, "init").mockImplementation(() => posthog),
  capture: spyOn(posthog, "capture").mockImplementation(() => undefined),
  identify: spyOn(posthog, "identify").mockImplementation(() => undefined),
  reset: spyOn(posthog, "reset").mockImplementation(() => undefined),
  captureException: spyOn(posthog, "captureException").mockImplementation(
    () => undefined,
  ),
};
