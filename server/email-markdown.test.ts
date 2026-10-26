import { describe, expect, it } from "vitest";

import { markdownToPlainText, renderEmailMarkdown } from "./email-markdown.ts";
import { redactSecretsInText } from "./redact.ts";

describe("email markdown renderer", () => {
  it("renders headings, emphasis, links, and inline code without raw markers", () => {
    const { html, text } = renderEmailMarkdown(
      "# Title\n\nHello **world** with *emphasis*, [link](https://example.test/doc), and `npm run x`.",
    );
    expect(html).toContain("<h1");
    expect(html).toContain("<strong>world</strong>");
    expect(html).toContain("<em>emphasis</em>");
    expect(html).toContain('<a href="https://example.test/doc"');
    expect(html).toContain("<code");
    expect(text).toContain("Title");
    expect(text).toContain("Hello world with emphasis, link (https://example.test/doc), and npm run x.");
    expect(text).not.toContain("**");
  });

  it("renders ordered and unordered lists", () => {
    const { html, text } = renderEmailMarkdown("1. first\n2. second\n\n- one\n- two");
    expect(html).toContain("<ol");
    expect(html).toContain("<ul");
    expect(html).toContain("<li");
    expect(text).toContain("1. first");
    expect(text).toContain("2. second");
    expect(text).toContain("- one");
    expect(text).toContain("- two");
  });

  it("renders blockquotes and fenced code with escaped HTML", () => {
    const { html, text } = renderEmailMarkdown("> quoted\n\n```js\nif (a < b) console.log(1)\n```");
    expect(html).toContain("<blockquote");
    expect(html).toContain("<pre");
    expect(html).toContain("a &lt; b");
    expect(html).not.toContain("a < b");
    expect(text).toContain("> quoted");
    expect(text).toContain("if (a < b) console.log(1)");
  });

  it("renders GFM tables as tables in HTML and readable rows in text", () => {
    const { html, text } = renderEmailMarkdown(
      "| name | value |\n| --- | --- |\n| Alice | 1 |\n| Bob | 2 |",
    );
    expect(html).toContain("<table");
    expect(html).toContain("<th");
    expect(html).toContain("<td");
    expect(html).toContain("Alice");
    expect(text).toContain("| name | value |");
    expect(text).toContain("| Alice | 1 |");
    expect(text).toContain("| Bob | 2 |");
  });

  it("keeps Unicode and tolerates empty or malformed Markdown", () => {
    expect(renderEmailMarkdown("")).toEqual({ html: "", text: "" });
    expect(renderEmailMarkdown("   ")).toEqual({ html: "", text: "" });
    const unicode = renderEmailMarkdown("Hello 世界 🚀");
    expect(unicode.text).toContain("Hello 世界 🚀");
    expect(unicode.html).toContain("Hello 世界 🚀");
    expect(() => renderEmailMarkdown("[unclosed")).not.toThrow();
    expect(renderEmailMarkdown("[unclosed").text).toContain("[unclosed");
  });

  it("drops raw HTML and unsafe link schemes", () => {
    const { html, text } = renderEmailMarkdown(
      "<script>alert(1)</script>\n\n[click](javascript:alert(1)) [ok](https://example.test)",
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('<a href="https://example.test/"');
    expect(text).not.toContain("javascript:");
    expect(text).toContain("click");
    expect(text).toContain("ok (https://example.test/)");
  });

  it("renders image alt text and never an image tag", () => {
    const { html, text } = renderEmailMarkdown("![diagram](https://example.test/x.png)");
    expect(html).not.toContain("<img");
    expect(html).toContain("diagram");
    expect(text).toContain("[image: diagram]");
  });

  it("resolves reference links", () => {
    const { html, text } = renderEmailMarkdown("[doc][1]\n\n[1]: https://example.test/doc");
    expect(html).toContain('<a href="https://example.test/doc"');
    expect(text).toContain("doc (https://example.test/doc)");
  });

  it("redacts secrets in both representations", () => {
    const redacted = redactSecretsInText("My key is sk-abcdefghijklmnop1234.");
    const { html, text } = renderEmailMarkdown(redacted);
    expect(text).toContain("«redacted");
    expect(html).toContain("«redacted");
    expect(text).not.toContain("sk-abcdefghijklmnop1234");
    expect(html).not.toContain("sk-abcdefghijklmnop1234");
  });

  it("keeps markdownToPlainText as the text half of the renderer", () => {
    expect(markdownToPlainText("**Top 5** trending and *fast*")).toBe("Top 5 trending and fast");
    expect(markdownToPlainText("- one\n- two")).toBe("- one\n- two");
  });
});
