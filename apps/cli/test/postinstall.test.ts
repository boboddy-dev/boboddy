import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

const projectRoot = resolve(import.meta.dir, "..");
const postinstallSrc = resolve(projectRoot, "bin/postinstall.js");

const PACKAGE_NAME = "@boboddy/cli-linux-x64";
const BINARY_NAME = "boboddy-linux-x64";
const VERSION = "0.0.0-test";

interface SpawnResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Build a fake `@boboddy/cli` install root: package.json + bin/postinstall.js. */
function makeFakeProjectRoot(): string {
  const root = mkdtempSync(resolve(tmpdir(), "boboddy-postinstall-"));
  writeFileSync(resolve(root, "package.json"), JSON.stringify({ name: "@boboddy/cli", version: VERSION }));
  mkdirSync(resolve(root, "bin"), { recursive: true });
  cpSync(postinstallSrc, resolve(root, "bin/postinstall.js"));
  return root;
}

/**
 * Async spawn — not spawnSync. The fake registry server below runs in this
 * same process; spawnSync would block this process's event loop until the
 * child exits, so the child's requests back to that in-process server would
 * never get a response (deadlock until the child's own request timeout).
 */
function runPostinstall(root: string, env?: NodeJS.ProcessEnv): Promise<SpawnResult> {
  return new Promise((promiseResolve) => {
    const child = spawn(process.execPath, [resolve(root, "bin/postinstall.js")], {
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("close", (code) => promiseResolve({ stdout, stderr, exitCode: code ?? 1 }));
  });
}

/**
 * Build a minimal (single-block-header, no long-name/pax extensions) ustar
 * entry for `path` with the given `contents`. Matches exactly the subset of
 * fields postinstall.js's extractTarEntry reads (name, size, typeflag).
 */
function tarEntry(path: string, contents: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(path, 0, "utf8");
  header.write(contents.length.toString(8).padStart(11, "0"), 124, "utf8");
  header[156] = "0".charCodeAt(0); // regular file
  const paddedContents = Buffer.concat([
    contents,
    Buffer.alloc((512 - (contents.length % 512)) % 512),
  ]);
  return Buffer.concat([header, paddedContents]);
}

function buildFixtureTarballGz(binaryContents: Buffer): Buffer {
  const tar = Buffer.concat([
    tarEntry("package/package.json", Buffer.from(JSON.stringify({ name: PACKAGE_NAME, version: VERSION }))),
    tarEntry(`package/bin/${BINARY_NAME}`, binaryContents),
    Buffer.alloc(1024), // two 512-byte zero blocks mark end-of-archive
  ]);
  return gzipSync(tar);
}

/** A tiny fake registry serving just the one package/version this test needs. */
function startFakeRegistry(tarballGz: Buffer): Promise<{ server: Server; url: string }> {
  return new Promise((promiseResolve) => {
    const server = createServer((req, res) => {
      if (req.url === `/${PACKAGE_NAME}/${VERSION}`) {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ dist: { tarball: `http://127.0.0.1:${String(port)}/tarball.tgz` } }));
        return;
      }
      if (req.url === "/tarball.tgz") {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(tarballGz);
        return;
      }
      res.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      promiseResolve({ server, url: `http://127.0.0.1:${String(port)}/` });
    });
  });
}

describe("bin/postinstall.js", () => {
  const cleanupRoots: string[] = [];
  const cleanupServers: Server[] = [];

  afterEach(() => {
    for (const root of cleanupRoots.splice(0)) rmSync(root, { recursive: true, force: true });
    for (const server of cleanupServers.splice(0)) server.close();
  });

  test("does nothing when the optional platform package already resolved", async () => {
    const root = makeFakeProjectRoot();
    cleanupRoots.push(root);
    mkdirSync(resolve(root, "node_modules", PACKAGE_NAME, "bin"), { recursive: true });
    writeFileSync(resolve(root, "node_modules", PACKAGE_NAME, "bin", BINARY_NAME), "already installed");
    writeFileSync(
      resolve(root, "node_modules", PACKAGE_NAME, "package.json"),
      JSON.stringify({ name: PACKAGE_NAME, version: VERSION }),
    );

    const result = await runPostinstall(root, { BOBODDY_PLATFORM: "linux", BOBODDY_ARCH: "x64" });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  test("skips silently for an unsupported platform/arch", async () => {
    const root = makeFakeProjectRoot();
    cleanupRoots.push(root);

    const result = await runPostinstall(root, { BOBODDY_PLATFORM: "freebsd", BOBODDY_ARCH: "arm64" });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  test("skips silently when BOBODDY_DIST_DIR overrides to a dev build", async () => {
    const root = makeFakeProjectRoot();
    cleanupRoots.push(root);

    const result = await runPostinstall(root, {
      BOBODDY_DIST_DIR: root,
      BOBODDY_PLATFORM: "linux",
      BOBODDY_ARCH: "x64",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  test("downloads the binary directly from the registry when the optional dependency is missing", async () => {
    const root = makeFakeProjectRoot();
    cleanupRoots.push(root);
    const binaryContents = Buffer.from("#!/bin/sh\necho fixture binary\n");
    const { server, url } = await startFakeRegistry(buildFixtureTarballGz(binaryContents));
    cleanupServers.push(server);

    const result = await runPostinstall(root, {
      BOBODDY_PLATFORM: "linux",
      BOBODDY_ARCH: "x64",
      npm_config_registry: url,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("recovered");
    const written = readFileSync(resolve(root, "dist", BINARY_NAME));
    expect(written.equals(binaryContents)).toBe(true);
  });

  test("fails loudly (non-zero exit) when the registry is unreachable and no rescue is possible", async () => {
    const root = makeFakeProjectRoot();
    cleanupRoots.push(root);

    const result = await runPostinstall(root, {
      BOBODDY_PLATFORM: "linux",
      BOBODDY_ARCH: "x64",
      // Nothing listening here — every attempt fails immediately.
      npm_config_registry: "http://127.0.0.1:1/",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("fallback download also failed");
    expect(result.stderr).toContain("npm install -g @boboddy/cli --force");
  });
});
