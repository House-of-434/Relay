import assert from "node:assert/strict";
import test from "node:test";

import { fastForwardable, pullBody } from "./publish.ts";

test("only a descendant (or the same commit) may fast-forward", () => {
  assert.equal(fastForwardable("ahead"), true);
  assert.equal(fastForwardable("identical"), true);
  assert.equal(fastForwardable("behind"), false);
  assert.equal(fastForwardable("diverged"), false);
  assert.equal(fastForwardable("unknown"), false);
});

test("visual evidence is appended without duplicating the body", () => {
  const attachment = {
    fileId: "file_abc123",
    name: "after.png",
    mime: "image/png",
    bytes: 123,
    sha256: "b".repeat(64),
    path: "/tmp/after.png",
  };
  assert.equal(pullBody("Checks pass.", [], []), "Checks pass.");
  assert.match(pullBody("Checks pass.", [attachment], ["https://github.com/user-attachments/assets/1"]), /^Checks pass\.\n\n## Visual review\n\n!\[after\.png\]\(https:\/\/github\.com\/user-attachments\/assets\/1\)\n$/);
});
