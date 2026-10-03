// The in-chat connector card is the last Composio-shaped surface a teammate
// can still meet: it renders results already stored in a conversation. It stays
// translated even though new connections no longer produce these cards.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { setLocale } from "@/lib/i18n";
import { locales } from "@/locales";
import { ConnectorCard } from "./ConnectorCard";

afterEach(() => {
  setLocale("en");
});

describe("connector card translation", () => {
  it("translates the in-chat connector card", () => {
    setLocale("ja");
    const html = renderToStaticMarkup(createElement(ConnectorCard, {
      botId: "atlas",
      threadId: "thread",
      message: {
        id: "m1",
        role: "bot",
        kind: "connector",
        at: 1,
        connector: { slug: "gmail", label: "Gmail", description: "Read mail", status: "required", resumeKey: "resume1" },
      },
    }));
    expect(html).toContain(locales.ja!["connectors.card.connectSecurely"]);
    expect(html).toContain(locales.ja!["connectors.card.requested"]);
    expect(html).not.toContain("Connect securely");
  });
});
