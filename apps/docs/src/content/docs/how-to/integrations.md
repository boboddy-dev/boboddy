---
title: Connect GitHub, Bitbucket or Jira
description: Connect GitHub, Bitbucket or Jira so incoming issues become work items
---

An integration keeps work items flowing into a project without anyone creating
them by hand. You usually pick one on the **Issues** step when you
[create a project](/boboddy/how-to/create-a-project/). You can also connect one
later from **Project → Settings → Integrations**, which every project has,
including one created with **Skip for now**.

The GitHub App is the recommended path: issue changes reach Boboddy instantly,
in the background, for as long as the integration is connected. Everything
else (a GitHub token, Bitbucket, Jira) uses your own token, so it syncs only
when you ask it to.

Every work item has a top-level `state`, either `open` or `closed`, that
tracks whether the source issue is still open. Each integration maps its own
lifecycle onto it (see the tables below). Work items you create by hand start
`open`, and you can set `state` through the API.

## GitHub

There are two ways to connect a GitHub repository: the GitHub App, or your own
personal access token. Both create the same work items.

### Connect the GitHub App

Connecting GitHub installs a GitHub App on your account or organization,
rather than an OAuth login. You'll be sent to GitHub to approve it, choosing
**All repositories** or **Selected repositories** on GitHub's own installation
screen. When you're creating a project, Boboddy links the repository you
entered. From **Settings → Integrations → Connect GitHub**, Boboddy lets you
pick which of the repos that installation covers to link into this project.

