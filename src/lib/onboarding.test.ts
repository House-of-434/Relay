import { describe, expect, it } from "vitest";
import {
  agentRoster,
  beatWidth,
  beatsFor,
  cloudSignInDue,
  companyModelCount,
  completionPatch,
  EMPTY_ONBOARDING,
  engineSummary,
  hintSeen,
  hostedMember,
  spotlightsQuiet,
  hintSeenPatch,
  LOCAL_VIEWER,
  nextBeat,
  organisationSignIn,
  previousBeat,
  welcomeDue,
  welcomeViewer,
  WELCOME_VERSION,
} from "./onboarding";

const done = { completedAt: "2026-09-09T10:00:00.000Z", version: WELCOME_VERSION, reelSeen: false, hintsSeen: [] };

describe("welcomeDue", () => {
  it("waits for the server before deciding", () => {
    expect(welcomeDue(null, { remoteClient: false, legacyDone: false })).toBe(false);
    expect(welcomeDue(undefined, { remoteClient: false, legacyDone: false })).toBe(false);
  });

  it("shows the tour to a fresh workspace", () => {
    expect(welcomeDue({}, { remoteClient: false, legacyDone: false })).toBe(true);
    expect(welcomeDue({ onboarding: EMPTY_ONBOARDING }, { remoteClient: false, legacyDone: false })).toBe(true);
  });

  it("never shows it to a paired remote client", () => {
    expect(welcomeDue({}, { remoteClient: true, legacyDone: false })).toBe(false);
  });

  it("respects a completion at the current version", () => {
    expect(welcomeDue({ onboarding: done }, { remoteClient: false, legacyDone: false })).toBe(false);
  });

  it("re-shows a flow completed at an older version", () => {
    expect(welcomeDue({ onboarding: { ...done, version: WELCOME_VERSION - 1 } }, { remoteClient: false, legacyDone: false })).toBe(true);
  });

  it("honours the old localStorage gate for one release", () => {
    expect(welcomeDue({}, { remoteClient: false, legacyDone: true })).toBe(false);
    // but a server record, once present, wins over the browser
    expect(welcomeDue({ onboarding: { ...done, version: 0 } }, { remoteClient: false, legacyDone: true })).toBe(true);
  });

  it("decides who gets the tour on a fresh workspace", () => {
    const fresh = { onboarding: EMPTY_ONBOARDING };
    const cases = [
      // the desktop app's own window: exactly as before
      { who: "local desktop", options: { remoteClient: false, legacyDone: false, ...LOCAL_VIEWER }, due: true },
      { who: "remote client", options: { remoteClient: true, legacyDone: false, ...LOCAL_VIEWER }, due: false },
      { who: "hosted admin", options: { remoteClient: false, legacyDone: false, hosted: true, canSave: true }, due: true },
      // PUT /api/config is admin-only: a member could never finish it
      { who: "hosted member", options: { remoteClient: false, legacyDone: false, hosted: true, canSave: false }, due: false },
      { who: "member of a self-hosted server", options: { remoteClient: false, legacyDone: false, hosted: false, canSave: false }, due: false },
      // a hosted session that has not proved it may save waits
      { who: "hosted, scope unknown", options: { remoteClient: false, legacyDone: false, hosted: true }, due: false },
      // Relay's shared workspace: everyone signs in with client scope, so
      // without the exception nobody would ever see the flow
      {
        who: "shared workspace member",
        options: { remoteClient: false, legacyDone: false, hosted: false, canSave: false, sharedWorkspace: true },
        due: true,
      },
      {
        who: "shared workspace member, second visit",
        options: { remoteClient: false, legacyDone: true, hosted: false, canSave: false, sharedWorkspace: true },
        due: false,
      },
      // the workspace record belongs to whoever could write it, so it must
      // not silence a colleague who has not seen the flow in this browser
      {
        who: "shared workspace member, owner already finished",
        options: { remoteClient: false, legacyDone: false, hosted: false, canSave: false, sharedWorkspace: true },
        due: true,
        config: { onboarding: done },
      },
      // a genuinely hosted workspace still waits for an admin
      {
        who: "hosted member of a shared deployment",
        options: { remoteClient: false, legacyDone: false, hosted: true, canSave: false, sharedWorkspace: true },
        due: false,
      },
    ];
    for (const { who, options, due, ...rest } of cases) {
      const config = "config" in rest ? rest.config : fresh;
      expect(welcomeDue(config, options), who).toBe(due);
    }
  });
});

