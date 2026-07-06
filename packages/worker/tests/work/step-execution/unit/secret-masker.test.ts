import { describe, expect, it } from "bun:test";
import { SecretMasker } from "../../../../src/work/step-execution/application/secret-masker";

describe("SecretMasker", () => {
  it("masks a single occurrence of a registered secret", () => {
    const masker = new SecretMasker(["supersecret"]);
    expect(masker.mask("token=supersecret done")).toBe("token=*** done");
  });

  it("masks every occurrence of a secret in a line", () => {
    const masker = new SecretMasker(["hunter2xyz"]);
    expect(masker.mask("hunter2xyz and again hunter2xyz")).toBe(
      "*** and again ***",
    );
  });

  it("masks multiple distinct secrets", () => {
    const masker = new SecretMasker(["alpha-secret", "beta-secret"]);
    expect(masker.mask("a=alpha-secret b=beta-secret")).toBe("a=*** b=***");
  });

  it("masks the longer value when one secret contains another", () => {
    // "abcdef" contains "abcd"; without longest-first ordering the shorter
    // match would leave "**ef" exposing the secret's suffix.
    const masker = new SecretMasker(["abcd", "abcdef"]);
    expect(masker.mask("value=abcdef")).toBe("value=***");
  });

  it("ignores values shorter than the minimum length", () => {
    const masker = new SecretMasker(["1", "ab", "true"]);
    // "true" (length 4) is masked; the shorter ones are not, so unrelated text
    // containing "1"/"ab" is untouched.
    expect(masker.mask("a1b ab true")).toBe("a1b ab ***");
  });

  it("ignores blank and whitespace-only values", () => {
    const masker = new SecretMasker(["", "   ", "\t\n"]);
    expect(masker.mask("nothing to mask here")).toBe("nothing to mask here");
  });

  it("treats regex-special characters in a secret literally", () => {
    const masker = new SecretMasker(["a.b*c+"]);
    // Masks the literal secret, and does NOT act as a pattern that would also
    // match e.g. "axbxc".
    expect(masker.mask("x a.b*c+ y axbxc z")).toBe("x *** y axbxc z");
  });

  it("is a no-op when no maskable values are registered", () => {
    const masker = new SecretMasker();
    const input = "plain log line";
    expect(masker.mask(input)).toBe(input);
  });

  it("picks up values registered after the first mask (lazy recompile)", () => {
    const masker = new SecretMasker(["first-secret"]);
    expect(masker.mask("first-secret second-secret")).toBe(
      "*** second-secret",
    );
    masker.register(["second-secret"]);
    expect(masker.mask("first-secret second-secret")).toBe("*** ***");
  });

  it("is idempotent when the same value is registered twice", () => {
    const masker = new SecretMasker(["dup-secret"]);
    masker.register(["dup-secret"]);
    expect(masker.mask("dup-secret")).toBe("***");
  });
});
