import {
  resolveProjectRef,
  type ResolvedProjectRef,
} from "@boboddy/sdk/defaults";
import { readProjectConfig } from "@boboddy/worker";
import { connectApi } from "./cli-api-client";

/**
 * Every command that takes a project — `work`, `pipelines push`/`pull`/`design`
 * — accepts it as `owner/slug` (positional, or `"project"` in
 * `.boboddy/boboddy.jsonc`) and resolves it to the project id here, once, before
 * doing anything else. Failures throw a `ProjectRefError` that names the ref
 * and the denied action (see `resolveProjectRef` in `@boboddy/sdk/defaults`).
 */

/** Completes "You don't have permission to …" for each command. */
export const PROJECT_ACTIONS = {
  work: "run work for",
  push: "push pipelines to",
  pull: "pull pipelines from",
  design: "design pipelines for",
} as const;

export type ProjectAction =
  (typeof PROJECT_ACTIONS)[keyof typeof PROJECT_ACTIONS];

export const NO_PROJECT_MESSAGE =
  'No project provided. Pass one as `owner/slug` or run `boboddy init` to write "project" to .boboddy/boboddy.jsonc.';

/** The positional ref when given, else `"project"` from `.boboddy/boboddy.jsonc`. */
export async function pickProjectRef(
  argument: string | undefined,
  rootDir?: string,
): Promise<string | undefined> {
  const fromArgument = argument?.trim() ?? "";
  if (fromArgument.length > 0) {
    return fromArgument;
  }
  return (await readProjectConfig(rootDir))?.project;
}

/** Resolve `ref` against `baseUrl` with the signed-in session. */
export async function resolveCliProjectRef(input: {
  baseUrl: string;
  ref: string;
  action: ProjectAction;
}): Promise<ResolvedProjectRef> {
  const { client, headers } = await connectApi(input.baseUrl);
  return resolveProjectRef(client, input.ref, {
    headers,
    action: input.action,
  });
}
