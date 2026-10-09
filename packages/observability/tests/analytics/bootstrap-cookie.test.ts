import { describe, expect, test } from "bun:test";
import {
  BOOTSTRAP_COOKIE_NAME,
  buildBootstrapCookieDeletion,
  hasPosthogCookie,
  readBootstrapCookie,
} from "../../src/analytics/bootstrap-cookie";

const ID = "0190f3a2-7c1e-7a4b-9d2e-3f5a6b7c8d9e";

describe("readBootstrapCookie", () => {
  test.concurrent("reads the distinct id when it is the only cookie", () => {
    expect(readBootstrapCookie(`${BOOTSTRAP_COOKIE_NAME}=${ID}`)).toEqual({
      present: true,
      distinctId: ID,
    });
  });

  test.concurrent("finds the cookie among many others", () => {
    const cookies = `a=1; theme=dark; ${BOOTSTRAP_COOKIE_NAME}=${ID}; ph_phc_posthog=%7B%7D; z=9`;
    expect(readBootstrapCookie(cookies)).toEqual({
      present: true,
      distinctId: ID,
    });
  });

  test.concurrent("decodes a url-encoded value", () => {
    expect(
      readBootstrapCookie(`${BOOTSTRAP_COOKIE_NAME}=anon%3A${ID}`),
    ).toEqual({ present: true, distinctId: `anon:${ID}` });
  });

  test.concurrent("reports an absent cookie", () => {
    expect(readBootstrapCookie("a=1; b=2")).toEqual({
      present: false,
      distinctId: null,
    });
    expect(readBootstrapCookie("")).toEqual({
      present: false,
      distinctId: null,
    });
    expect(readBootstrapCookie(undefined)).toEqual({
      present: false,
      distinctId: null,
    });
  });

  test.concurrent(
    "does not match cookies that only share a prefix or suffix",
    () => {
      expect(
        readBootstrapCookie(
          `x${BOOTSTRAP_COOKIE_NAME}=${ID}; ${BOOTSTRAP_COOKIE_NAME}x=${ID}`,
        ),
      ).toEqual({ present: false, distinctId: null });
    },
  );

  test.concurrent("treats an empty value as present but unusable", () => {
    expect(readBootstrapCookie(`${BOOTSTRAP_COOKIE_NAME}=`)).toEqual({
      present: true,
      distinctId: null,
    });
    expect(readBootstrapCookie(`${BOOTSTRAP_COOKIE_NAME}=%20%20`)).toEqual({
      present: true,
      distinctId: null,
    });
  });

  test.concurrent("treats a malformed escape as present but unusable", () => {
    expect(readBootstrapCookie(`${BOOTSTRAP_COOKIE_NAME}=%E0%A4%A`)).toEqual({
      present: true,
      distinctId: null,
    });
  });

  test.concurrent("falls back to a later usable duplicate", () => {
    expect(
      readBootstrapCookie(
        `${BOOTSTRAP_COOKIE_NAME}=; ${BOOTSTRAP_COOKIE_NAME}=${ID}`,
      ),
    ).toEqual({ present: true, distinctId: ID });
  });

  test.concurrent("keeps '=' characters inside the value", () => {
    expect(readBootstrapCookie(`${BOOTSTRAP_COOKIE_NAME}=a=b`)).toEqual({
      present: true,
      distinctId: "a=b",
    });
  });
});

describe("hasPosthogCookie", () => {
  test.concurrent("detects the project's persisted posthog cookie", () => {
    expect(hasPosthogCookie("a=1; ph_phc_abc_posthog=%7B%7D", "phc_abc")).toBe(
      true,
    );
  });

  test.concurrent("ignores other projects and missing cookies", () => {
    expect(hasPosthogCookie("ph_phc_other_posthog=%7B%7D", "phc_abc")).toBe(
      false,
    );
    expect(hasPosthogCookie("", "phc_abc")).toBe(false);
    expect(hasPosthogCookie(undefined, "phc_abc")).toBe(false);
  });
});

describe("buildBootstrapCookieDeletion", () => {
  test.concurrent(
    "scopes to the parent domain on boboddy.dev over https",
    () => {
      expect(
        buildBootstrapCookieDeletion({
          hostname: "boboddy.dev",
          protocol: "https:",
        }),
      ).toBe(
        `${BOOTSTRAP_COOKIE_NAME}=; Domain=.boboddy.dev; Path=/; Max-Age=0; Secure; SameSite=Lax`,
      );
    },
  );

  test.concurrent(
    "uses the parent domain on every boboddy.dev subdomain",
    () => {
      for (const hostname of [
        "app.boboddy.dev",
        "docs.boboddy.dev",
        "A.Boboddy.Dev",
      ]) {
        expect(
          buildBootstrapCookieDeletion({ hostname, protocol: "https:" }),
        ).toContain("Domain=.boboddy.dev");
      }
    },
  );

  test.concurrent("is host-only on localhost over http", () => {
    expect(
      buildBootstrapCookieDeletion({
        hostname: "localhost",
        protocol: "http:",
      }),
    ).toBe(`${BOOTSTRAP_COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax`);
  });

  test.concurrent(
    "is host-only on preview deployments and lookalike hosts",
    () => {
      for (const hostname of [
        "boboddy-git-feat.vercel.app",
        "evilboboddy.dev",
        "boboddy.dev.example.com",
      ]) {
        const cookie = buildBootstrapCookieDeletion({
          hostname,
          protocol: "https:",
        });
        expect(cookie).not.toContain("Domain=");
        expect(cookie).toContain("Secure");
      }
    },
  );
});
