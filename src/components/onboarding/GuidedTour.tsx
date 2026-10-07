// Runs the guided tour on the live interface. One spotlight at a time,
// pointing at a real control, with Next on every step; the tour presses the
// controls itself (the Tools menu, its items, the Computer button), so it
// never waits on the user and the app reacts exactly as it would for them.
// Clicking the pointed-at control counts as Next too. Every advance is
// recorded before the step moves, so a reload lands on the same step: in the
// workspace's onboarding record when the session may write it, and in this
// browser's own list when it may not (see lib/first-run). A write that is
// refused is not a dead end — the tour still advances.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ANCHOR_EFFECTS, currentStep, stepNumber, TOUR_STEPS, withTourFinished, type TourEffect, type TourStep } from "@/lib/guided-tour";
import { t } from "@/lib/i18n";
import { emailGateDone } from "@/lib/analytics";
import type { MausState } from "@/lib/mascot";
import { EMPTY_ONBOARDING, hintSeenPatch, type OnboardingStatus } from "@/lib/onboarding";
import { readTourSeen, tourStorage, writeTourSeen } from "@/lib/first-run";
import type { LocaleKey } from "@/locales";
import { api, useStore } from "@/state/store";
import { Spotlight } from "./Spotlight";

const MASCOT: Record<TourStep["id"], MausState> = {
  "tour.composer": "happy",
  "tour.tools": "curious",
  "tour.apps": "happy",
  "tour.apps-panel": "proud",
  "tour.automations": "happy",
  "tour.automations-page": "drowsy",
  "tour.done": "celebrate",
};

const copy = (id: TourStep["id"]) => t(`onboarding.tour.${id.slice(5)}` as LocaleKey);

function visible(anchor: string): HTMLElement | null {
  const all = Array.from(document.querySelectorAll<HTMLElement>(`[data-tour="${anchor}"]`));
  return all.filter((el) => el.getClientRects().length > 0).at(-1) ?? null;
}

function anchorPresent(anchor: string | null): boolean {
  return !anchor || visible(anchor) !== null;
}

/** Press a control the way the user would; false when it is not on screen. */
function press(anchor: string): boolean {
  const el = visible(anchor);
  if (!el) return false;
  el.click();
  return true;
}

