---
title: Setting up a Dev Container
description: Generate a minimal .devcontainer/devcontainer.json for your project using an AI prompt
---

`boboddy work` spins up a single Docker container from your project's `.devcontainer/devcontainer.json` for every step execution, and runs the OpenCode agent **inside that same container** (from a Boboddy-managed mounted runtime payload). So your devcontainer is the one and only runtime — it must contain the language toolchain your steps need, but it does **not** need OpenCode installed; Boboddy mounts and launches its own pinned OpenCode runtime.

This page provides a prompt you can paste into any AI coding assistant (Claude, Copilot, etc.) to generate a minimal, project-appropriate devcontainer config.

:::tip[You probably don't need this page]
If your project has no `.devcontainer/devcontainer.json`, the [pipeline designer](/boboddy/reference/cli/#boboddy-pipelines-design-projectid) writes one for you during a design session, based on the repository it just read. `boboddy init` reports a missing devcontainer as a notice and carries on. This page is for writing one by hand, or for understanding what the agent produced.
:::

:::note[Exception]
Steps with `executionMode: "no_workspace"` run without a clone or a dev container, so a project that only uses those steps does not need a `devcontainer.json`. See [Execution mode](/boboddy/guides/steps/#execution-mode).
:::

:::caution[No build happens in-session]
The agent authors the config but never builds the image — your first pipeline run is what verifies it. If that run fails early, suspect the container before the pipeline.
:::

## AI prompt

Prefer a design session. If you want to generate one outside Boboddy instead, copy the prompt below and run it in your project's root directory. The AI will inspect your codebase and output a `.devcontainer/devcontainer.json` (and a `Dockerfile` if needed).

````
You are helping me create a minimal `.devcontainer/devcontainer.json` for this project so it can be used as a Boboddy worker execution environment.

**Your goal:** produce the smallest devcontainer config that gives the execution environment everything it needs — nothing more.

**Step 1 — Analyse the codebase**

Examine the following files (read whichever exist):

- `package.json` / `bun.lock` / `yarn.lock` / `pnpm-lock.yaml` — runtime, package manager, scripts
- `Dockerfile` / `docker-compose.yml` — existing base image choices
- `.nvmrc` / `.node-version` / `.tool-versions` — pinned runtimes
- `pyproject.toml` / `requirements.txt` / `Pipfile` — Python deps
- `go.mod` — Go version
- `Cargo.toml` — Rust toolchain
- `*.sln` / `*.csproj` — .NET version
- Any CI config (`.github/workflows/`, `.circleci/`, etc.) — look for `uses: actions/setup-*` or `apt-get install` lines

**Step 2 — Determine the environment**

From your analysis, identify:

1. **Primary runtime** and its minimum required version (e.g. Node 20, Python 3.11, Go 1.22)
2. **Package manager** (npm / yarn / pnpm / bun / pip / cargo / go)
3. **System packages** genuinely required at runtime (not just for local dev convenience)
4. **Any secrets or environment variables** the code reads — note them as comments; do not hardcode values

**Step 3 — Choose a base**

- Prefer an official [Dev Container base image](https://mcr.microsoft.com/en-us/artifact/mar/devcontainers/) that matches the primary runtime.
- If the project already has a `Dockerfile`, use it as the base (`"build": { "dockerfile": "../Dockerfile" }`).
- Only write a custom `Dockerfile` if no suitable base image exists.

**Step 4 — Write the config**

Output:

1. `.devcontainer/devcontainer.json` — include only the fields you actually need:
   - `name` — short human-readable name
   - `image` or `build` — base image or Dockerfile path
   - `features` — Dev Container Features for any additional tooling (e.g. git, docker-in-docker). Use the `ghcr.io/devcontainers/features/` namespace. Omit features already present in the base image.
   - `containerEnv` — environment variables that must be set (use placeholder values like `"${localEnv:MY_SECRET}"` for secrets)
   - `onCreateCommand` — dependency install command if needed (e.g. `npm ci`, `pip install -r requirements.txt`)
   - `remoteUser` — set to a non-root user if the base image provides one

2. If you wrote a custom `Dockerfile`, output it as `.devcontainer/Dockerfile`.

**Rules:**
- Do NOT include VS Code-specific fields (`customizations`, `extensions`, `settings`) — this container is used for headless agent execution, not interactive development.
- Do NOT add tools "just in case" — every layer adds startup latency.
- Do NOT hard-code secret values.
- If the project needs to run Docker commands (e.g. it builds or runs containers itself), prefer the `docker-outside-of-docker` feature (`ghcr.io/devcontainers/features/docker-outside-of-docker`) over `docker-in-docker` — it mounts the host Docker socket rather than running a nested daemon, which is faster and uses less memory.
- Prefer `onCreateCommand` for install steps over baking dependencies into a custom image, unless the install is very slow.
- Add a short comment above each non-obvious field explaining why it is there.

Output the file(s) using code fences with the file path as the language identifier, for example:

````.devcontainer/devcontainer.json
{ ... }
````

After the file output, add a **"Why"** section (plain prose, ≤ 150 words) explaining your base image choice and any non-obvious decisions.
````

## What to do with the output

1. Create a `.devcontainer/` directory at your project root if it doesn't exist.
2. Write the generated `devcontainer.json` (and optional `Dockerfile`) into that directory.
3. Commit both files.
4. Test locally by running `boboddy work --once` — the worker will pull the image and report any missing tools in its logs.

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| `boboddy work` fails with "image not found" | Base image name is wrong or private — check `docker pull <image>` manually |
| Agent can't find the package manager | Add an `onCreateCommand` to install deps, or use a `features` entry |
| Container starts but step fails with missing binary | A system package or runtime tool is absent — add it via `features` or a custom `Dockerfile` |
| Execution is slow | The `onCreateCommand` runs on every job; move stable deps into the image |
