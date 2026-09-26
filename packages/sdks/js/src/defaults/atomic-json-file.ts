import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

const ensureFilePermissions = (filePath: string) => {
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Best effort only; some platforms may not support chmod semantics.
  }
};

/**
 * Writes `data` as pretty-printed JSON to `filePath` atomically: serialize to
 * a pid+timestamp-suffixed temp file in the same directory, then rename it
 * over the target so a concurrent reader never observes a partially-written
 * file. Creates the parent directory if it doesn't exist yet, and
 * best-effort restricts both the temp file and the final path to
 * owner-read/write (0o600). Shared by `auth-file.ts`'s `writeAuthFile` and
 * `config-file.ts`'s `writeConfigFile` — the dance is identical for both.
 */
// `data` is intentionally opaque: this helper only serializes and
// atomically writes, it never inspects the shape of what it's given.
// eslint-disable-next-line local/no-unknown-parameter-type
export function writeJsonFileAtomically(filePath: string, data: unknown): void {
  const parentDirectory = dirname(filePath);
  if (!existsSync(parentDirectory)) {
    mkdirSync(parentDirectory, { recursive: true });
  }

  const temporaryPath = `${filePath}.${String(process.pid)}.${String(Date.now())}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  ensureFilePermissions(temporaryPath);
  renameSync(temporaryPath, filePath);
  ensureFilePermissions(filePath);
}