Installing needs admin rights on the repository or organization. If you don't
have them, ask an admin to install it, or
[use a token](#connect-github-with-a-token).

Once linked, GitHub sends Boboddy a webhook whenever an issue changes, so work
items update within seconds:

|                 |                                                                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cadence         | Instant, via webhooks — an issue being opened, edited, closed, reopened, labeled, unlabeled, assigned, or unassigned updates its work item right away |
| Backstop        | A daily sync catches anything a webhook missed                                                                                                        |
| First sync      | Looks back 180 days                                                                                                                                   |
| What's ingested | Issues only — pull requests are filtered out                                                                                                          |

Each GitHub issue maps to a work item like this:

| Work item field                      | Source                                                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `title`                              | Issue title                                                                                               |
| `description`                        | Issue body (or a placeholder if empty)                                                                    |
| `url`                                | Issue URL                                                                                                 |
| `state`                              | `closed` when the issue is closed, otherwise `open`. Closing or reopening the issue updates it right away |
| `fields.state`, `fields.stateReason` | GitHub's raw issue state and close reason. GitHub issues have no separate status or issue-type concept    |
| `fields.labels`, `fields.assignees`  | Issue labels and assignees                                                                                |

:::tip[No repos to pick from?]
If the installation was granted access to zero repos (or not the one you
wanted), add it on GitHub's side first — from the installation's settings, or
by reconnecting and choosing more repos — then connect again.
:::

### Connect GitHub with a token

A personal access token connects one repository with your own GitHub access,
with no App to install. Use it when you can't install the App. The trade-off:
it's **manual only**. There are no webhooks or daily sync; issues arrive when
someone clicks **Sync now**, and each sync asks for a token.

1. Click **Create a GitHub token** in Boboddy. It opens GitHub's fine-grained
   token form with the name, the longest expiry (366 days), the repository's
   owner, and **Metadata** read and **Issues** read & write already filled in:
   - Under **Repository access**, choose **Only select repositories** and pick
     this repository. GitHub can't pre-select it for you.
   - Prefer a **classic token**? Create one on your
     [GitHub tokens page](https://github.com/settings/tokens) with the `repo`
     scope.
   - Your organization may need to approve a fine-grained token, or you may
     need to authorize a classic one for SSO, before it can see the repository.
2. Choose **GitHub token** on the **Issues** step of a new project, or
   **Connect GitHub with a token** under **Settings → Integrations**.
3. Paste the token, decide whether to
   [save it](/boboddy/how-to/create-a-project/#save-the-token-or-not), and
   click **Check and continue** (or **Check and connect**).

Boboddy checks the token against this repository only. If GitHub says no, the
error says whether the token was rejected or just can't see the repository,
and nothing is created or saved. Issues map to work items the same way as
with the App.

## Bitbucket

Bitbucket Cloud repositories (`bitbucket.org`) connect with an Atlassian API
token, using the repository's own Bitbucket issue tracker. App passwords and
Bitbucket Data Center aren't supported. Like any token-based integration, it's
**manual only**: every **Sync now** asks for a token, and nothing syncs on a
schedule.

1. On your
   [Atlassian API tokens page](https://id.atlassian.com/manage-profile/security/api-tokens),
   choose **Create API token with scopes**, pick Bitbucket, and give it these
   scopes:
   - `read:repository:bitbucket`
   - `read:issue:bitbucket`
   - `write:issue:bitbucket`
   - `read:user:bitbucket`
2. Choose **Bitbucket token** on the **Issues** step of a new project, or
   **Connect Bitbucket** under **Settings → Integrations**.
3. Enter your Atlassian account email and the token, decide whether to
   [save it](/boboddy/how-to/create-a-project/#save-the-token-or-not), and
   click **Check and continue** (or **Check and connect**).

If the repository's issue tracker is turned off, Boboddy says so and offers
Jira instead. Many Bitbucket teams track their work there.

|             |                                    |
| ----------- | ---------------------------------- |
| Cadence     | Manual: **Sync now**               |
| First sync  | Looks back 180 days                |
| Later syncs | Issues updated since the last sync |

Each Bitbucket issue maps to a work item like this:

| Work item field                                      | Source                                                                                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`                                              | Issue title                                                                                                                                 |
| `description`                                        | Issue content (or a placeholder if empty)                                                                                                   |
| `url`                                                | Issue URL                                                                                                                                   |
| `state`                                              | `open` when the issue is `new`, `open` or `on hold`; `closed` for any other state (`resolved`, `closed`, `invalid`, `duplicate`, `wontfix`) |
| `fields.state`, `fields.kind`, `fields.priority`     | Bitbucket's own issue state, kind (bug, task, …) and priority                                                                               |
| `fields.reporter`, `fields.assignee`, `fields.votes` | Display names and vote count                                                                                                                |

## Jira

Jira works with a repository on any host. Connecting it takes a base URL and
one or more project keys — there's no install flow or app to authorize. Choose
**Jira** on the **Issues** step of a new project (which also asks for a key, to
check the site and run the first sync), or **Connect Jira** under **Settings →
Integrations**. The integration doesn't store an email or token: each person
who syncs or posts to Jira uses their own Jira API key. Because of that, it's
**manual only**: every sync asks for a key, and nothing syncs on a schedule.
If you want work items to keep arriving without you clicking anything, the
GitHub App is the integration that does that — Jira is better suited to an
occasional pull.

### Save a Jira API key

1. Create an API token on your
   [Atlassian API tokens page](https://id.atlassian.com/manage-profile/security/api-tokens).
2. In Boboddy, open **Account settings → API keys** and fill in **Add Jira API
   key**: a name (for example `Work Jira`), your Atlassian email (for example
   `user@example.com`), the token, and an expiry date.
3. Set the expiry date to the date Atlassian shows for the token, then click
   **Save API key**.

Saved keys are encrypted. You can't view a key again after saving it; the list
shows only its last four characters, its email, its expiry, and when it was
last used. You can rename or delete a key from the same page.

GitHub tokens and Bitbucket API tokens are saved the same way, with **Add
GitHub token** and **Add Bitbucket API token** on the same page, or straight
from the token form when you connect.

### Use a key

When you click **Sync now** on a Jira integration, or approve a comment that
will be posted to Jira, Boboddy asks which key to use. GitHub token and
Bitbucket integrations work the same way. The key you used most
recently is picked by default, or your newest key if you haven't used any.

To use a key you haven't saved, choose **Paste a key instead** and enter your
Atlassian email and API token. A pasted key is used only for that request and
is never stored.

### Expiry

Atlassian tokens always expire, so every saved key has an expiry date that
should match the token's. A key is marked **Expiring soon** when it expires in
14 days or less. Once it has expired it can't be used: it's greyed out in the
picker, and you'll need to create a new token and save it as a new key.

Jira issues carry more structure than GitHub's, since Jira has real
status/issue-type fields:

| Work item field                                        | Source                                                                            |
| ------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `title`                                                | Issue summary                                                                     |
| `description`                                          | Issue description (converted from Jira's rich-text format)                        |
| `url`                                                  | Issue URL                                                                         |
| `state`                                                | `closed` when the issue's status is in Jira's **Done** category, otherwise `open` |
| `fields.status`, `fields.issueType`, `fields.priority` | Jira's own fields. `fields.status` is the status name, such as `In Review`        |
| `fields.*` (custom)                                    | Any Jira custom fields, resolved to their human-readable names                    |

:::note[Older Jira issues]
Jira syncs only pick up issues updated since the last sync. A work item synced
before `state` existed stays `open` until its Jira issue is next updated, even
if that issue is already Done.
:::

## Choosing between them

|                                 | GitHub App                                | GitHub token                                                  | Bitbucket                              | Jira                                            |
| ------------------------------- | ----------------------------------------- | ------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------- |
| Repo host                       | GitHub                                    | GitHub                                                        | Bitbucket Cloud                        | Any                                             |
| Setup                           | Install a GitHub App (needs admin rights) | Paste a personal access token                                 | Paste an Atlassian email and API token | Enter base URL, project keys and a Jira API key |
| Sync                            | Automatic and instant, via webhooks       | Manual — click **Sync now** and pick a saved key or paste one | Manual                                 | Manual                                          |
| Status/issue-type on work items | No (open/closed only)                     | No (open/closed only)                                         | Kind and priority, no workflow status  | Yes                                             |

Nothing stops you connecting more than one to the same project — issues from any
land as work items and route through the same
[default pipeline assignment](/boboddy/guides/pipeline-assignment/).
