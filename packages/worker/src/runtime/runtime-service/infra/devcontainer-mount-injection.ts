import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ConfigurationError } from "../../../lib/errors";
import { parseDevcontainerConfigContent } from "./local-devcontainer-jsonc";

/**
 * Injects bind mounts into a CLONED devcontainer.json BEFORE `devcontainers-cli
 * up`. Parses the config using the full JSONC-aware parser (handles `//` and
 * block comments inside string values correctly), merges the mounts, and
 * rewrites the file. The cloned config is ephemeral, so mutating it never
 * touches the user repo.
 *
 * The devcontainer spec's top-level `mounts` array is honored by the CLI for
 * the `image` and `build` (Dockerfile) config variants, which is exactly the
 * set of variants `patchDevcontainerEnv` already supports via `containerEnv`.
 *
 * The `dockerComposeFile` variant is NOT supported here: the devcontainer spec
 * ignores top-level `mounts` for compose-based configs (mounts must be declared
 * on the compose service instead). Per the migration plan's "devcontainers-cli
 * up mount injection" medium risk, we fail fast with a clear error rather than
 * silently dropping the runtime payload mount — a missing payload mount would
 * make OpenCode unlaunchable inside the container.
 *
 * Conflict handling: a user-defined mount that targets the same container path
 * as a Boboddy mount is a hard error (we refuse to silently shadow or duplicate
 * a target), surfaced as a {@link ConfigurationError}.
 */

/** A single bind mount to inject (host source -> container target). */
export type DevcontainerBindMount = {
  /** Absolute host path. */
  source: string;
  /** Absolute container path. */
  target: string;
  /** When true, the mount is read-only. */
  readOnly?: boolean | undefined;
};

const DEVCONTAINER_COMPOSE_KEY = "dockerComposeFile";

/** Render a bind mount as the devcontainer/Docker long-form mount string. */
export function renderBindMountString(mount: DevcontainerBindMount): string {
  const parts = [
    "type=bind",
    `source=${mount.source}`,
    `target=${mount.target}`,
  ];
  if (mount.readOnly) {
    parts.push("readonly");
  }
  return parts.join(",");
}

/** Extract the container target from a long-form mount string, if present. */
function mountTargetOf(value: string): string | null {
  for (const segment of value.split(",")) {
    const [key, ...rest] = segment.split("=");
    if (key === "target" || key === "destination" || key === "dst") {
      return rest.join("=").trim() || null;
    }
  }
  return null;
}

/** Container targets already declared in an existing `mounts` array entry. */
function existingMountTargets(mounts: unknown[]): Set<string> {
  const targets = new Set<string>();
  for (const entry of mounts) {
    if (typeof entry === "string") {
      const target = mountTargetOf(entry);
      if (target) {
        targets.add(target);
      }
    } else if (
      typeof entry === "object" &&
      entry !== null &&
      "target" in entry &&
      typeof (entry as { target?: unknown }).target === "string"
    ) {
      targets.add((entry as { target: string }).target);
    }
  }
  return targets;
}

/**
 * Merge the given bind mounts into the cloned devcontainer.json's top-level
 * `mounts` array. Throws for the unsupported `dockerComposeFile` variant and on
 * conflicting user-defined mount targets.
 */
export async function patchDevcontainerMounts(
  workspacePath: string,
  devcontainerConfigPath: string,
  mounts: readonly DevcontainerBindMount[],
): Promise<void> {
  if (mounts.length === 0) {
    return;
  }

  const configAbsPath = path.join(workspacePath, devcontainerConfigPath);
  const raw = await readFile(configAbsPath, "utf8");
  const parsed = parseDevcontainerConfigContent(raw) as Record<string, unknown>;

  if (DEVCONTAINER_COMPOSE_KEY in parsed) {
    throw new ConfigurationError(
      "Boboddy cannot inject the OpenCode runtime mount into a " +
        "docker-compose-based devcontainer (the devcontainer spec ignores " +
        "top-level `mounts` for `dockerComposeFile` configs). Use an `image` " +
        "or Dockerfile (`build`) based devcontainer for in-container OpenCode " +
        "execution.",
      "DEVCONTAINER_COMPOSE_MOUNT_UNSUPPORTED",
    );
  }

  const existing = Array.isArray(parsed["mounts"])
    ? (parsed["mounts"] as unknown[])
    : [];
  const existingTargets = existingMountTargets(existing);

  for (const mount of mounts) {
    if (existingTargets.has(mount.target)) {
      throw new ConfigurationError(
        `The devcontainer already defines a mount at '${mount.target}', which ` +
          "conflicts with a Boboddy-managed runtime mount. Remove the " +
          "conflicting mount from your devcontainer.json.",
        "DEVCONTAINER_MOUNT_CONFLICT",
      );
    }
  }

  parsed["mounts"] = [
    ...existing,
    ...mounts.map((mount) => renderBindMountString(mount)),
  ];

  await writeFile(configAbsPath, JSON.stringify(parsed, null, 2), "utf8");
}

