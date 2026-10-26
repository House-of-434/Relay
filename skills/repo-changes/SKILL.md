---
name: repo-changes
description: Clone a repository in the Local VM, make a change on a relay/ branch, verify it, and open a pull request as Relay.
---

# Repo changes

Use this skill only when the person actually asks for a repository change. Do not use it merely because a message mentions a report, analytics, or another unrelated use of a trigger word.

This skill applies when the calling bot has `vm_exec`. If `vm_exec` is unavailable, stop and tell the person to set that bot's Works on to Local VM, or hand repository work to Scout.

## Authorized repository workflow

1. Work in `/home/cua/workspace/repos/House-of-434-house-of-434-site`.
2. Check identity first: `relay-git auth-status`. If authentication fails, report that the workspace token is missing or invalid and stop before editing.
3. Fetch or clone only `House-of-434/house-of-434-site`:
   `relay-git clone House-of-434/house-of-434-site`
4. Create or switch to a `relay/` branch:
   `relay-git checkout relay/<slug>`
5. Read the repository's `CLAUDE.md` and `README.md`, then follow them.
6. Edit files, then run the repository's lint, typecheck, and build checks. If a database-backed test cannot run because PostgreSQL is unavailable in the Local VM, run the checks that can run, state exactly which checks were not run, rely on CI for the remainder, and never treat a successful build as evidence that database-backed tests passed.
7. For user-visible web changes, start the repository's development server in the background, open the page in the Local VM browser, save a screenshot under `/home/cua/workspace`, stop the server, and `attach_file` the screenshot for the person.
8. Commit and push only the `relay/` branch:
   `relay-git commit "<message>"`
   `relay-git push relay/<slug>`
9. Open the pull request against `main`:
   `relay-git create-pr --branch relay/<slug> --title "<title>" --body "<summary, checks, test status>"`
10. Return the pull request URL. Never push to `main`. Never merge.

For House-of-434/house-of-434-site, events are static in `apps/web/src/data/events.ts`; posters go in `apps/web/src/assets/events/`. Use the source link and follow `CLAUDE.md`.

If a repository is inaccessible, stop and ask the person to add `relay-434` as a collaborator. If a repository change would require a `.github/workflows` edit, call it out explicitly in the pull request body; the person reviews it before merge.
