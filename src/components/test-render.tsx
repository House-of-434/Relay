// One static renderer for component tests. Gallery chips, doc links and
// markdown bubbles all read the store (dispatch for pane-open buttons),
// so every test render goes through the provider here instead of
// repeating the wrapper per test. Tests needing more context (thread
// refs) nest their own provider inside the element argument.
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StoreProvider } from "@/state/store";

export function renderStatic(element: ReactElement): string {
  return renderToStaticMarkup(createElement(StoreProvider, null, element));
}
