import { stripGitUrlCredentials } from "@boboddy/sdk/git-url";

/**
 * Builds the `/projects/new` URL `init` opens for the browser hand-off (#141).
 *
 * `gitUrl` and `name` mirror `ManualCreateForm`'s own field names on the web
 * app, so the same values that would otherwise need retyping there arrive
 * pre-filled. This does not force the manual form open — the GitHub-picker
 * default is untouched — it only seeds it for whichever path the user picks.
 * `source=cli` tags the resulting project as `origin: "cli_handoff"` in the
 * `project_created` funnel event. Any credential in the remote is stripped:
 * the URL is opened in a browser and lands in its history.
 */
export function buildProjectsNewUrl(input: {
  baseUrl: string;
  gitUrl: string;
  suggestedName: string;
}): string {
  const url = new URL("/projects/new", input.baseUrl);
  url.searchParams.set("gitUrl", stripGitUrlCredentials(input.gitUrl));
  url.searchParams.set("name", input.suggestedName);
  url.searchParams.set("source", "cli");
  return url.toString();
}
