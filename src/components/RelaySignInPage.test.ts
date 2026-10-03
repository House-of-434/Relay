import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import { RelaySignInPage } from "./RelaySignInPage";

it("shows a company Google sign-in and explains it does not connect mail by itself", () => {
  vi.stubGlobal("window", {});
  try {
    const html = renderToStaticMarkup(createElement(RelaySignInPage));
    expect(html).toContain("Sign in to Relay");
    expect(html).toContain("House of 434 Google account");
    expect(html).toContain('href="/auth/login"');
    expect(html).toContain("Signing in identifies you");
    expect(html).toContain("Gmail and Calendar access are connected separately");
    expect(html).not.toContain("GOCSPX");
  } finally {
    vi.unstubAllGlobals();
  }
});
