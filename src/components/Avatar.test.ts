import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  BotAvatar,
  MausAvatar,
  resolveBotAvatarOutcome,
  type BotAvatarProps,
  type MausAvatarProps,
} from "./Avatar";
import { MASCOT_BODIES } from "../../shared/mascot-bodies";

const render = (props: Partial<MausAvatarProps>) =>
  renderToStaticMarkup(createElement(MausAvatar, { color: "green", animated: false, ...props }));

const renderBot = (bot: Partial<BotAvatarProps["bot"]>) =>
  renderToStaticMarkup(
    createElement(BotAvatar, { bot: { color: "green", ...bot }, animated: false }),
  );

describe("MausAvatar body", () => {
  it("wears the cursor when no body is given", () => {
    expect(render({})).toContain(MASCOT_BODIES.cursor.fit);
  });

  it("wears the body it is given", () => {
    const markup = render({ bodyId: "star" });
    expect(markup).toContain(MASCOT_BODIES.star.fit);
  });

  it("falls back to the cursor for an unknown body", () => {
    // SAFETY: "hexagram" is deliberately not a valid MascotBodyId — this
    // exercises the runtime schema fallback for a value that could arrive
    // from persisted/streamed data, which the type system would otherwise
    // rule out at this call site.
    expect(render({ bodyId: "hexagram" as MausAvatarProps["bodyId"] })).toContain(
      MASCOT_BODIES.cursor.fit,
    );
  });

  it("paints the body with the per-bot gradient, never a flat black fill", () => {
    const markup = render({ bodyId: "circle" });
    expect(markup).not.toContain('fill="#000000"');
    expect(markup).not.toContain("{{GRADIENT}}");
    expect(markup).toContain("url(#");
  });

  it("draws no body texture unless one is given", () => {
    expect(render({})).not.toContain("opacity:0.42");
  });

  it("draws the body texture over the gradient at partial opacity", () => {
    const markup = render({
      pattern: { seed: "atlas", colors: ["#ff0000", "#00ff00"], variant: "pixel" },
    });
    expect(markup).toContain("opacity:0.42");
  });
});

describe("BotAvatar's body texture", () => {
  it("draws the texture behind the expressive face", () => {
    const markup = renderBot({ id: "atlas" });
    expect(markup).toContain("opacity:0.42");
    expect(markup).toContain('fill="#ffffff"');
  });

  it("uses the pixel grid as the texture by default", () => {
    const markup = renderBot({ id: "atlas", bodyTexture: "pixel" });
    expect(markup).toContain('width="10" height="10"');
  });

  it("draws no texture when the bot sets it to none", () => {
    const markup = renderBot({ id: "atlas", bodyTexture: "none" });
    expect(markup).not.toContain('width="10" height="10"');
  });
});

describe("BotAvatar's two avatar outcomes", () => {
  it("zooms and positions a custom image inside its crop", () => {
    const markup = renderBot({
      avatarUrl: "/api/attachments/cat.webp",
      avatarCrop: "circle",
      avatarZoom: 2,
      avatarFocusX: 0.25,
      avatarFocusY: 0.75,
    });
    expect(markup).toContain("scale(2)");
    expect(markup).toContain("25% 75%");
  });

  it("renders a flat cropped image for circle/rounded/square, with no mascot at all", () => {
    const markup = renderBot({ avatarUrl: "/api/attachments/cat.webp", avatarCrop: "circle" });
    expect(markup).toContain("<img");
    expect(markup).not.toContain("<svg");
  });

  it("shows the image as it is, with no mascot face painted on it", () => {
    const markup = renderBot({ avatarUrl: "/api/attachments/cat.webp", avatarCrop: "square" });
    expect(markup).toContain("<img");
    expect(markup).not.toContain("<image");
    expect(markup).not.toContain("radialGradient");
  });

  it("renders the gradient mascot when the crop is mascot, image or not", () => {
    const markup = renderBot({ avatarUrl: "/api/attachments/cat.webp", avatarCrop: "mascot" });
    expect(markup).not.toContain("<img");
    expect(markup).toContain("<svg");
  });

  it("falls back to the gradient mascot when a flat crop has no valid image", () => {
    const markup = renderBot({ avatarUrl: undefined, avatarCrop: "circle" });
    expect(markup).not.toContain("<img");
    expect(markup).toContain("<svg");
  });
});

describe("resolveBotAvatarOutcome", () => {
  // `imageFailed` is set by the flat <img>'s own onError, which
  // renderToStaticMarkup never fires — there are no events in a static
  // render. The decision is a pure function precisely so this branch is
  // still testable synchronously.
  it("falls back to the gradient mascot for an image that failed to load", () => {
    expect(
      resolveBotAvatarOutcome({ avatarCrop: "circle", hasUrl: true, imageFailed: true }),
    ).toBe("gradientMascot");
  });

  it("renders a good flat image flat", () => {
    expect(
      resolveBotAvatarOutcome({ avatarCrop: "rounded", hasUrl: true, imageFailed: false }),
    ).toBe("flatImage");
  });

  it("keeps the mascot crop on the gradient mascot even with a loaded image", () => {
    expect(
      resolveBotAvatarOutcome({ avatarCrop: "mascot", hasUrl: true, imageFailed: false }),
    ).toBe("gradientMascot");
  });

  it("falls back to the gradient mascot when there is no image at all", () => {
    expect(
      resolveBotAvatarOutcome({ avatarCrop: "square", hasUrl: false, imageFailed: false }),
    ).toBe("gradientMascot");
  });
});