describe("welcomeViewer", () => {
  it("reads the session defensively", () => {
    expect(welcomeViewer({ kind: "loopback", scopes: ["admin", "client"] })).toEqual({ hosted: false, canSave: true });
    expect(welcomeViewer({ kind: "session", scopes: ["admin", "client"], hosted: true })).toEqual({ hosted: true, canSave: true });
    expect(welcomeViewer({ kind: "session", scopes: ["client"], hosted: true })).toEqual({ hosted: true, canSave: false });
    expect(welcomeViewer({ kind: "session", scopes: ["client"] })).toEqual({ hosted: false, canSave: false });
    // a shared server's local service trust (no admin scope) cannot save either
    expect(welcomeViewer({ kind: "loopback", scopes: ["client"], trust: "service" })).toEqual({ hosted: false, canSave: false });
    // an answer without scopes is today's owner; only a literal true is hosted
    expect(welcomeViewer({})).toEqual(LOCAL_VIEWER);
    expect(welcomeViewer(null)).toEqual(LOCAL_VIEWER);
    expect(welcomeViewer({ scopes: ["admin"], hosted: "yes" })).toEqual({ hosted: false, canSave: true });
    // an OMB Cloud home says so; only a literal true counts
    expect(welcomeViewer({ kind: "session", scopes: ["admin", "client"], cloudHome: true })).toEqual({ hosted: false, canSave: true, cloudHome: true });
    expect(welcomeViewer({ kind: "session", scopes: ["admin", "client"], cloudHome: "yes" })).toEqual({ hosted: false, canSave: true });
  });

  it("calls only a hosted session without admin scope a hosted member", () => {
    expect(hostedMember({ hosted: true, canSave: false })).toBe(true);
    expect(hostedMember({ hosted: true, canSave: true })).toBe(false);
    // the owner's own paired browser on a personal server is not a team member
    expect(hostedMember({ hosted: false, canSave: false })).toBe(false);
    expect(hostedMember(LOCAL_VIEWER)).toBe(false);
    expect(hostedMember(null)).toBe(false);
    // spotlights wait for the answer, then stay as before except for hosted members
    expect(spotlightsQuiet(null)).toBe(true);
    expect(spotlightsQuiet({ hosted: true, canSave: false })).toBe(true);
    expect(spotlightsQuiet({ hosted: false, canSave: false })).toBe(false);
    expect(spotlightsQuiet(LOCAL_VIEWER)).toBe(false);
  });
});

describe("first run on an OMB Cloud home", () => {
  // What the machine's /api/auth/session answers the desktop app once
  // "Connect to my Cloud" has paired it (server/index.ts, cloud-home.ts).
  const connected = welcomeViewer({ kind: "session", scopes: ["admin", "client"], via: "cookie", cloudHome: true });
  const engine = (id: string, authenticated: boolean | undefined, state = "available") => ({ id, state, authenticated });
  const ready = (instance: ReturnType<typeof engine>) => instance.state === "available" && instance.authenticated !== false;
  const signedOut = [engine("claude", false), engine("codex", false), engine("opencodeGo", undefined, "unavailable")];

  it("routes the connected app to the engine sign-in, not the welcome flow", () => {
    expect(cloudSignInDue(connected, { connected: true, instances: signedOut }, ready)).toBe(true);
    expect(welcomeDue({ onboarding: EMPTY_ONBOARDING }, { remoteClient: false, legacyDone: false, ...connected })).toBe(false);
  });

  it("hands over to the chat once any engine can run", () => {
    for (const signedIn of [engine("claude", true), engine("codex", true), engine("anthropic-key", undefined)]) {
      expect(cloudSignInDue(connected, { connected: true, instances: [...signedOut, signedIn] }, ready)).toBe(false);
    }
  });

  it("waits for the server, and changes nothing anywhere else", () => {
    expect(cloudSignInDue(connected, { connected: false, instances: signedOut }, ready)).toBe(false);
    expect(cloudSignInDue(connected, { connected: true, instances: [] }, ready)).toBe(false);
    expect(cloudSignInDue(null, { connected: true, instances: signedOut }, ready)).toBe(false);
    // a paired phone without admin scope cannot sign engines in
    expect(cloudSignInDue({ ...connected, canSave: false }, { connected: true, instances: signedOut }, ready)).toBe(false);
    for (const viewer of [LOCAL_VIEWER, { hosted: true, canSave: true }, welcomeViewer({ kind: "session", scopes: ["admin", "client"] })]) {
      expect(cloudSignInDue(viewer, { connected: true, instances: signedOut }, ready)).toBe(false);
      expect(welcomeDue({ onboarding: EMPTY_ONBOARDING }, { remoteClient: false, legacyDone: false, ...viewer })).toBe(true);
    }
  });
});

