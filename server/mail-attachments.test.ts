import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mailAttachmentCandidatesForTurn, mailAttachmentRefsForTurn, mergeMailAttachmentRefs } from "./mail-attachments.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "relay-mail-attachments-"));
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("routed reply attachment refs", () => {
  it("reads a child turn's file even when the child thread is not routed", () => {
    const childFile = join(root, "child-report.md");
    writeFileSync(childFile, "# Report\n");
    const settled = mailAttachmentRefsForTurn([
      { turnId: "child-turn", attachments: [{ kind: "file", path: childFile, name: "report.md", mime: "text/markdown" }] },
    ], "child-turn", root);
    expect(settled.refs).toEqual([{ path: childFile, filename: "report.md", mimeType: "text/markdown" }]);
    expect(settled.omitted).toEqual([]);
  });

  it("ignores other turns, non-file attachments, and out-of-store paths", () => {
    const good = join(root, "good.txt");
    writeFileSync(good, "hello");
    const empty = join(root, "empty.txt");
    writeFileSync(empty, "");
    const outside = join(tmpdir(), "outside.txt");
    writeFileSync(outside, "outside");
    const settled = mailAttachmentRefsForTurn([
      { turnId: "other", attachments: [{ kind: "file", path: good, name: "good.txt", mime: "text/plain" }] },
      { turnId: "turn-1", attachments: [
        { kind: "image", path: good, name: "good.png", mime: "image/png" },
        { kind: "file", path: outside, name: "outside.txt", mime: "text/plain" },
        { kind: "file", path: empty, name: "empty.txt", mime: "text/plain" },
        { kind: "file", path: good, name: "good.txt", mime: "text/plain" },
      ] },
    ], "turn-1", root);
    expect(settled.refs).toEqual([
      { path: good, filename: "good.txt", mimeType: "text/plain" },
    ]);
    expect(settled.omitted).toEqual(["empty.txt"]);
  });

  it("omits dangling paths at settle instead of entering the row", () => {
    const settled = mailAttachmentRefsForTurn([
      { turnId: "turn-1", attachments: [{ kind: "file", path: join(root, "missing.pdf"), name: "missing.pdf", mime: "application/pdf" }] },
    ], "turn-1", root);
    expect(settled.refs).toEqual([]);
    expect(settled.omitted).toEqual(["missing.pdf"]);
  });

  it("keeps delegation candidates ungated so the parent merge discloses drops once", () => {
    const childFile = join(root, "child-report.md");
    writeFileSync(childFile, "# Report\n");
    expect(mailAttachmentCandidatesForTurn([
      { turnId: "child-turn", attachments: [{ kind: "file", path: childFile, name: "report.md", mime: "text/markdown" }] },
    ], "child-turn", root)).toEqual([{ path: childFile, filename: "report.md", mimeType: "text/markdown" }]);
  });

  it("merges parent and child refs without duplicates", () => {
    const a = join(root, "a.md");
    const b = join(root, "b.md");
    writeFileSync(a, "a");
    writeFileSync(b, "b");
    expect(mergeMailAttachmentRefs([
      [{ path: a, filename: "a.md", mimeType: "text/markdown" }],
      [
        { path: b, filename: "b.md", mimeType: "text/markdown" },
        { path: a, filename: "a.md", mimeType: "text/markdown" },
      ],
    ], root)).toEqual({
      refs: [
        { path: a, filename: "a.md", mimeType: "text/markdown" },
        { path: b, filename: "b.md", mimeType: "text/markdown" },
      ],
      omitted: [],
    });
  });
});
