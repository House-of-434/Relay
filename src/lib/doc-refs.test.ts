import { describe, expect, it } from "vitest";

import { docLangForPath, docRefUrl, docTypeLabel, isMarkdownPath, looksLikeDocRefUrl, parseDocRefUrl, previewableDocType } from "./doc-refs";

describe("doc refs", () => {
  it("round-trips a canonical link", () => {
    const ref = {
      type: "markdown" as const,
      threadId: "thread-1",
      messageId: "message-1",
      path: "/workspace/report.md",
      title: "Q3 report",
    };
    expect(parseDocRefUrl(docRefUrl(ref))).toEqual(ref);
  });

  it("parses a link without a title", () => {
    expect(parseDocRefUrl("relay://doc/thread-1/message-1?path=%2Fworkspace%2Freport.md")).toEqual({
      type: "markdown",
      threadId: "thread-1",
      messageId: "message-1",
      path: "/workspace/report.md",
    });
  });

  it("rejects near-misses with extra path, extra query, hash or foreign host", () => {
    for (const value of [
      "relay://doc/thread-1/message-1/extra?path=%2Fa.md",
      "relay://doc/thread-1?path=%2Fa.md",
      "relay://doc/thread-1/message-1?path=%2Fa.md&evil=1",
      "relay://doc/thread-1/message-1?path=%2Fa.md#frag",
      "relay://doc/thread-1/message-1",
      "relay://doc/thread-1/message-1?path=",
      "relay://doc/thread-1/message-1?title=No+path",
      "relay://doc/thread-1/message-1?path=%2Fa.pdf",
      "relay://thread/thread-1?bot=scout",
      "https://example.test/doc",
    ]) {
      expect(parseDocRefUrl(value)).toBeNull();
    }
  });

  it("types the renderer by extension: markdown rich, scripts and text as code", () => {
    expect(parseDocRefUrl("relay://doc/thread-1/message-1?path=%2Fworkspace%2Frun.py")?.type).toBe("code");
    expect(previewableDocType("/workspace/report.md")).toBe("markdown");
    expect(previewableDocType("/workspace/run.py")).toBe("code");
    expect(previewableDocType("/workspace/notes.txt")).toBe("code");
    expect(previewableDocType("/workspace/report.pdf")).toBeNull();
    expect(docLangForPath("/workspace/run.py")).toBe("python");
    expect(docLangForPath("/workspace/notes.txt")).toBe("text");
    expect(docLangForPath("/workspace/report.md")).toBe("text");
  });

  it("labels pills with a readable type line", () => {
    expect(docTypeLabel("/workspace/report.md")).toBe("Markdown");
    expect(docTypeLabel("/workspace/run.py")).toBe("Python");
    expect(docTypeLabel("/workspace/app.tsx")).toBe("TSX");
    expect(docTypeLabel("/workspace/notes.txt")).toBe("Text");
    expect(docTypeLabel("/workspace/report.pdf")).toBe("PDF");
    expect(docTypeLabel("/workspace/archive")).toBe("File");
  });

  it("flags even dead doc links so markdown never hands them to the shell", () => {
    expect(looksLikeDocRefUrl("relay://doc/thread-1/message-1/extra?path=%2Fa.md")).toBe(true);
    expect(looksLikeDocRefUrl("RELAY://DOC/thread-1/message-1?path=%2Fa.md")).toBe(true);
    expect(looksLikeDocRefUrl("https://example.test")).toBe(false);
  });

  it("gates the pane preview on markdown paths only", () => {
    for (const value of ["/workspace/report.md", "C:\\Docs\\notes.MARKDOWN", "report.md?version=2", "notes.markdown#section"]) {
      expect(isMarkdownPath(value)).toBe(true);
    }
    for (const value of ["/workspace/report.pdf", "/workspace/report.md.bak", "reportmd", ""]) {
      expect(isMarkdownPath(value)).toBe(false);
    }
  });
});
