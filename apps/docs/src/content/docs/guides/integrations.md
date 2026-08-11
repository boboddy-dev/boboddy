---
title: Integrations
description: Connect GitHub or Jira so incoming issues become work items automatically
---

An integration keeps work items flowing into a project without anyone creating
them by hand. Connect one from **Project → Settings → Integrations** — every
project has this panel, however it was created, so you can link one later even
if you started with a manually-created project.

GitHub is the recommended path: it syncs continuously, in the background,
forever. Jira works too, but only syncs when you ask it to.

## GitHub

Connecting GitHub installs a GitHub App on your account or organization,
rather than an OAuth login — you'll be sent to GitHub to approve it, choosing
**All repositories** or **Selected repositories** on GitHub's own installation
screen. Boboddy then lets you pick which of the repos that installation covers
to link into this project.

Once linked, Boboddy syncs on a schedule — no webhook, just a poll:

| | |
|---|---|
| Cadence | Every 15 minutes, automatically, for as long as the integration is connected |
| First sync | Looks back 180 days |
| What's ingested | Issues only — pull requests are filtered out |

Each GitHub issue maps to a work item like this:

| Work item field | Source |
|---|---|
| `title` | Issue title |
| `description` | Issue body (or a placeholder if empty) |
| `url` | Issue URL |
| `fields.state` | `open` / `closed` — GitHub issues have no separate status or issue-type concept |
| `fields.labels`, `fields.assignees` | Issue labels and assignees |

:::tip[No repos to pick from?]
If the installation was granted access to zero repos (or not the one you
wanted), add it on GitHub's side first — from the installation's settings, or
by reconnecting and choosing more repos — then connect again.
:::

## Jira

Connecting Jira takes a base URL, an email, and one or more project keys —
there's no install flow or app to authorize. Because of that, it's **manual
only**: every sync prompts for an API key, which is used once and never
stored, and nothing syncs on a schedule. If you want work items to keep
arriving without you clicking anything, GitHub is the integration that does
that — Jira is better suited to an occasional pull.

Jira issues carry more structure than GitHub's, since Jira has real
status/issue-type fields:

| Work item field | Source |
|---|---|
| `title` | Issue summary |
| `description` | Issue description (converted from Jira's rich-text format) |
| `url` | Issue URL |
| `fields.status`, `fields.issueType`, `fields.priority` | Jira's own fields |
| `fields.*` (custom) | Any Jira custom fields, resolved to their human-readable names |

## Choosing between them

| | GitHub | Jira |
|---|---|---|
| Setup | Install a GitHub App | Enter base URL, email, project keys |
| Sync | Automatic, every 15 minutes | Manual — click "Sync now", re-enter API key each time |
| Status/issue-type on work items | No (open/closed only) | Yes |

Nothing stops you connecting both to the same project — issues from either
land as work items and route through the same
[default pipeline assignment](/boboddy/guides/pipeline-assignment/).
