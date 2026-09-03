import { rm, mkdir, symlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";

const projectRoot = new URL("..", import.meta.url).pathname.replace(/\/$/u, "");

// BOBODDY_CLI_LINK_NAME lets callers (e.g. scripts/cli-link-dev.sh) link under
// an alternate bin name such as "boboddy-dev", so a dev build doesn't clobber
// a real "boboddy" install on the same machine. Defaults to "boboddy" for the
// plain `cli:link` production flow.
const linkName = process.env["BOBODDY_CLI_LINK_NAME"] ?? "boboddy";
const pkgDirName =
  linkName === "boboddy"
    ? "cli"
    : `cli-${linkName.replace(/^boboddy-/u, "")}`;

const npmPrefix = execFileSync("npm", ["prefix", "-g"], {
  encoding: "utf8",
  stdio: ["inherit", "pipe", "inherit"],
}).trim();

const scopeDir = join(npmPrefix, "lib", "node_modules", "@boboddy");
const pkgLink = join(scopeDir, pkgDirName);
const binDir = join(npmPrefix, "bin");
const binLink = join(binDir, linkName);

await mkdir(scopeDir, { recursive: true });

await rm(pkgLink, { force: true, recursive: true });
await symlink(projectRoot, pkgLink);

await rm(binLink, { force: true });
// Match npm's relative symlink style: bin/<linkName> -> ../lib/node_modules/@boboddy/<pkgDirName>/bin/boboddy
await symlink(relative(binDir, join(pkgLink, "bin", "boboddy")), binLink);

process.stdout.write(`Linked: ${binLink}\n`);
