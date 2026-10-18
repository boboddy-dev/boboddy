import type { BoboddyClient } from "../generated";
import { parseProjectRef } from "./project-config";

export interface ResolvedProjectRef {
  id: string;
  owner: string;
  slug: string;
}

export type ProjectRefErrorKind =
  "invalid" | "not_found" | "forbidden" | "unauthenticated" | "failed";

/**
 * A failure to turn `owner/slug` into a project. The message names the ref and
 * the denied action, never a UUID, so it can be shown as-is.
 */
export class ProjectRefError extends Error {
  public constructor(
    public readonly kind: ProjectRefErrorKind,
    public readonly ref: string,
    message: string,
  ) {
    super(message);
    this.name = "ProjectRefError";
  }
}

export interface ResolveProjectRefOptions {
  headers: { Authorization: string };
  /**
   * What the caller is about to do, phrased to complete "You don't have
   * permission to …" — e.g. `"push pipelines to"`, `"run work for"`.
   * Defaults to `"view"`.
   */
  action?: string;
}

export const PROJECT_REF_FORMAT_HINT =
  'Expected "<owner>/<project-slug>", e.g. "acme/web-app".';

/**
 * Resolves a `owner/slug` project ref to its id via
 * `GET /api/projects/resolve`. Every command that takes a project calls this
 * once, up front, and passes the id downstream.
 */
export async function resolveProjectRef(
  client: BoboddyClient,
  ref: string,
  { headers, action = "view" }: ResolveProjectRefOptions,
): Promise<ResolvedProjectRef> {
  const parsed = parseProjectRef(ref);
  if (!parsed) {
    throw new ProjectRefError(
      "invalid",
      ref,
      `"${ref}" is not a valid project. ${PROJECT_REF_FORMAT_HINT}`,
    );
  }

  const { data, error, response } = await client.projects.resolveProjectBySlug({
    query: { username: parsed.owner, slug: parsed.slug },
    headers,
  });

  if (data) {
    return { id: data.id, owner: parsed.owner, slug: parsed.slug };
  }

  const status = response.status;
  if (status === 404) {
    throw new ProjectRefError(
      "not_found",
      ref,
      `No project ${ref}. Check "project" in .boboddy/boboddy.jsonc — the owner may have renamed their username.`,
    );
  }
  if (status === 403) {
    throw new ProjectRefError(
      "forbidden",
      ref,
      `You don't have permission to ${action} ${ref}.`,
    );
  }
  if (status === 401) {
    throw new ProjectRefError(
      "unauthenticated",
      ref,
      `Not signed in, so ${ref} can't be looked up. Run \`boboddy auth login\` first.`,
    );
  }
  const detail =
    (error as { detail?: string; title?: string } | undefined)?.detail ??
    (error as { title?: string } | undefined)?.title ??
    `HTTP ${String(status)}`;
  throw new ProjectRefError(
    "failed",
    ref,
    `Could not look up project ${ref}: ${detail}`,
  );
}
