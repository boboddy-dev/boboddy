import bundlePath from "@devcontainers/cli/dist/spec-node/devContainersSpecCLI.js" with { type: "file" };
import os from "node:os";
import path from "node:path";

console.log("bundlePath:", bundlePath);
console.log("starts with $bunfs:", bundlePath.startsWith("/$bunfs"));

const dest = path.join(os.tmpdir(), "devcontainer-compiled-test.js");
await Bun.write(dest, Bun.file(bundlePath));
console.log("written to:", dest);
console.log("size:", Bun.file(dest).size);