/**
 * Inject an `appPort` host:container port publish into the cloned
 * devcontainer.json BEFORE `up`, so the in-container OpenCode HTTP server is
 * reachable from the host worker over loopback. Like {@link patchDevcontainerMounts}
 * this is only valid for `image`/`build` variants; compose configs ignore
 * `appPort` (the same medium-risk constraint applies) and throw.
 *
 * Merges with any user-defined `appPort` (string or array) without clobbering.
 */
export async function patchDevcontainerAppPort(
  workspacePath: string,
  devcontainerConfigPath: string,
  publish: { hostPort: number; containerPort: number },
): Promise<void> {
  const configAbsPath = path.join(workspacePath, devcontainerConfigPath);
  const raw = await readFile(configAbsPath, "utf8");
  const parsed = parseDevcontainerConfigContent(raw) as Record<string, unknown>;

  if (DEVCONTAINER_COMPOSE_KEY in parsed) {
    throw new ConfigurationError(
      "Boboddy cannot publish the OpenCode runtime port for a " +
        "docker-compose-based devcontainer (the devcontainer spec ignores " +
        "`appPort` for `dockerComposeFile` configs). Use an `image` or " +
        "Dockerfile (`build`) based devcontainer for in-container OpenCode.",
      "DEVCONTAINER_COMPOSE_APP_PORT_UNSUPPORTED",
    );
  }

  const publishSpec = `127.0.0.1:${String(publish.hostPort)}:${String(
    publish.containerPort,
  )}`;

  const current = parsed["appPort"];
  const existing: (string | number)[] = Array.isArray(current)
    ? (current as (string | number)[])
    : current === undefined
      ? []
      : [current as string | number];

  parsed["appPort"] = [...existing, publishSpec];

  await writeFile(configAbsPath, JSON.stringify(parsed, null, 2), "utf8");
}

/**
 * Inject additional `docker run` arguments into the cloned devcontainer.json's
 * `runArgs` array BEFORE `up`. Used to add `--add-host=host.docker.internal:host-gateway`
 * so the in-container OpenCode can reach the host over `host.docker.internal`.
 *
 * macOS/Windows Docker Desktop provide this alias natively, but on Linux it does
 * not resolve inside the container unless the container is started with an
 * explicit host-gateway alias. `runArgs` is honored by the devcontainer CLI for
 * `image`/`build` variants (compose configs ignore it — the same medium-risk
 * constraint as mounts/appPort applies) and throws for the compose variant.
 *
 * Idempotent: an arg already present in `runArgs` is not duplicated.
 */
export async function patchDevcontainerRunArgs(
  workspacePath: string,
  devcontainerConfigPath: string,
  runArgs: readonly string[],
): Promise<void> {
  if (runArgs.length === 0) {
    return;
  }

  const configAbsPath = path.join(workspacePath, devcontainerConfigPath);
  const raw = await readFile(configAbsPath, "utf8");
  const parsed = parseDevcontainerConfigContent(raw) as Record<string, unknown>;

  if (DEVCONTAINER_COMPOSE_KEY in parsed) {
    throw new ConfigurationError(
      "Boboddy cannot inject Docker run args for a docker-compose-based " +
        "devcontainer (the devcontainer spec ignores `runArgs` for " +
        "`dockerComposeFile` configs). Use an `image` or Dockerfile (`build`) " +
        "based devcontainer for in-container OpenCode execution.",
      "DEVCONTAINER_COMPOSE_RUN_ARGS_UNSUPPORTED",
    );
  }

  const existing = Array.isArray(parsed["runArgs"])
    ? (parsed["runArgs"] as unknown[]).filter(
        (value): value is string => typeof value === "string",
      )
    : [];

  const merged = [...existing];
  for (const arg of runArgs) {
    if (!merged.includes(arg)) {
      merged.push(arg);
    }
  }

  parsed["runArgs"] = merged;

  await writeFile(configAbsPath, JSON.stringify(parsed, null, 2), "utf8");
}
