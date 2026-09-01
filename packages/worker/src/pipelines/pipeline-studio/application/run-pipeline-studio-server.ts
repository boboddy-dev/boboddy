// The local server behind `boboddy pipelines studio`: `Bun.serve` (this
// repo's first real usage — see the phase report's judgment-call notes)
// serving the built `@boboddy/pipeline-studio-ui` static assets, plus one SSE
// endpoint (`/api/stream`) that pushes a fresh `StudioSnapshot` (see
// `compute-studio-snapshot.ts`) every time `.boboddy/pipeline-builder`
// changes on disk.
//
// Watches with Node's built-in `fs.watch` rather than adding `chokidar` as a
// new direct dependency: `chokidar` already appears in `bun.lock`, but only
// as a TRANSITIVE dependency of unrelated tools (`@astrojs/check`, `c12`),
// never a direct dependency of any workspace package — so using it here
// would still be a brand-new direct dependency, and the builder directory
// this watches is flat (`collect-definitions.ts`'s own `readdirSync` never
// recurses), which is exactly the case `fs.watch` handles without caveats.
import { existsSync, watch } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { computeStudioSnapshot } from "./compute-studio-snapshot";
import { COLLECT_SCRIPT_FILENAME } from "../infra/collect-script";
import type { StudioSnapshot } from "@boboddy/pipeline-studio-ui";

const DEBOUNCE_MS = 150;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

export type PipelineStudioServerHandle = {
  /** The local URL the browser should be opened to. */
  readonly url: string;
  /** Stops the file watcher and the HTTP server. */
  close(): Promise<void>;
};

export type RunPipelineStudioServerOptions = {
  /** Absolute path to `.boboddy/pipeline-builder`. */
  builderDir: string;
  /** Fixed port, or omit to let the OS pick a free one. */
  port?: number;
};

/**
 * Resolves `@boboddy/pipeline-studio-ui`'s own `dist/` directory. Two cases:
 *
 * - Inside a compiled binary (`Bun.isStandaloneExecutable`): there's no
 *   `node_modules` to resolve against. `apps/cli`'s `bun build --compile`
 *   step embeds that `dist/` via `--asset=`, and `import.meta.dir` collapses
 *   to the same bundle root (`/$bunfs/root`) for every module in a compiled
 *   binary, not just the entrypoint — so `join(import.meta.dir, "dist")`
 *   finds it regardless of how deep this file lives inside `packages/worker`.
 * - Otherwise (source checkout / `bun run`): normal package resolution via
 *   `@boboddy/pipeline-studio-ui/package.json`, which requires that package
 *   to expose `"./package.json"` in its `exports` map — see its
 *   `package.json`.
 */
function resolveStaticDir(): string {
  if (Bun.isStandaloneExecutable) {
    return join(import.meta.dir, "dist");
  }
  const pkgJsonPath = Bun.resolveSync(
    "@boboddy/pipeline-studio-ui/package.json",
    import.meta.dir,
  );
  return join(dirname(pkgJsonPath), "dist");
}

/** Guards against `../` escaping `staticDir`, however unlikely from a fixed asset set. */
function resolveStaticAsset(staticDir: string, pathname: string): string | null {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const resolved = resolve(staticDir, relative);
  if (resolved !== staticDir && !resolved.startsWith(staticDir + sep)) {
    return null;
  }
  return resolved;
}

function serveStaticAsset(staticDir: string, pathname: string): Response {
  const filePath = resolveStaticAsset(staticDir, pathname);
  if (!filePath || !existsSync(filePath)) {
    return new Response(
      "Not found. Run `bun run --filter @boboddy/pipeline-studio-ui build` " +
        "first if you're running this from a source checkout.",
      { status: 404 },
    );
  }
  const contentType = CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream";
  return new Response(Bun.file(filePath), {
    headers: { "Content-Type": contentType },
  });
}

/** One connected browser tab's SSE stream. */
type SseClient = {
  enqueue(bytes: Uint8Array): void;
};

function encodeSnapshot(snapshot: StudioSnapshot): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(snapshot)}\n\n`);
}

function buildStreamResponse(
  currentSnapshot: () => StudioSnapshot,
  clients: Set<SseClient>,
): Response {
  let client: SseClient | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      client = {
        enqueue: (bytes) => {
          controller.enqueue(bytes);
        },
      };
      clients.add(client);
      controller.enqueue(encodeSnapshot(currentSnapshot()));
    },
    cancel() {
      if (client) clients.delete(client);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

/**
 * Starts the studio's HTTP server and file watcher. Runs one immediate
 * `computeStudioSnapshot` before returning, so the very first browser
 * request already has real content instead of an empty "connecting" state.
 */
export async function runPipelineStudioServer(
  options: RunPipelineStudioServerOptions,
): Promise<PipelineStudioServerHandle> {
  const { builderDir } = options;
  const staticDir = resolveStaticDir();
  const clients = new Set<SseClient>();

  let snapshot = await computeStudioSnapshot(builderDir);

  function broadcast(): void {
    const bytes = encodeSnapshot(snapshot);
    for (const client of clients) client.enqueue(bytes);
  }

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  // The collect script (compiled-binary mode only) is written at most once
  // per builderDir, idempotent-if-missing — see
  // `collect-definitions-via-subprocess.ts`. Without this guard, that
  // one-time write would still fire this watcher and trigger one harmless
  // but wasteful extra recompute; `filename === null` (platform-dependent)
  // is treated as "always recompute" rather than skipped, since it can't be
  // attributed to the collect script specifically.
  const watcher = watch(builderDir, { persistent: true }, (_event, filename) => {
    if (filename === COLLECT_SCRIPT_FILENAME) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      void computeStudioSnapshot(builderDir).then((next) => {
        snapshot = next;
        broadcast();
      });
    }, DEBOUNCE_MS);
  });

  const server = Bun.serve({
    port: options.port ?? 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/stream") {
        return buildStreamResponse(() => snapshot, clients);
      }
      return serveStaticAsset(staticDir, pathname);
    },
  });

  return {
    url: `http://localhost:${String(server.port)}`,
    close: async () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      watcher.close();
      await server.stop(true);
    },
  };
}
