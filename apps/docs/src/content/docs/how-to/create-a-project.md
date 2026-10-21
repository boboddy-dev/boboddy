---
title: Create a project
description: Create a project from its git repository URL and choose where its issues come from
---

A project is one git repository plus the work items Boboddy runs pipelines
on. You create one at **Projects → New project**. `boboddy init` sends you to
the same page, with your repository already filled in, when it can't create
the project for you (see [`boboddy init`](/boboddy/reference/cli/#boboddy-init)).

The page has three steps: **Repository**, **Details** and **Issues**.

## 1. Repository

Paste the repository's git URL. Any form you'd pass to `git clone` works:
`https://github.com/acme/api`, `git@github.com:acme/api.git`, or
`ssh://git@bitbucket.org/team/api.git`.

As you type, Boboddy shows which host it found:

| Host           | Detected from                                                        | Issue tracking on offer        |
| -------------- | -------------------------------------------------------------------- | ------------------------------ |
| GitHub         | `github.com/<owner>/<repo>`                                          | GitHub App, GitHub token, Jira |
| Bitbucket      | `bitbucket.org/<workspace>/<repo>`                                   | Bitbucket token, Jira          |
| Other git host | anything else, including GitHub Enterprise and Bitbucket Data Center | Jira                           |

If one of your projects already uses the repository, Boboddy says so and links
to it. You can still create another.

Workers clone this URL with their own git setup. The tokens on the Issues step
are used only to read issues and post comments, never to clone.

## 2. Details

The name defaults to the repository's name. Change it and add a description if
you like.

## 3. Issues

Pick where this project's work items come from. The choices depend on the
host:

- **GitHub App** (GitHub, recommended): issues sync on their own, instantly.
  If the App already covers the repository you're ready to create. If not,
  **Install the GitHub App** takes you to GitHub and brings you back to this
  step. Installing needs admin rights on the repository or organization. If you
  don't have them, use a token instead.
- **GitHub token** (GitHub): your own personal access token. See
  [Connect GitHub with a token](/boboddy/how-to/integrations/#connect-github-with-a-token).
- **Bitbucket token** (Bitbucket): your Atlassian email and API token. See
  [Bitbucket](/boboddy/how-to/integrations/#bitbucket).
- **Jira** (any host): a Jira site URL, project keys and your Jira API key. See
  [Jira](/boboddy/how-to/integrations/#jira).
- **Skip for now**: create the project with no issue tracker. Connect one later
  under **Project → Settings → Integrations**, or create work items by hand.

For a token, click **Check and continue**. Boboddy checks the token can read
this repository (or Jira site) before anything is created, so a token that
doesn't work never leaves a half-made project behind.

Click **Create project**. Boboddy creates the project, connects the tracker
and imports the first batch of issues. If that first import fails, the project
and its integration are still created; retry with **Sync now** in the project's
settings.

## Save the token, or not

Under every token field is a checkbox, **Securely save this token to my API
keys**. It's checked by default.

- **Saved**: Boboddy saves the token only after the check passes. It's
  encrypted, you can't view it again, and it appears under **Account settings →
  API keys**, where you can rename or delete it. Give it a name and set its
  expiry date to the one GitHub or Atlassian shows. Bitbucket and Jira tokens
  always expire; a GitHub token can be set to **No expiry**.
- **Not saved**: Boboddy uses the token to check the repository, create the
  project and run the first import, then keeps nothing.

Either way, a token-based integration is **manual only**. Nothing syncs on a
schedule, because there's no one's key to use. Each **Sync now**, and each
comment approval that posts to the tracker, asks which key to use. A saved key
is a click; without one, you paste a token each time. If you chose not to save,
the work items page reminds you once, with a link to save a token.

If you already have saved keys of the right kind, the Issues step lists them
first. Pick one, or choose **Use a new token**.