describe("organisation sign-in in the engines beat", () => {
  const bridge = { begin: () => {} };

  it("is offered only by the packaged local desktop", () => {
    expect(organisationSignIn({ organization: bridge }, { hosted: false })).toBe(bridge);
    expect(organisationSignIn(undefined, { hosted: false })).toBeUndefined();
    expect(organisationSignIn({}, { hosted: false })).toBeUndefined();
    expect(organisationSignIn({ organization: bridge, remoteClient: { active: true } }, { hosted: false })).toBeUndefined();
    expect(organisationSignIn({ organization: bridge }, { hosted: true })).toBeUndefined();
    expect(organisationSignIn({ organization: bridge, remoteClient: { active: false } }, { hosted: false })).toBe(bridge);
  });

  it("counts the models the organisation approved", () => {
    expect(companyModelCount(null)).toBe(0);
    expect(companyModelCount({})).toBe(0);
    expect(companyModelCount({ providers: [
      { configured: true, models: ["a", "b"] },
      { configured: false, models: ["c"] },
      { configured: true, models: ["d"] },
    ] })).toBe(3);
  });
});

describe("engineSummary", () => {
  type Row = { id: string; install?: object; managed?: object; ok: boolean };
  const ok = (row: Row) => row.ok;
  const personal = (id: string, ready: boolean): Row => ({ id, install: {}, ok: ready });
  const company = (id: string, ready: boolean): Row => ({ id, managed: { organizationId: "org", organizationName: "Org" }, ok: ready });

  it("counts a signed-in Company engine as ready when nothing personal is", () => {
    const rows = [personal("claude", false), personal("codex", false), company("company.claude", true)];
    const summary = engineSummary(rows, ok, { company: true });
    expect(summary.allReady).toBe(true);
    expect(summary.company).toBe(1);
    // personal rows stay listed, below, as before
    expect(summary.ready.map((row) => row.id)).toEqual([]);
    expect(summary.setup.map((row) => row.id)).toEqual(["claude", "codex"]);
  });

  it("does not count a Company engine that cannot run", () => {
    const summary = engineSummary([personal("claude", false), company("company.claude", false)], ok, { company: true });
    expect(summary.company).toBe(0);
    expect(summary.allReady).toBe(false);
  });

  it("counts exactly as before where organisation sign-in is not offered", () => {
    const rows = [personal("claude", true), personal("codex", false), company("company.claude", true)];
    const summary = engineSummary(rows, ok, { company: false });
    expect(summary).toEqual({ ready: [rows[0]], setup: [rows[1]], company: 0, allReady: false });
    expect(engineSummary([personal("claude", true)], ok, { company: false }).allReady).toBe(true);
    expect(engineSummary([], ok, { company: false }).allReady).toBe(false);
  });
});

describe("persistence patches", () => {
  it("stamps completion with the current version", () => {
    expect(completionPatch(new Date("2026-09-09T12:34:56.000Z"))).toEqual({
      onboarding: { completedAt: "2026-09-09T12:34:56.000Z", version: WELCOME_VERSION },
    });
  });

  it("adds a hint once and never writes a no-op", () => {
    expect(hintSeen(undefined, "computer")).toBe(false);
    expect(hintSeenPatch(undefined, "computer")).toEqual({ onboarding: { hintsSeen: ["computer"] } });
    const record = { ...EMPTY_ONBOARDING, hintsSeen: ["computer"] };
    expect(hintSeen(record, "computer")).toBe(true);
    expect(hintSeenPatch(record, "computer")).toBeNull();
    expect(hintSeenPatch(record, "apps")).toEqual({ onboarding: { hintsSeen: ["computer", "apps"] } });
  });
});

