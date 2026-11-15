// The one place a tool chip can name now: the Tool Layer browser. Computer
// destinations were removed with the Works-on feature.
import { toolSurfaceKind } from "../../shared/tool-surface";
import type { LocaleKey } from "@/locales";

export type Place = "browser";
export type EffectivePlace = "browser";

export function placeLabelKey(place: EffectivePlace): LocaleKey {
  return `place.${place}` as LocaleKey;
}

/** The place a tool chip should carry: the browser for browser tools,
 * nothing for everything else. */
export function toolPlace(toolName: string): Place | null {
  return toolSurfaceKind(toolName) === "browser" ? "browser" : null;
}
