import assert from "node:assert/strict";
import test from "node:test";

import { issueResult, releaseResult, repositoryResult } from "./infra/github.js";

test("identical release tags from different repositories produce distinct source IDs", () => {
  const first = releaseResult({ repo: "octo/A", tagName: "v1.0.0", url: "https://github.com/octo/A/releases/tag/v1.0.0" });
  const second = releaseResult({ repo: "octo/B", tagName: "v1.0.0", url: "https://github.com/octo/B/releases/tag/v1.0.0" });
  assert.equal(first.sourceId, "octo/A#v1.0.0");
  assert.equal(second.sourceId, "octo/B#v1.0.0");
  assert.notEqual(first.sourceId, second.sourceId);
  assert.equal(first.canonicalUrl, "https://github.com/octo/A/releases/tag/v1.0.0");
  assert.equal(second.canonicalUrl, "https://github.com/octo/B/releases/tag/v1.0.0");
  assert.deepEqual(first.metadata, { tag: "v1.0.0", repo: "octo/A" });
});

test("release results without a usable repository are rejected", () => {
  assert.throws(() => releaseResult({ tagName: "v1.0.0", url: "https://github.com/octo/A/releases/tag/v1.0.0" }), /usable repository/);
});

test("issue results without a usable repository are rejected", () => {
  assert.throws(() => issueResult({ number: 7, title: "Bug", url: "https://github.com/octo/repo/issues/7", isPullRequest: false }), /usable repository/);
  assert.throws(() => issueResult({ number: 7, title: "Bug", url: "https://github.com/octo/repo/issues/7", isPullRequest: false, repo: "not-a-repo" }), /usable repository/);
});

test("repository and issue citations are unchanged by release qualification", () => {
  const repo = repositoryResult({ fullName: "octo/Hello-World", url: "https://github.com/octo/Hello-World", private: false });
  assert.equal(repo.sourceId, "octo/Hello-World");
  const issue = issueResult({ number: 7, title: "Bug", url: "https://github.com/octo/repo/issues/7", isPullRequest: false, repo: "octo/repo" });
  assert.equal(issue.sourceId, "octo/repo#7");
});
