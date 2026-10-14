import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageActions } from "./MessageActions";

type Props = Parameters<typeof MessageActions>[0];

const render = (props: Partial<Omit<Props, "children">> = {}) =>
  renderToStaticMarkup(
    createElement(MessageActions, {
      side: "bot",
      ...props,
      children: [
        createElement("button", { type: "button", key: "copy" }, "copy"),
        createElement("button", { type: "button", key: "reply" }, "reply"),
      ],
    }),
  );

describe("MessageActions", () => {
  it("renders every control in one row that fades in on bubble hover", () => {
    const html = render();
    expect(html).toContain(">copy<");
    expect(html).toContain(">reply<");
    expect(html).toContain("opacity-0");
    expect(html).toContain("group-hover:opacity-100");
    expect(html).toContain("touch:opacity-100");
  });

  it("has no collapsed handle hiding the controls behind a second hover", () => {
    const html = render();
    expect(html).not.toContain("Message actions");
    expect(html).not.toContain("aria-expanded");
    expect(html).not.toContain("grid-cols-[0fr]");
  });

  it("mirrors the tray on the user side so the first control stays nearest the bubble", () => {
    expect(render({ side: "user" })).toContain("flex-row-reverse");
    expect(render({ side: "bot" })).not.toContain("flex-row-reverse");
  });
});
