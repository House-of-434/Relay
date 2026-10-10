import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import { RelaySignInPage } from "./RelaySignInPage";

it("shows a company Google sign-in and nothing more", () => {
  vi.stubGlobal("window", {});
  try {
    const html = renderToStaticMarkup(createElement(RelaySignInPage));
    expect(html).toContain(">Relay<");
    expect(html).toContain("House of 434");
    expect(html).toContain('href="/auth/login"');
    expect(html).toContain("Continue with Google");
    expect(html).toContain("#9AD7B2");
    expect(html).not.toContain("GOCSPX");
    // the card answers "how do I get in", and stops there
    for (const agent of ["Scout", "Mercury", "Curator"]) expect(html).not.toContain(agent);
    // mail and calendar access is explained by the guided tour, not a footnote
    expect(html).not.toContain("mailbox");
    expect(html).not.toContain("Calendar");
  } finally {
    vi.unstubAllGlobals();
  }
});

it("keeps the denial notice for an account the workspace does not authorize", () => {
  vi.stubGlobal("window", { location: { search: "?authError=not-allowed" } });
  try {
    const html = renderToStaticMarkup(createElement(RelaySignInPage));
    expect(html).toContain('role="alert"');
    expect(html).toContain("not authorized for the House of 434 workspace");
  } finally {
    vi.unstubAllGlobals();
  }
});

it("has no denial notice on an ordinary sign-in", () => {
  vi.stubGlobal("window", { location: { search: "" } });
  try {
    expect(renderToStaticMarkup(createElement(RelaySignInPage))).not.toContain('role="alert"');
  } finally {
    vi.unstubAllGlobals();
  }
});
