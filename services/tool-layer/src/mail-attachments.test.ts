import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  MAX_OUTBOUND_ATTACHMENT_BYTES,
  MAX_OUTBOUND_ATTACHMENTS,
  normalizeOutboundAttachmentRefs,
  resolveOutboundAttachments,
} from "./infra/mail-attachments.js";

function store(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "relay-mail-attachments-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a store ref becomes an inline part with its store-derived type", () => {
  const { dir, cleanup } = store();
  try {
    const ref = "3f2504e0-4f89-41d3-9a0c-0305e82c3301.pdf";
    writeFileSync(join(dir, ref), Buffer.from("report bytes"));
    const resolved = resolveOutboundAttachments(
      [{ source: "attachment", ref, filename: "Q3 report.pdf" }],
      { attachmentsDir: dir },
    );
    assert.deepEqual(resolved, [{
      filename: "Q3 report.pdf",
      mimeType: "application/pdf",
      data: Buffer.from("report bytes").toString("base64"),
    }]);
  } finally {
    cleanup();
  }
});

test("a ref without a display name keeps the store name", () => {
  const { dir, cleanup } = store();
  try {
    const ref = "5f2504e0-4f89-41d3-9a0c-0305e82c3301.md";
    writeFileSync(join(dir, ref), Buffer.from("# report"));
    const [resolved] = resolveOutboundAttachments([{ source: "attachment", ref }], { attachmentsDir: dir });
    assert.ok(resolved && "filename" in resolved);
    assert.equal(resolved.filename, ref);
    assert.equal(resolved.mimeType, "text/markdown");
  } finally {
    cleanup();
  }
});

test("a display name cannot smuggle a path into the part", () => {
  const { dir, cleanup } = store();
  try {
    const ref = "6f2504e0-4f89-41d3-9a0c-0305e82c3301.txt";
    writeFileSync(join(dir, ref), Buffer.from("notes"));
    const [resolved] = resolveOutboundAttachments(
      [{ source: "attachment", ref, filename: "../../etc/passwd" }],
      { attachmentsDir: dir },
    );
    assert.ok(resolved && "filename" in resolved);
    assert.equal(resolved.filename, "passwd");
  } finally {
    cleanup();
  }
});

test("inbound refs pass through for the BFF to resolve against the mailbox", () => {
  assert.deepEqual(
    resolveOutboundAttachments([
      { source: "inbound", messageId: "message-1", attachmentId: "attachment-1" },
    ], { attachmentsDir: "/does/not/matter" }),
    [{ messageId: "message-1", attachmentId: "attachment-1" }],
  );
});

test("the flat input refuses a missing ref or missing inbound ids by name", () => {
  assert.throws(
    () => normalizeOutboundAttachmentRefs([{ source: "attachment" }]),
    /attachments\[0\] needs a ref/,
  );
  assert.throws(
    () => normalizeOutboundAttachmentRefs([{ source: "inbound", messageId: "m-1" }]),
    /attachments\[0\] needs messageId and attachmentId/,
  );
  assert.deepEqual(
    normalizeOutboundAttachmentRefs([
      { source: "attachment", ref: "a.pdf", filename: "Report.pdf", messageId: "ignored" },
      { source: "inbound", messageId: "m-1", attachmentId: "a-1", ref: "ignored" },
    ]),
    [
      { source: "attachment", ref: "a.pdf", filename: "Report.pdf" },
      { source: "inbound", messageId: "m-1", attachmentId: "a-1" },
    ],
  );
});

test("a path, a dotfile, or an unsupported type is refused as a ref", () => {
  const refusals = [
    "../secrets.pdf",
    "/etc/passwd.pdf",
    ".hidden.pdf",
    "notes.exe",
    "notes",
  ];
  for (const ref of refusals) {
    assert.throws(
      () => resolveOutboundAttachments([{ source: "attachment", ref }], { attachmentsDir: "/tmp" }),
      /is not a file ref|not a supported email attachment type/,
      ref,
    );
  }
});

test("a missing or empty store file fails clearly before any send", () => {
  const { dir, cleanup } = store();
  try {
    assert.throws(
      () => resolveOutboundAttachments(
        [{ source: "attachment", ref: "7f2504e0-4f89-41d3-9a0c-0305e82c3301.pdf" }],
        { attachmentsDir: dir },
      ),
      /no longer available/,
    );
    const ref = "8f2504e0-4f89-41d3-9a0c-0305e82c3301.pdf";
    writeFileSync(join(dir, ref), Buffer.alloc(0));
    assert.throws(
      () => resolveOutboundAttachments([{ source: "attachment", ref }], { attachmentsDir: dir }),
      /empty/,
    );
  } finally {
    cleanup();
  }
});

test("a file over the per-file cap is refused", () => {
  const { dir, cleanup } = store();
  try {
    const ref = "9f2504e0-4f89-41d3-9a0c-0305e82c3301.pdf";
    writeFileSync(join(dir, ref), Buffer.alloc(MAX_OUTBOUND_ATTACHMENT_BYTES + 1));
    assert.throws(
      () => resolveOutboundAttachments([{ source: "attachment", ref }], { attachmentsDir: dir }),
      /larger than 20 MB/,
    );
  } finally {
    cleanup();
  }
});

test("more than ten attachments are refused", () => {
  const refs = Array.from({ length: MAX_OUTBOUND_ATTACHMENTS + 1 }, (_, index) => ({
    source: "inbound" as const,
    messageId: "message-1",
    attachmentId: `attachment-${index}`,
  }));
  assert.throws(() => resolveOutboundAttachments(refs), /at most 10 attachments/);
});
