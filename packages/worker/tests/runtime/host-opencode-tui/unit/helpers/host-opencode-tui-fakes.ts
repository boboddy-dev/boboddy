/**
 * Shared fakes for the host OpenCode TUI unit tests.
 *
 * Nothing here downloads a binary or spawns a real process: the payload cache is
 * pre-seeded on disk with a stub binary (so `ensure()` takes its cache-hit path)
 * and `spawn` is replaced by a recording fake.
 */
import { EventEmitter } from "node:events";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  OPENCODE_RUNTIME_VERSION,
  PAYLOAD_FORMAT_REVISION,
  type PayloadPlatform,
} from "../../../../../src/runtime/runtime-service/domain/opencode-runtime-payload";
import type { SpawnFn } from "../../../../../src/runtime/host-opencode-tui/infra/host-opencode-tui-launcher";

/** Recorded arguments of a faked spawn call. */
export type SpawnCall = {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: string;
};

/** A ChildProcess stand-in: an EventEmitter plus a recording `kill`. */
export class FakeChildProcess extends EventEmitter {
  killSignals: (NodeJS.Signals | number | undefined)[] = [];
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    return true;
  }
}

export type SpawnFake = {
  spawnFn: SpawnFn;
  calls: SpawnCall[];
  children: FakeChildProcess[];
};

/** Build a recording `spawn` seam plus the fake children it produced. */
export function makeSpawnFake(): SpawnFake {
  const calls: SpawnCall[] = [];
  const children: FakeChildProcess[] = [];
  const spawnFn: SpawnFn = (command, args, options) => {
    calls.push({
      command,
      args,
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio,
    });
    const child = new FakeChildProcess();
    children.push(child);
    return child as unknown as ChildProcess;
  };
  return { spawnFn, calls, children };
}

/**
 * Write a payload that `OpencodeRuntimePayloadProvisioner.ensure()` accepts as
 * valid for the pinned version, so no download is attempted. Returns the
 * payload dir.
 */
export async function seedHostPayload(
  homeDir: string,
  platforms: readonly PayloadPlatform[],
): Promise<string> {
  const payloadDir = path.join(
    homeDir,
    ".boboddy",
    "runtimes",
    "opencode",
    OPENCODE_RUNTIME_VERSION,
  );
  for (const platform of platforms) {
    const binDir = path.join(payloadDir, "bin", platform);
    await mkdir(binDir, { recursive: true });
    const binary = path.join(binDir, "opencode");
    await writeFile(binary, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(binary, 0o755);
  }
  await writeFile(
    path.join(payloadDir, "launch.sh"),
    "#!/bin/sh\nexit 0\n",
    "utf8",
  );
  await writeFile(
    path.join(payloadDir, "manifest.json"),
    JSON.stringify({
      version: OPENCODE_RUNTIME_VERSION,
      platforms: [...platforms],
      provisionedAt: new Date().toISOString(),
      formatRevision: PAYLOAD_FORMAT_REVISION,
    }),
    "utf8",
  );
  return payloadDir;
}

/** Run `action` and return the error it threw, or `undefined` if it resolved. */
export async function captureError(
  action: () => Promise<unknown>,
): Promise<Error | undefined> {
  try {
    await action();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}
