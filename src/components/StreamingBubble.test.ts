import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StreamingBubble } from "./StreamingBubble";

describe("StreamingBubble", () => {
  it("renders in-flight answer text as markdown", () => {
    const html = renderToStaticMarkup(
      createElement(StreamingBubble, { threadId: "t1", text: "**hello** while streaming" }),
    );
    expect(html).toContain('data-testid="streaming-bubble"');
    expect(html).toContain("<strong>hello</strong>");
  });

  it("keeps reasoning visible while there is no answer yet", () => {
    const html = renderToStaticMarkup(
      createElement(StreamingBubble, { threadId: "t1", reasoning: "weighing options" }),
    );
    expect(html).toContain("Reasoning");
    expect(html).toContain("weighing options");
  });

  it("drops reasoning once the answer starts so settling does not shift it", () => {
    const html = renderToStaticMarkup(
      createElement(StreamingBubble, { threadId: "t1", text: "the answer", reasoning: "weighing options" }),
    );
    expect(html).not.toContain("Reasoning");
    expect(html).toContain("the answer");
  });

  it("renders nothing without streaming content", () => {
    expect(renderToStaticMarkup(createElement(StreamingBubble, { threadId: "t1" }))).toBe("");
  });
});
