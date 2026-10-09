---
title: Observability
description: What the CLI reports, why, and how to opt out
---

The CLI reports a small set of onboarding milestones so we can see
where new users get stuck. Each event carries only the milestone name, an
anonymous or account id, and non-identifying properties (for example, whether
a project was newly linked or already existed). It **never** includes your
access token, email, or name as event data; those are only ever sent, once,
via a separate identify call after you sign in, to connect your pre- and
post-login events.

Before you're signed in, events are keyed to a random id generated on first
run and stored in `~/.boboddy/config.jsonc` (alongside, not inside, your
credentials, which live in `~/.boboddy/auth.jsonc`).
Once you sign in, later events switch to your account id, and PostHog links
the two so the whole funnel counts toward you.

## Events the CLI sends

These are every event the CLI reports, and every property each one carries.
Nothing else is sent.

| Event | When | Properties |
| --- | --- | --- |
| `cli_init_started` | `boboddy init` starts | none |
| `cli_requirements_verified` | `init` confirms you're signed in and inside a git repository | none |
| `cli_auth_completed` | A browser sign-in (device login) completes | none |
| `cli_project_linked` | `init` links the repository to a project | `linked`: `new` or `existing`; for `new`, `via`: `api` (created by `init` from your GitHub repo) or `browser` (created by you on the web) |
| `cli_provider_connect_started` | `boboddy pipelines design` finds no AI provider connected and hands you OpenCode's provider menu | `detected`: which AI tools are installed, by name only (`claude`, `codex`, `copilot`; empty when none) |
| `cli_provider_connect_completed` | An AI provider is connected after that menu closes | `providers`: the connected provider names (for example `anthropic`) |
| `cli_designer_launched` | `boboddy pipelines design` hands the terminal to the designer | `providers`: the provider names the session can run on |
| `cli_studio_opened` | The live pipeline graph starts, from `pipelines design` or `pipelines studio` | `via`: `design` or `studio`; `browser_opened`: whether a browser tab was opened automatically |
| `cli_dry_run_passed` | A dry run of a pipeline step passes | `via`: `work` or `pipelines-design` |
| `cli_pipeline_pushed` | `boboddy pipelines push` succeeds | none |
| `cli_run_queued` | The designer's closing offer queues a run | none |
| `cli_run_offer_skipped` | The designer's closing offer ends without running | `reason`: `tui_not_clean`, `no_devcontainer`, `no_pipeline`, `dry_run_failed`, or `declined` |
| `cli_command_failed` | A command exits with an error | `command` (for example `init` or `pipelines design`) and `code` (see below) |

Every event also carries `cli_version`, `os`, `arch`, and `cli_key_source`
(`baked` for a release binary's built-in key, `env` for the `POSTHOG_CLI_KEY`
override), and nothing else.

`cli_command_failed` sends a fixed `code`, never the error message, because
messages can contain local paths or repository URLs. The codes and their
meanings are listed under
[Failure codes](/boboddy/reference/cli/#failure-codes) in the CLI reference.

## `boboddy telemetry`

Manage the CLI's observability reporting.

### `boboddy telemetry status`

Show whether observability reporting is currently enabled, then where this
build's reporting key comes from:

- `This build reports with its built-in key.` — a release binary.
- `Reporting with the POSTHOG_CLI_KEY override.` — the env var is set and
  takes precedence over any built-in key.
- `This build has no reporting key, so nothing is sent even while telemetry is enabled.`

The key itself is never printed.

```bash
boboddy telemetry status
```

With `--json`, it writes exactly one line to stdout and nothing else, so it can
be piped into `jq`:

```bash
boboddy telemetry status --json
# {"enabled":true,"keySource":"baked","version":"0.7.0"}
```

`keySource` is `baked`, `env`, or `none`. `enabled` is `false` when reporting
is turned off, either persistently or with `BOBODDY_TELEMETRY_DISABLED=1`.

### `boboddy telemetry disable`

Turn off observability reporting for every future invocation. Persisted in `~/.boboddy/config.jsonc`.

```bash
boboddy telemetry disable
```

### `boboddy telemetry enable`

Turn observability reporting back on.

```bash
boboddy telemetry enable
```

| Env var                        | Effect                                                                |
| ------------------------------- | ---------------------------------------------------------------------- |
| `BOBODDY_TELEMETRY_DISABLED=1` | Opt out for a single invocation, without persisting anything          |
| `BOBODDY_TELEMETRY_DEBUG=1`    | Print every observability payload to stderr, in addition to sending it |
