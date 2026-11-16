---
name: repo-changes
description: Clone a repository with the person's connected GitHub account, make a change on a relay/ branch, verify it, and ask the person to approve publishing it as a pull request.
---

# Repo changes

Use this skill only when the person actually asks for a repository change. Do not use it merely because a message mentions a report, analytics, or another unrelated use of a trigger word.

This skill applies to Scout when the `github_git_remote` and `propose_publish` tools are available. If they are unavailable, tell the person to connect GitHub in Apps and stop. Do not try to reach GitHub through another tool.

## Workflow

1. Check that GitHub is connected. If `github_git_remote` is unavailable or refuses, stop and ask the person to connect GitHub in Apps.
2. Open a read-only transport for the repository:
   `github_git_remote` with `repo: "owner/name"`.
   It returns a clone URL and the exact path to clone into.
3. Clone with ordinary git in this conversation's working folder:
   `git clone <cloneUrl> <path>`
   The URL can fetch but cannot push. Never copy a token or put one in a remote URL.
4. Read the repository's `CLAUDE.md` and `README.md`, then follow them.
5. Create a branch:
   `git switch -c relay/<slug>`
6. Edit files with your normal file tools. Run the repository's lint, typecheck, and build checks. If a database-backed test cannot run, run what can run, state exactly what was not run, and do not claim a successful build proves database tests passed.
7. For user-visible web changes, start the repository's development server, open the page with the browser tools, and capture before/after screenshots or a short screen recording. Save them outside the clone in this conversation's working folder. Attach them to the chat with `attach_file`.
8. Commit locally only:
   `git add -A && git commit -m "<message>"`
   Do not run `git push`. It has no GitHub credential and will fail.
9. Ask the person to publish the exact commit:
   `propose_publish` with the repo, `relay/<slug>` branch, PR title and body, the repository path returned by `github_git_remote`, and the screenshot/video paths.
10. Wait for the approval card. Relay pushes only the approved commit and opens the pull request. Never merge it.

## Pull-request body

Include:

- what changed and why
- the checks that ran and their real results
- any check that could not run
- a short visual-review note for UI changes

The broker attaches the screenshots or recording to the PR when GitHub accepts them. Always keep them attached in the Relay conversation too.

Never push to `main`, `master`, or `production`. Never force-push, delete a branch, or merge. If a repository needs a `.github/workflows` edit, call it out explicitly in the pull-request body.
