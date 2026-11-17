---
name: repo-changes
description: Clone a repository with the person's connected GitHub account, make a change on a relay/ branch, verify it, and open or update a pull request when they asked for one.
---

# Repo changes

Use this skill only when the person actually asks for a repository change. Do not use it merely because a message mentions GitHub, a report, analytics, or another unrelated use of a trigger word.

## Workflow

1. Open a read-only clone of the repository with `github_clone` and `repo: "owner/name"`. It returns a clone URL and the exact path to clone into.
2. Clone with ordinary git in this conversation's working folder:
   `git clone <cloneUrl> <path>`
   The URL can fetch but cannot push. Never copy a token or put one in a remote URL.
3. Read the repository's `CLAUDE.md` and `README.md`, then follow them. Follow repository-specific instructions. The standard Relay workflow permits local commits on `relay/*` branches and publishing a PR when the person asks for one. If repository instructions require additional maintainer approval, respect them unless the person explicitly overrides them.
4. Create a branch:
   `git switch -c relay/<slug>`
   On a follow-up in the same conversation, reuse the existing clone and the same `relay/<slug>` branch. Fetch the remote branch and commit on top of it; do not create a worktree or a new branch unless the history diverged or the PR was closed or merged.
5. Edit files with your normal file tools. Run the repository's lint, typecheck, and build checks. If a database-backed test cannot run, run what can run, state exactly what was not run, and do not claim a successful build proves database tests passed.
6. For user-visible web changes, start the repository's development server, open the page with the browser tools, and capture before/after screenshots or a short screen recording. Save them outside the clone in this conversation's working folder, then attach each one with `attach_file`. Keep the returned `fileId` values.
7. Commit locally only:
   `git add -A && git commit -m "<message>"`
   Do not run `git push`. It has no GitHub credential and will fail.
8. Publish only when the person asked for a pull request or explicitly approved publication. Do not publish for an investigation-only request, and do not publish when the person asked to keep the change local.
   `github_open_pull_request` with the repo, `relay/<slug>` branch, PR title and body, the repository path returned by `github_clone`, and the `fileId` values from `attach_file`.
   Never use `gh`, `git push`, or the GitHub API directly to create or edit a pull request. `github_open_pull_request` is the only path for the PR body and screenshots.
9. Relay pushes only the exact commit and opens or updates the pull request. Never merge it.

## Pull-request body

Include:

- what changed and why
- the checks that ran and their real results
- any check that could not run
- a short visual-review note for UI changes

The broker stores the attached before/after images or recording on the repository's `relay-evidence` branch and links them in the PR body. The same images are already attached in the Relay conversation, so the person can review them in both places. Do not edit or delete the `relay-evidence` branch.

Never push to `main`, `master`, or `production`. Never force-push, delete a branch, or merge. If a repository needs a `.github/workflows` edit, call it out explicitly in the pull-request body.
