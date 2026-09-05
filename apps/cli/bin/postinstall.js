#!/usr/bin/env node

/**
 * Runs as @boboddy/cli's own "postinstall" lifecycle script (see
 * script/publish.ts's prepareMainPackage, which wires this up and copies this
 * file into the published package verbatim — like bin/boboddy, this is plain
 * CommonJS, not compiled, so it can't import script/targets.ts at runtime).
 *
 * Why this exists: the platform binary (@boboddy/cli-<platform>-<arch>) is an
 * npm optionalDependency of the main package (see targets.ts / publish.ts's
 * module doc for why). optionalDependencies are, by design, allowed to fail
 * npm's install without failing the overall `npm install` command — that's
 * the whole point of the "optional" in the name. That's fine for a package
 * providing a nice-to-have; it is NOT fine here, because the platform binary
 * is the entire CLI. A single dropped connection fetching that ~90MB package
 * (far more likely on a fresh CI runner or a flaky network than a checksum
 * mismatch) used to leave `npm install -g @boboddy/cli` reporting success —
 * exit code 0 — with a broken install, and the user finding out only when
 * they ran `boboddy` and hit bin/boboddy's "Missing compiled binary" error,
 * possibly minutes or commits later.
 *
 * This script closes that gap: it verifies the platform package actually
 * resolves right after install, and if it doesn't, downloads the tarball
 * directly from the registry (bypassing npm — no child `npm install`, so this
 * can't recurse into another lifecycle run) and extracts just the compiled
 * binary into dist/, the same monolithic-layout path bin/boboddy already
 * falls back to. If that recovery also fails (registry unreachable, disk
 * full, etc.) this script exits non-zero, which — unlike a skipped
 * optionalDependency — DOES fail `npm install`, immediately and loudly,
 * instead of deferring the failure to first run.
 *
 * Skipped entirely (exit 0, no network call) when BOBODDY_DIST_DIR is set
 * (dev build) or the platform/arch has no compiled target at all (unsupported
 * platform — bin/boboddy already reports that clearly when actually run).
 */

const { mkdirSync, renameSync, writeFileSync, chmodSync } = require("node:fs");
const { resolve } = require("node:path");
const { gunzipSync } = require("node:zlib");
const http = require("node:http");
const https = require("node:https");

const cliName = "boboddy";
const projectRoot = resolve(__dirname, "..");
const distDirectory = resolve(projectRoot, "dist");

// Keep in sync with apps/cli/script/targets.ts (CLI_BUILD_TARGETS) and
// bin/boboddy's own copies of these two maps.
const binaryNames = {
  "darwin:arm64": `${cliName}-darwin-arm64`,
  "darwin:x64": `${cliName}-darwin-x64`,
  "linux:arm64": `${cliName}-linux-arm64`,
  "linux:x64": `${cliName}-linux-x64`,
  "win32:x64": `${cliName}-windows-x64.exe`,
};
const platformPackageNames = {
  "darwin:arm64": "@boboddy/cli-darwin-arm64",
  "darwin:x64": "@boboddy/cli-darwin-x64",
  "linux:arm64": "@boboddy/cli-linux-arm64",
  "linux:x64": "@boboddy/cli-linux-x64",
  "win32:x64": "@boboddy/cli-win32-x64",
};

const MAX_DOWNLOAD_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;

function registryBaseUrl() {
  const configured = process.env["npm_config_registry"];
  const raw = configured && configured.length > 0 ? configured : "https://registry.npmjs.org/";
  return raw.endsWith("/") ? raw : `${raw}/`;
}

/**
 * GET `url` and resolve with the full response body as a Buffer. Picks
 * node:http or node:https based on the URL's own scheme (rather than always
 * using https) so this also works against a plain-http private registry
 * mirror, same as npm's own registry client does.
 */
function get(url, redirectsLeft) {
  const client = new URL(url).protocol === "http:" ? http : https;
  return new Promise((promiseResolve, promiseReject) => {
    const request = client.get(url, { timeout: REQUEST_TIMEOUT_MS }, (response) => {
      const { statusCode = 0, headers } = response;

      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        response.resume(); // discard body
        if (redirectsLeft <= 0) {
          promiseReject(new Error(`Too many redirects fetching ${url}`));
          return;
        }
        promiseResolve(get(new URL(headers.location, url).toString(), redirectsLeft - 1));
        return;
      }

      if (statusCode < 200 || statusCode >= 300) {
        response.resume(); // discard body
        promiseReject(new Error(`Unexpected status ${statusCode} fetching ${url}`));
        return;
      }

      /** @type {Buffer[]} */
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => promiseResolve(Buffer.concat(chunks)));
      response.on("error", promiseReject);
    });

    request.on("timeout", () => request.destroy(new Error(`Timed out fetching ${url}`)));
    request.on("error", promiseReject);
  });
}

