import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resolveHomeDir } from "./home-dir";

const legacyBareAuthFilePath = () => join(resolveHomeDir(), ".boboddy");
const legacyJsonAuthFilePath = () => join(resolveHomeDir(), ".boboddy.json");

// eslint-disable-next-line local/no-unknown-parameter-type
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * One-time, idempotent: if either new file is still missing, find the old
 * combined file (`.boboddy.json`, falling back to the even older bare
 * `.boboddy`), split it, and delete it. Safe to call redundantly from both
 * `auth-file.ts` and `config-file.ts` — whichever loads first does the work;
 * the other's own `existsSync` check on its own new path short-circuits.
 *
 * Only checks the outer shape of `profiles`/`anonymousId`/`telemetryDisabled`
 * (object / string / boolean) before handing them off — it deliberately does
 * not deep-validate individual profiles the way `auth-file.ts`'s
 * `isAuthFile` does on every read. That deeper check already runs the next
 * time `auth.jsonc` is loaded (corrupt/invalid content there already falls
 * back to empty, same as today), so duplicating it here would only catch
 * corruption one call earlier, at the cost of this module importing
 * `auth-file.ts`'s validation — which it must not do, since both
 * `auth-file.ts` and `config-file.ts` import this module and must not import
 * each other.
 */
export function migrateLegacyConfigIfNeeded(input: {
  authFileExists: () => boolean;
  configFileExists: () => boolean;
  writeAuthFile: (profiles: Record<string, unknown>) => void;
  writeConfigFile: (fields: {
    anonymousId?: string;
    telemetryDisabled?: boolean;
  }) => void;
}): void {
  if (input.authFileExists() && input.configFileExists()) return;

  const legacyPath = existsSync(legacyJsonAuthFilePath())
    ? legacyJsonAuthFilePath()
    : legacyBareAuthFilePath();
  if (!existsSync(legacyPath) || !lstatSync(legacyPath).isFile()) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(legacyPath, "utf8"));
  } catch {
    return;
  }
  if (!isPlainObject(parsed)) return;

  // Delete the legacy file(s) BEFORE writing the new ones: the bare
  // `~/.boboddy` legacy path is the exact same path as the new `~/.boboddy/`
  // directory that `auth.jsonc`/`config.jsonc` live under, so writing first
  // (which `mkdirSync`s `~/.boboddy/`) would collide with the still-present
  // legacy file and throw `ENOTDIR`. `.boboddy.json` doesn't have this
  // problem — it's a sibling path, not the same one — but deleting first is
  // correct and just as safe for it too, since `parsed` is already captured.
  rmSync(legacyPath, { force: true });
  const otherLegacyPath =
    legacyPath === legacyJsonAuthFilePath()
      ? legacyBareAuthFilePath()
      : legacyJsonAuthFilePath();
  if (existsSync(otherLegacyPath) && lstatSync(otherLegacyPath).isFile()) {
    rmSync(otherLegacyPath, { force: true });
  }

  if (!input.authFileExists()) {
    const profiles = parsed["profiles"];
    input.writeAuthFile(isPlainObject(profiles) ? profiles : {});
  }
  if (!input.configFileExists()) {
    const anonymousId = parsed["anonymousId"];
    const telemetryDisabled = parsed["telemetryDisabled"];
    input.writeConfigFile({
      anonymousId: typeof anonymousId === "string" ? anonymousId : undefined,
      telemetryDisabled:
        typeof telemetryDisabled === "boolean" ? telemetryDisabled : undefined,
    });
  }
}
