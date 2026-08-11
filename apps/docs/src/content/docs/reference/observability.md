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
run and stored in `~/.boboddy.json` (alongside, not inside, your credentials).
Once you sign in, later events switch to your account id, and PostHog links
the two so the whole funnel counts toward you.

## `boboddy telemetry`

Manage the CLI's observability reporting.

### `boboddy telemetry status`

Show whether observability reporting is currently enabled.

```bash
boboddy telemetry status
```

### `boboddy telemetry disable`

Turn off observability reporting for every future invocation. Persisted in `~/.boboddy.json`.

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