async function getWithRetry(url) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      return await get(url, MAX_REDIRECTS);
    } catch (error) {
      lastError = error;
      if (attempt < MAX_DOWNLOAD_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
      }
    }
  }
  throw lastError;
}

/**
 * Extract a single file's contents from an uncompressed USTAR/GNU tar
 * archive. Good enough here because the platform packages this fetches are
 * two files (package.json + the one binary) with short (<100 byte) names —
 * no pax/long-name extension headers to worry about — and pulling in a tar
 * library just for this one-file rescue path isn't worth the extra
 * dependency in a script that has to work with zero installed deps.
 */
function extractTarEntry(tarBuffer, entryName) {
  let offset = 0;
  while (offset + 512 <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break; // end-of-archive marker

    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/su, "");
    const sizeField = header.subarray(124, 136).toString("utf8").replace(/\0.*$/su, "").trim();
    const size = Number.parseInt(sizeField, 8) || 0;
    const dataStart = offset + 512;

    if (name === entryName) {
      return tarBuffer.subarray(dataStart, dataStart + size);
    }

    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return undefined;
}

/**
 * Fetch `packageName@version`'s tarball directly from the registry and pull
 * just `bin/<binaryName>` out of it, writing the result to
 * `distDirectory/<binaryName>` — the same path bin/boboddy's monolithic-dist
 * fallback layout already checks, so no change to bin/boboddy is needed to
 * pick this up.
 */
async function downloadPlatformBinary(packageName, binaryName, version) {
  const metadataUrl = `${registryBaseUrl()}${packageName}/${version}`;
  const metadataJson = await getWithRetry(metadataUrl);
  const metadata = JSON.parse(metadataJson.toString("utf8"));
  const tarballUrl = metadata?.dist?.tarball;

  if (typeof tarballUrl !== "string" || tarballUrl.length === 0) {
    throw new Error(`Registry response for ${packageName}@${version} had no dist.tarball`);
  }

  const tarballGz = await getWithRetry(tarballUrl);
  const tarBuffer = gunzipSync(tarballGz);
  const binaryContents = extractTarEntry(tarBuffer, `package/bin/${binaryName}`);

  if (binaryContents === undefined) {
    throw new Error(`package/bin/${binaryName} not found in ${tarballUrl}`);
  }

  mkdirSync(distDirectory, { recursive: true });
  // Write-then-rename so a process interrupted mid-write can never leave a
  // truncated binary at the final path — the one failure mode this whole
  // script exists to close off.
  const finalPath = resolve(distDirectory, binaryName);
  const tempPath = `${finalPath}.download-${String(process.pid)}`;
  writeFileSync(tempPath, binaryContents);
  chmodSync(tempPath, 0o755);
  renameSync(tempPath, finalPath);
  return finalPath;
}

async function main() {
  if (process.env["BOBODDY_DIST_DIR"]) {
    return; // Dev build / explicit override — nothing to verify.
  }

  const platform = process.env["BOBODDY_PLATFORM"] ?? process.platform;
  const arch = process.env["BOBODDY_ARCH"] ?? process.arch;
  const targetKey = `${platform}:${arch}`;
  const binaryName = binaryNames[targetKey];
  const packageName = platformPackageNames[targetKey];

  if (binaryName === undefined || packageName === undefined) {
    return; // Unsupported platform — bin/boboddy reports this clearly at run time.
  }

  try {
    require.resolve(`${packageName}/bin/${binaryName}`);
    return; // Optional platform dependency installed cleanly — nothing to do.
  } catch {
    // Fall through to the rescue download below.
  }

  process.stdout.write(
    `@boboddy/cli: optional dependency ${packageName} did not install (this can happen after ` +
      "a network blip); downloading its binary directly as a fallback...\n",
  );

  const version = require("../package.json").version;

  try {
    await downloadPlatformBinary(packageName, binaryName, version);
    process.stdout.write(`@boboddy/cli: recovered — ${binaryName} downloaded successfully.\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `@boboddy/cli: failed to install the ${platform}/${arch} binary (${packageName}), and ` +
        `the fallback download also failed: ${message}\n` +
        "Try again — e.g. `npm install -g @boboddy/cli --force` — once you have a stable " +
        "network connection.\n",
    );
    process.exitCode = 1;
  }
}

void main();
