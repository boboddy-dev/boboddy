import { describe, expect, test } from "bun:test";
import {
  checkOpencodeConfigDiagnostics,
  isOverlayRejection,
  OpencodeOverlayConfigRejectedError,
  parseOpencodeConfigDiagnostics,
} from "../../../../src/runtime/runtime-service/infra/opencode-config-diagnostics";
import { SecretMasker } from "../../../../src/work/task/application/secret-masker";

const OVERLAY_INVALID =
  'timestamp=2026-10-13T10:00:00.000Z level=WARN run=abc http.span=1 message="configuration normalization diagnostic" source=OPENCODE_CONFIG_CONTENT path=model kind=invalid action=dropped detail="expected string, got sk-overlay-secret"';
const GLOBAL_INVALID =
  'timestamp=2026-10-13T10:00:01.000Z level=WARN message="configuration normalization diagnostic" source=/home/u/.config/opencode/opencode.json path=model kind=invalid action=dropped';
const OVERLAY_LEGACY =
  'timestamp=2026-10-13T10:00:02.000Z level=WARN message="configuration normalization diagnostic" source=OPENCODE_CONFIG_CONTENT path=tools kind=legacy action=migrated';

describe("parseOpencodeConfigDiagnostics", () => {
  test("extracts fields, strips volatile ones, and collapses repeats", () => {
    const log = [
      "unrelated line",
      OVERLAY_INVALID,
      OVERLAY_INVALID.replace("10:00:00", "10:00:05").replace(
        "run=abc",
        "run=def",
      ),
      GLOBAL_INVALID,
    ].join("\n");

    const diagnostics = parseOpencodeConfigDiagnostics(log);

    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toMatchObject({
      source: "OPENCODE_CONFIG_CONTENT",
      path: "model",
      kind: "invalid",
      action: "dropped",
    });
    expect(diagnostics[0]?.line).not.toContain("timestamp=");
    expect(diagnostics[0]?.line).not.toContain("run=");
    expect(diagnostics[0]?.line).not.toContain("http.span=");
    expect(diagnostics[1]?.source).toBe(
      "/home/u/.config/opencode/opencode.json",
    );
  });

  test("only an invalid overlay entry is a rejection", () => {
    const [overlayInvalid, globalInvalid, overlayLegacy] =
      parseOpencodeConfigDiagnostics(
        [OVERLAY_INVALID, GLOBAL_INVALID, OVERLAY_LEGACY].join("\n"),
      );

    expect(overlayInvalid && isOverlayRejection(overlayInvalid)).toBe(true);
    expect(globalInvalid && isOverlayRejection(globalInvalid)).toBe(false);
    expect(overlayLegacy && isOverlayRejection(overlayLegacy)).toBe(false);
  });
});

describe("checkOpencodeConfigDiagnostics", () => {
  function fakeConfigFetch(requested: string[]): typeof fetch {
    return ((url: string) => {
      requested.push(url);
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch;
  }

  const noSleep = () => Promise.resolve();

  test("forces a location-scoped config load, then fails on an overlay rejection with masked lines", async () => {
    const requested: string[] = [];

    let caught: unknown;
    try {
      await checkOpencodeConfigDiagnostics({
        baseUrl: "http://127.0.0.1:4096",
        password: "pw",
        workspaceFolder: "/workspaces/my repo",
        readLog: () => Promise.resolve(`${OVERLAY_INVALID}\n${GLOBAL_INVALID}`),
        masker: new SecretMasker(["sk-overlay-secret"]),
        fetchFn: fakeConfigFetch(requested),
        sleep: noSleep,
      });
    } catch (error) {
      caught = error;
    }

    expect(requested).toEqual([
      "http://127.0.0.1:4096/api/config?directory=%2Fworkspaces%2Fmy%20repo",
    ]);
    expect(caught).toBeInstanceOf(OpencodeOverlayConfigRejectedError);
    const message = (caught as Error).message;
    expect(message).toContain("path=model kind=invalid");
    expect(message).toContain("***");
    expect(message).not.toContain("sk-overlay-secret");
    expect(message).not.toContain("opencode.json");
  });

  test("only warns about the user's global config and legacy overlay syntax", async () => {
    const diagnostics = await checkOpencodeConfigDiagnostics({
      baseUrl: "http://127.0.0.1:4096",
      password: "pw",
      workspaceFolder: "/w",
      readLog: () => Promise.resolve(`${GLOBAL_INVALID}\n${OVERLAY_LEGACY}`),
      masker: new SecretMasker([]),
      fetchFn: fakeConfigFetch([]),
      sleep: noSleep,
    });

    expect(diagnostics.map(({ kind }) => kind)).toEqual(["invalid", "legacy"]);
  });

  test("re-reads the log until the diagnostics settle", async () => {
    const reads = ["", OVERLAY_LEGACY, `${OVERLAY_LEGACY}\n${OVERLAY_INVALID}`];
    let read = 0;

    let caught: unknown;
    try {
      await checkOpencodeConfigDiagnostics({
        baseUrl: "http://127.0.0.1:4096",
        password: "pw",
        workspaceFolder: "/w",
        readLog: () =>
          Promise.resolve(reads[Math.min(read++, reads.length - 1)] ?? ""),
        masker: new SecretMasker([]),
        fetchFn: fakeConfigFetch([]),
        sleep: noSleep,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OpencodeOverlayConfigRejectedError);
  });

  test("does not fail the launch when the config request itself fails", async () => {
    const diagnostics = await checkOpencodeConfigDiagnostics({
      baseUrl: "http://127.0.0.1:4096",
      password: "pw",
      workspaceFolder: "/w",
      readLog: () => Promise.resolve(null),
      masker: new SecretMasker([]),
      fetchFn: (() =>
        Promise.reject(new TypeError("refused"))) as unknown as typeof fetch,
      sleep: noSleep,
    });

    expect(diagnostics).toEqual([]);
  });
});
