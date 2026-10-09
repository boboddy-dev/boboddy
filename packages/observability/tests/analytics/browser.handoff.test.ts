import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { posthogTestMock } from "../../src/analytics/test-mocks/posthog-browser";

import type * as BrowserModuleNamespace from "../../src/analytics/browser";

type BrowserModule = typeof BrowserModuleNamespace;

const ID = "0190f3a2-7c1e-7a4b-9d2e-3f5a6b7c8d9e";
const KEY = "phc_handoff";
const OPTIONS = { key: KEY, host: "https://t.boboddy.dev" };
const MODULE_PATH = "../../src/analytics/browser.ts";

let moduleVersion = 0;
const freshBrowserModule = async (): Promise<BrowserModule> =>
  (await import(
    `${MODULE_PATH}?handoff=${String(++moduleVersion)}`
  )) as BrowserModule;

const BROWSER_GLOBALS = ["window", "location", "document"] as const;
const original = Object.fromEntries(
  BROWSER_GLOBALS.map((name) => [
    name,
    (globalThis as Record<string, unknown>)[name],
  ]),
);

type FakeBrowser = { writes: string[]; setJar: (jar: string) => void };

const installBrowser = ({
  jar,
  hostname = "boboddy.dev",
  protocol = "https:",
}: {
  jar: string;
  hostname?: string;
  protocol?: string;
}): FakeBrowser => {
  const state = { jar, writes: [] as string[] };
  const globals = globalThis as Record<string, unknown>;
  globals["window"] = globalThis;
  globals["location"] = { hostname, protocol };
  globals["document"] = {
    get cookie() {
      return state.jar;
    },
    set cookie(value: string) {
      state.writes.push(value);
    },
  };
  return {
    writes: state.writes,
    setJar: (next) => {
      state.jar = next;
    },
  };
};

const lastInitConfig = (): Record<string, unknown> => {
  const call = posthogTestMock.init.mock.calls.at(-1);
  return call?.[1] ?? {};
};

describe("browser init share-link handoff", () => {
  beforeEach(() => {
    posthogTestMock.init.mockClear();
  });

  afterEach(() => {
    const globals = globalThis as Record<string, unknown>;
    for (const name of BROWSER_GLOBALS) {
      globals[name] = original[name];
    }
  });

  test("bootstraps posthog with the cookie's id as an anonymous id", async () => {
    installBrowser({ jar: `a=1; bb_ph_bootstrap=${ID}; b=2` });
    const { init } = await freshBrowserModule();

    expect(init(OPTIONS)).toBe(true);

    expect(lastInitConfig()["bootstrap"]).toEqual({
      distinctID: ID,
      isIdentifiedID: false,
    });
  });

  test("decodes a url-encoded id", async () => {
    installBrowser({ jar: `bb_ph_bootstrap=anon%3A${ID}` });
    const { init } = await freshBrowserModule();

    init(OPTIONS);

    expect(lastInitConfig()["bootstrap"]).toEqual({
      distinctID: `anon:${ID}`,
      isIdentifiedID: false,
    });
  });

  test("deletes the cookie after init was called with the id", async () => {
    const browser = installBrowser({ jar: `bb_ph_bootstrap=${ID}` });
    const { init } = await freshBrowserModule();
    posthogTestMock.init.mockImplementationOnce(() => {
      expect(browser.writes).toEqual([]);
      return undefined as never;
    });

    init(OPTIONS);

    expect(browser.writes).toEqual([
      "bb_ph_bootstrap=; Domain=.boboddy.dev; Path=/; Max-Age=0; Secure; SameSite=Lax",
    ]);
  });

  test("deletes a host-only cookie on localhost", async () => {
    const browser = installBrowser({
      jar: `bb_ph_bootstrap=${ID}`,
      hostname: "localhost",
      protocol: "http:",
    });
    const { init } = await freshBrowserModule();

    init(OPTIONS);

    expect(lastInitConfig()["bootstrap"]).toBeDefined();
    expect(browser.writes).toEqual([
      "bb_ph_bootstrap=; Path=/; Max-Age=0; SameSite=Lax",
    ]);
  });

  test("without the cookie passes no bootstrap key and writes no cookie", async () => {
    const browser = installBrowser({ jar: "a=1; b=2" });
    const { init } = await freshBrowserModule();

    init(OPTIONS);

    expect("bootstrap" in lastInitConfig()).toBe(false);
    expect(browser.writes).toEqual([]);
  });

  test("ignores an unusable value but still deletes the cookie", async () => {
    const browser = installBrowser({ jar: "bb_ph_bootstrap=%E0%A4%A" });
    const { init } = await freshBrowserModule();

    init(OPTIONS);

    expect("bootstrap" in lastInitConfig()).toBe(false);
    expect(browser.writes).toHaveLength(1);
  });

  test("leaves an existing posthog identity alone but still deletes the cookie", async () => {
    const browser = installBrowser({
      jar: `ph_${KEY}_posthog=%7B%22distinct_id%22%3A%22existing%22%7D; bb_ph_bootstrap=${ID}`,
    });
    const { init } = await freshBrowserModule();

    init(OPTIONS);

    expect("bootstrap" in lastInitConfig()).toBe(false);
    expect(browser.writes).toHaveLength(1);
  });

  test("is idempotent: a second call does not re-init or re-read the cookie", async () => {
    const browser = installBrowser({ jar: `bb_ph_bootstrap=${ID}` });
    const { init } = await freshBrowserModule();

    expect(init(OPTIONS)).toBe(true);
    browser.setJar(`bb_ph_bootstrap=other`);
    expect(init(OPTIONS)).toBe(true);

    expect(posthogTestMock.init).toHaveBeenCalledTimes(1);
    expect(browser.writes).toHaveLength(1);
  });

  test("leaves the cookie alone when init is skipped for missing config", async () => {
    const browser = installBrowser({ jar: `bb_ph_bootstrap=${ID}` });
    const { init } = await freshBrowserModule();

    expect(init({ key: "", host: "" })).toBe(false);

    expect(posthogTestMock.init).not.toHaveBeenCalled();
    expect(browser.writes).toEqual([]);
  });

  test("still initialises when there is no document", async () => {
    installBrowser({ jar: "" });
    delete (globalThis as Record<string, unknown>)["document"];
    const { init } = await freshBrowserModule();

    expect(init(OPTIONS)).toBe(true);

    expect("bootstrap" in lastInitConfig()).toBe(false);
  });
});
