/**
 * The well-known-server health check catalog.
 *
 * A user designing a pipeline with a Playwright or Postgres MCP server gets a
 * `healthChecks` entry written into their own step file — without knowing
 * this feature exists, and without being asked. `design-agent-assets.ts`
 * renders this catalog into the composed authoring reference as a generated
 * section, the same way `PIPELINE_ARCHETYPES` is spliced in.
 *
 * A regular (typechecked) module, unlike the archetypes: this is structured
 * data the render function consumes, not prose the agent copies verbatim, so
 * it needs none of the `.ts.tmpl` / `with { type: "text" }` machinery that
 * exists solely to smuggle raw text past `apps/cli/tsconfig.json`.
 *
 * `packageHint` is a package **name**, never a literal, runnable command.
 * There is no single correct invocation — the shipped Playwright system
 * template pins an exact version and a base-image-specific
 * `--executable-path`, and the repo already holds divergent real invocations
 * elsewhere (its own OpenCode config, that system template). A literal here
 * would add a fifth and would rot the moment it stopped matching whichever
 * base image a step actually runs in. `caveats` is where the
 * environment-specific parts that a literal would hide actually live.
 *
 * Growing this catalog beyond these two entries, and hosting it in the SDK
 * for reuse by other consumers, are both out of scope — see boboddy-platform
 * issue #122. This stays local to the designer templates with one consumer.
 */
export type HealthCheckCatalogEntry = {
  /** Stable identifier; also the example step's filename stem. */
  readonly id: string;
  /** Human label used as the rendered example's heading. */
  readonly label: string;
  /**
   * The package to launch — a hint, not a literal command. See `caveats` for
   * what varies by execution environment.
   */
  readonly packageHint: string;
  /**
   * The `mcpServers` key this kind of server is conventionally declared
   * under, and the value the rendered example's `healthChecks[].mcp` names.
   */
  readonly mcp: string;
  /** Bare tool name (unqualified; `mcp` supplies the qualifier at runtime). */
  readonly tool: string;
  /** Arguments for the safe-by-construction call this entry proves works. */
  readonly args: Record<string, unknown>;
  /** Prose caveats: the environment-specific parts a literal command would hide. */
  readonly caveats: string;
};

/**
 * The same two servers the runtime's hardcoded health check registry used to
 * cover before it was deleted (#121) — its entries moved here. Both are safe
 * by construction: one navigates to a blank page, the other lists schema
 * names — neither touches user data or state.
 */
export const HEALTH_CHECK_CATALOG: readonly HealthCheckCatalogEntry[] = [
  {
    id: "playwright",
    label: "Playwright (browser automation)",
    packageHint: "@playwright/mcp",
    mcp: "playwright",
    tool: "browser_navigate",
    args: { url: "about:blank" },
    caveats:
      "Needs a Chromium binary reachable inside the execution environment. " +
      "The shipped Playwright system template pins an exact version and " +
      "passes `--executable-path` for its own base image — copy neither " +
      "verbatim; match both to whatever image this step actually runs in. " +
      "Add `--headless` for a `workspace` step with no display.",
  },
  {
    id: "postgres",
    label: "Postgres (read-only database access)",
    packageHint: "postgres-mcp",
    mcp: "postgres",
    tool: "list_schemas",
    args: {},
    caveats:
      "Launched with `uvx`, not `npx` — it is a Python package. Needs a " +
      "real connection string on the server's `environment`, referenced as " +
      "`{env:VAR}`; never inline a connection string as a health check " +
      "argument or write it into the command.",
  },
];