describe("beat machine", () => {
  it("lists beats for the desktop app with the reel off", () => {
    expect(beatsFor({ dictation: true, reel: false })).toEqual(["hello", "engines", "permissions", "phone", "bot"]);
  });

  it("drops the permissions beat where there is no microphone to ask for", () => {
    expect(beatsFor({ dictation: false, reel: false })).toEqual(["hello", "engines", "phone", "bot"]);
  });

  it("slots the reel after hello when enabled", () => {
    expect(beatsFor({ dictation: false, reel: true })).toEqual(["hello", "reel", "engines", "phone", "bot"]);
  });

  it("always ends on the bot beat", () => {
    for (const dictation of [true, false]) {
      for (const reel of [true, false]) {
        expect(beatsFor({ dictation, reel }).at(-1)).toBe("bot");
        expect(beatsFor({ dictation, reel, hosted: true }).at(-1)).toBe("bot");
      }
    }
  });

  it("gives a hosted workspace a greeting and the bot, nothing about this computer", () => {
    expect(beatsFor({ dictation: true, reel: true, hosted: true })).toEqual(["hello", "bot"]);
    expect(beatsFor({ dictation: true, reel: true, hosted: false })).toEqual(["hello", "reel", "engines", "permissions", "phone", "bot"]);
  });

  it("gives a shared workspace the greeting and the roster, and nothing else", () => {
    // Guards the v0.1 trim in Relay-notes/todo.md. No name field, no bot to
    // create, and nothing about installing anything on this computer.
    expect(beatsFor({ dictation: true, reel: true, sharedWorkspace: true })).toEqual(["hello", "team"]);
  });

  it("never offers a bot-creation beat on a shared workspace", () => {
    const beats = beatsFor({ dictation: true, reel: true, sharedWorkspace: true });
    expect(beats).not.toContain("bot");
    expect(beats).not.toContain("engines");
    expect(beats).not.toContain("permissions");
    expect(beats).not.toContain("phone");
    expect(beats).not.toContain("reel");
  });

  it("gives the roster beat room for three descriptions", () => {
    expect(beatWidth("team")).toBeGreaterThan(beatWidth("hello"));
  });

  it("walks forward and back and stops at the ends", () => {
    const beats = beatsFor({ dictation: true, reel: false });
    expect(nextBeat(beats, "hello")).toBe("engines");
    expect(nextBeat(beats, "bot")).toBeNull();
    expect(previousBeat(beats, "engines")).toBe("hello");
    expect(previousBeat(beats, "hello")).toBeNull();
    expect(nextBeat(beats, "reel")).toBeNull();
  });

  it("gives the engines beat the widest card", () => {
    expect(beatWidth("engines")).toBeGreaterThan(beatWidth("hello"));
    expect(beatWidth("bot")).toBeGreaterThan(beatWidth("hello"));
  });
});

describe("the roster the beat walks through", () => {
  const scout = { id: "a", name: "Scout", title: "Research", description: "Research companies and people." };
  const mercury = { id: "b", name: "Mercury", title: "Inbox & Calendar", description: "Triage Gmail." };
  const curator = { id: "c", name: "Curator", title: "Briefs", description: "Write the brief." };

  it("lists the provisioned agents in the order it is given them", () => {
    expect(agentRoster([scout, mercury, curator]).map((entry) => entry.name)).toEqual(["Scout", "Mercury", "Curator"]);
  });

  it("carries the role line and the server's own description", () => {
    expect(agentRoster([mercury])).toEqual([
      { id: "b", name: "Mercury", title: "Inbox & Calendar", description: "Triage Gmail." },
    ]);
  });

  it("leaves out a bot the person hid, as the sidebar does", () => {
    expect(agentRoster([scout, { ...mercury, hidden: true }]).map((e) => e.name)).toEqual(["Scout"]);
  });

  it("copes with a bot nobody titled or described", () => {
    expect(agentRoster([{ id: "z", name: "New bot" }])).toEqual([{ id: "z", name: "New bot", title: "", description: "" }]);
  });

  it("trims what it shows, and never invents a title", () => {
    const [entry] = agentRoster([{ id: "a", name: "  Scout  ", title: "  Research  ", description: "  Finds things.  " }]);
    expect(entry).toEqual({ id: "a", name: "Scout", title: "Research", description: "Finds things." });
    const [bare] = agentRoster([{ id: "a", name: "Bot" }]);
    expect(bare.title).toBe("");
  });

  it("is empty for an empty workspace, which the beat says out loud", () => {
    expect(agentRoster([])).toEqual([]);
  });

  it("includes a bot a teammate added, because it reads the live roster", () => {
    expect(agentRoster([scout, { id: "new", name: "Legal", title: "Contracts", description: "Reads contracts." }]).map((e) => e.name))
      .toEqual(["Scout", "Legal"]);
  });
});
