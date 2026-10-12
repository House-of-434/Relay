import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { DocPane, PreviewCode } from "./DocPane";
import { renderStatic } from "./test-render";

const docRef = {
  type: "code" as const,
  threadId: "thread-1",
  messageId: "message-1",
  path: "/workspace/hello_spiderman.txt",
  title: "hello_spiderman.txt",
};

describe("doc pane shell", () => {
  it("shows the title with copy, expand and close actions while loading", () => {
    const html = renderStatic(createElement(DocPane, { docRef }));
    expect(html).toContain("hello_spiderman.txt");
    expect(html).toContain('aria-label="Copy document to clipboard"');
    expect(html).toContain('aria-label="Expand document pane"');
    expect(html).toContain('aria-label="Close the document"');
    expect(html).toContain("Loading document");
  });
});

describe("preview code", () => {
  it("renders document text once with no chat chrome", () => {
    const html = renderStatic(createElement(PreviewCode, { code: "Hello Spiderman\n", lang: "text" }));
    expect(html.match(/Hello Spiderman/g)).toHaveLength(1);
    expect(html).toContain("<pre");
    expect(html).not.toContain("Wrap");
    expect(html).not.toContain("Save");
  });
});