export function GuidedTour() {
  const { state, dispatch } = useStore();
  const record = state.config?.onboarding;
  // Steps this browser has been shown. The server record is authoritative and
  // is written whenever the session may; a session that cannot write it (a
  // member of Relay's shared workspace signs in with client scope, and
  // `PUT /api/config` is admin-only) keeps them here instead, so the tour
  // still completes once rather than restarting on every reload. The union is
  // what "already seen" means: a local id never cancels a server one.
  //
  // State, not a ref: a refused server write must still move the tour on, and
  // only a re-render does that.
  const [localSeen, setLocalSeen] = useState<string[]>(() => readTourSeen(tourStorage()));
  const merged = useMemo<OnboardingStatus>(
    () => ({ ...(record ?? EMPTY_ONBOARDING), hintsSeen: [...new Set([...(record?.hintsSeen ?? []), ...localSeen])] }),
    [record, localSeen],
  );
  const step = currentStep(merged);
  const saving = useRef(false);
  const pending = useRef<Promise<unknown>>(Promise.resolve());
  const latestRecord = useRef(merged);
  latestRecord.current = merged;
  const closed = useRef(false);
  const [dismissed, setDismissed] = useState(false);
  const entered = useRef<string | null>(null);
  const [fallback, setFallback] = useState<string | null>(null);

  useEffect(() => {
    if (!state.tourOpen) return;
    closed.current = false;
    setDismissed(false);
  }, [state.tourOpen]);

  const run = useCallback(
    (effect: TourEffect | undefined) => {
      switch (effect) {
        case "openTools": {
          // the menu is a toggle: only press it when it is closed
          const trigger = visible("tools");
          if (trigger && trigger.getAttribute("aria-expanded") !== "true") trigger.click();
          return;
        }
        case "openApps":
          if (!press("nav-apps")) dispatch({ type: "togglePlugins", open: true });
          return;
        case "closeApps":
          dispatch({ type: "togglePlugins", open: false });
          return;
        case "openAutomations":
          if (!press("nav-automations")) dispatch({ type: "showRoutines" });
          return;
        case "backToChat":
          dispatch({ type: "showChat" });
          return;
        default:
          return;
      }
    },
    [dispatch],
  );

  const save = useCallback(
    (finish: boolean, id?: TourStep["id"]) => {
      // A skip must follow an in-flight Next, not disappear behind its guard.
      const operation = pending.current.then(async () => {
        const patch = finish
          ? { onboarding: { hintsSeen: withTourFinished(latestRecord.current) } }
          : id ? hintSeenPatch(latestRecord.current, id) : null;
        if (!patch) return;
        // The browser has it first: a refused or slow write must not lose the
        // step, because this record is the only way the tour stays finished.
        // Union, not replace — the patch is computed from the merged record,
        // and the server half of it knows nothing about ids this browser held.
        const hints = patch.onboarding.hintsSeen;
        const ids = [...new Set([...latestRecord.current.hintsSeen, ...hints])];
        const storage = tourStorage();
        for (const hint of hints) writeTourSeen(storage, hint);
        setLocalSeen((previous) => [...new Set([...previous, ...hints])]);
        const config = await api("/api/config", { method: "PUT", body: JSON.stringify({ onboarding: { hintsSeen: ids } }), signal: AbortSignal.timeout(10_000) });
        latestRecord.current = config.onboarding;
        dispatch({ type: "configStatus", config });
      });
      pending.current = operation.catch(() => {});
      return operation;
    },
    [dispatch],
  );

  const advance = useCallback(
    (fromAnchor = false) => {
      if (!step || saving.current || closed.current) return;
      saving.current = true;
      // Best-effort: a session that cannot write the workspace config still
      // walks the tour, on the browser's record alone. It used to freeze here
      // with an error, because only a successful save moved the step on.
      void save(false, step.id).catch(() => {}).then(() => {
        // Only move the interface after progress was saved. A queued skip
        // owns cleanup and must not have its panels reopened by this request.
        if (!closed.current && !(fromAnchor && step.onExit && ANCHOR_EFFECTS.has(step.onExit))) run(step.onExit);
      }).finally(() => { saving.current = false; });
    },
    [step, run, save],
  );

  const finish = useCallback(() => {
    if (closed.current) return;
    closed.current = true;
    setDismissed(true);
    // leave nothing open behind: the menu and the Automations page
    if (state.pluginsOpen) run("closeApps");
    run("backToChat");
    void save(true).catch(() => {});
    dispatch({ type: "toggleTour", open: false });
  }, [state.pluginsOpen, run, save, dispatch]);

  // The welcome flow finishing is what opens the tour. It marks the workspace
  // record when the session may write it, and always marks the browser's own
  // one-time gate (`setEmailGateDone`), which is the whole record for a member
  // of the shared workspace — so either signal means "the welcome is done".
  const welcomeDone = Boolean(record?.completedAt) || emailGateDone();
  const active = !dismissed && welcomeDone && !state.welcomeOpen && step !== null;

  // entering a step runs its effect once per step
  useEffect(() => {
    if (!active || !step || entered.current === step.id) return;
    entered.current = step.id;
    run(step.onEnter);
  }, [active, step, run]);

  // a step whose control is not on screen points at its fallback, or skips
  // itself, after the layout has a moment to settle (a menu closing, a
  // page changing, a panel mounting). Its enter effect is pressed once
  // more first: on a cold load the sidebar may not have been there yet.
  useEffect(() => {
    if (!active || !step?.skipIfMissing) return;
    let second: ReturnType<typeof setTimeout> | undefined;
    const decide = () => {
      if (anchorPresent(step.anchor)) return;
      if (step.fallbackAnchor && anchorPresent(step.fallbackAnchor)) setFallback(step.id);
      else advance();
    };
    const first = setTimeout(() => {
      if (anchorPresent(step.anchor)) return;
      run(step.onEnter);
      second = setTimeout(decide, 300);
    }, 400);
    return () => {
      clearTimeout(first);
      if (second) clearTimeout(second);
    };
  }, [active, step, advance, run]);

  // clicking the pointed-at control is as good as Next
  useEffect(() => {
    if (!active || !step?.anchor || step.id === "tour.apps-panel" || step.id === "tour.automations-page" || step.id === "tour.done") return;
    const onClick = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (target?.closest(`[data-tour="${step.anchor}"]`)) advance(true);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [active, step, advance]);

  if (!active || !step) return null;
  if (window.ogb?.remoteClient?.active === true) return null;

  const { current, total } = stepNumber(step);
  const closing = step.id === "tour.done";
  const anchor = fallback === step.id && step.fallbackAnchor ? step.fallbackAnchor : step.anchor;
  return (
    <Spotlight
      anchor={anchor}
      placement={step.placement}
      mascot={MASCOT[step.id]}
      progress={closing ? undefined : t("onboarding.tour.progress", { current, total })}
      primary={{ label: closing ? t("onboarding.tour.finish") : t("onboarding.tour.next"), onClick: closing ? finish : () => advance() }}
      secondary={closing ? undefined : { label: t("onboarding.tour.skip"), onClick: finish }}
      onDone={finish}
    >
      {copy(step.id)}
    </Spotlight>
  );
}

export { TOUR_STEPS };
