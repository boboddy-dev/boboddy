import { describe, expect } from "bun:test";
import { CliError } from "../src/lib/cli-error";
import {
  ensureSignedIn,
  notSignedInMessage,
  type SignInPorts,
} from "../src/lib/ensure-signed-in";
import { noopBaseReporter } from "../src/lib/reporter-types";
import { concurrentTest as test } from "./utils";

const BASE_URL = "https://app.example.com";

function createPorts(overrides: Partial<SignInPorts> = {}) {
  const calls = { login: 0 };
  const base: SignInPorts = {
    loadSession: () => Promise.resolve({ email: "user@example.com" }),
    login: () => {
      calls.login += 1;
      return Promise.resolve({ email: "fresh@example.com" });
    },
  };
  return { ports: { ...base, ...overrides }, calls };
}

function run(ports: SignInPorts, interactive = true) {
  return ensureSignedIn({
    baseUrl: BASE_URL,
    interactive,
    reporter: noopBaseReporter,
    ports,
  });
}

describe("ensureSignedIn", () => {
  test("does not sign in when a session already exists", async () => {
    const { ports, calls } = createPorts();

    const session = await run(ports);

    expect(session).toEqual({ email: "user@example.com" });
    expect(calls.login).toBe(0);
  });

  test("signs in inline when there is no session", async () => {
    const { ports, calls } = createPorts({
      loadSession: () => Promise.resolve(null),
    });

    const session = await run(ports);

    expect(session).toEqual({ email: "fresh@example.com" });
    expect(calls.login).toBe(1);
  });

  test("treats a stored token the server rejects as signed out", async () => {
    const { ports, calls } = createPorts({
      loadSession: () => Promise.reject(new Error("401 Unauthorized")),
    });

    const session = await run(ports);

    expect(session).toEqual({ email: "fresh@example.com" });
    expect(calls.login).toBe(1);
  });

  test("throws a not_signed_in_noninteractive CliError without a terminal", async () => {
    const { ports, calls } = createPorts({
      loadSession: () => Promise.resolve(null),
    });

    let caught: unknown;
    try {
      await run(ports, false);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).code).toBe("not_signed_in_noninteractive");
    expect((caught as CliError).message).toBe(notSignedInMessage(BASE_URL));
    expect(calls.login).toBe(0);
  });

  test("a valid session needs no terminal", async () => {
    const { ports, calls } = createPorts();

    await run(ports, false);

    expect(calls.login).toBe(0);
  });
});
