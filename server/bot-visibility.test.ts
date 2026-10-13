import { describe, expect, it } from "vitest";

import {
  audienceWithin,
  intersectAudience,
  narrowestAudience,
  frameForMember,
  memberBody,
  memberBot,
  noteSeen,
  parseVisibility,
  pathSubject,
  roomFeeds,
  routineVisible,
  sameAudience,
  NO_VIEWER,
  SEES_EVERYTHING,
  storedVisibility,
  VisibleSet,
  type FrameContext,
  type StreamSeen,
  type Viewer,
} from "./bot-visibility.ts";

const ADA: Viewer = { kind: "user", userId: "ada-uuid" };
const BOB: Viewer = { kind: "user", userId: "bob-uuid" };

const bots = [
  { id: "pub", threadId: "t-pub", section: "Ops", ownerUserId: "bob-uuid", tasks: [{ threadId: "t-pub" }, { threadId: "t-pub-2" }] },
  { id: "hr", threadId: "t-hr", section: "People", ownerUserId: "ada-uuid", avatarUrl: "/api/attachments/hr.png", tasks: [{ threadId: "t-hr" }] },
  { id: "adm", threadId: "t-adm", section: "People", ownerUserId: "bob-uuid" },
  { id: "corp", threadId: "t-corp", ownerUserId: "ada-uuid" },
  { id: "orphan", threadId: "t-orphan", section: "Orphan" },
  { id: "sys", threadId: "t-sys", ownerUserId: "system:relay" },
];
const groups = [
  { id: "room-pub", threadId: "t-room-pub", memberIds: ["pub"], section: "Ops", ownerUserId: "bob-uuid" },
  { id: "room-mixed", threadId: "t-room-mixed", memberIds: ["pub", "hr"], tasks: [{ threadId: "t-room-mixed-2" }], ownerUserId: "bob-uuid" },
  { id: "room-empty", threadId: "t-room-empty", memberIds: ["gone"], ownerUserId: "bob-uuid" },
  { id: "room-orphan", threadId: "t-room-orphan", memberIds: ["orphan"] },
];

describe("visibility values (retained audience plumbing)", () => {
  it("reads an admin's input and fails closed on anything it cannot read", () => {
    expect(parseVisibility("everyone")).toEqual({ ok: true, visibility: "everyone" });
    expect(parseVisibility(null)).toEqual({ ok: true, visibility: "everyone" });
    expect(parseVisibility(undefined).ok).toBe(false);
    expect(parseVisibility("admins")).toEqual({ ok: true, visibility: "admins" });
    expect(parseVisibility({ people: [" Ada@Example.test ", "ada@example.test", "@corp.test", ""] }))
      .toEqual({ ok: true, visibility: { people: ["ada@example.test", "@corp.test"] } });
    // a list that names nobody is admins only, never everyone
    expect(parseVisibility({ people: [] })).toEqual({ ok: true, visibility: "admins" });
    expect(parseVisibility({ people: ["not an email"] }).ok).toBe(false);
    expect(parseVisibility({ people: ["a@b.c"], extra: 1 }).ok).toBe(false);
    expect(parseVisibility("members").ok).toBe(false);
    expect(parseVisibility({ people: Array.from({ length: 501 }, (_, i) => `p${i}@x.test`) }).ok).toBe(false);

    expect(storedVisibility(undefined)).toBe("everyone");
    expect(storedVisibility("garbage")).toBe("admins");
    expect(storedVisibility({ people: "ada@example.test" })).toBe("admins");
  });

  it("knows when one audience sits inside another", () => {
    expect(audienceWithin({ people: ["ada@example.test"] }, undefined)).toBe(true);
    expect(audienceWithin(undefined, { people: ["ada@example.test"] })).toBe(false);
    expect(audienceWithin("admins", { people: ["ada@example.test"] })).toBe(true);
    expect(audienceWithin({ people: ["ada@example.test"] }, "admins")).toBe(false);
    expect(audienceWithin({ people: ["ada@example.test"] }, { people: ["ada@example.test", "bob@example.test"] })).toBe(true);
    expect(audienceWithin({ people: ["ada@example.test", "bob@example.test"] }, { people: ["ada@example.test"] })).toBe(false);
    expect(audienceWithin({ people: ["ada@example.test"] }, { people: ["@example.test"] })).toBe(true);
    expect(audienceWithin({ people: ["@example.test"] }, { people: ["ada@example.test"] })).toBe(false);
    // a room feeds a bot only when everyone who sees the bot sees every bot in it
    expect(roomFeeds([undefined, { people: ["ada@example.test"] }], undefined)).toBe(false);
    expect(roomFeeds([undefined, { people: ["ada@example.test"] }], { people: ["ada@example.test"] })).toBe(true);
    expect(roomFeeds([undefined, undefined], undefined)).toBe(true);
  });

  it("finds the people two audiences share", () => {
    expect(intersectAudience(undefined, "admins")).toBe("admins");
    expect(intersectAudience(undefined, undefined)).toBe("everyone");
    expect(intersectAudience({ people: ["ada@example.test"] }, undefined)).toEqual({ people: ["ada@example.test"] });
    expect(intersectAudience({ people: ["ada@example.test", "bob@example.test"] }, { people: ["bob@example.test", "cy@example.test"] })).toEqual({ people: ["bob@example.test"] });
    expect(intersectAudience({ people: ["@example.test"] }, { people: ["ada@example.test", "eve@other.test"] })).toEqual({ people: ["ada@example.test"] });
    expect(intersectAudience({ people: ["ada@example.test"] }, { people: ["bob@example.test"] })).toBe("admins");
    expect(narrowestAudience([undefined, { people: ["ada@example.test", "bob@example.test"] }, { people: ["ada@example.test"] }])).toEqual({ people: ["ada@example.test"] });
  });

  it("compares audiences exactly", () => {
    expect(sameAudience(undefined, "everyone")).toBe(true);
    expect(sameAudience(undefined, "admins")).toBe(false);
    expect(sameAudience({ people: ["a@x.test", "b@x.test"] }, { people: ["b@x.test", "a@x.test"] })).toBe(true);
    expect(sameAudience({ people: ["a@x.test"] }, { people: ["a@x.test", "b@x.test"] })).toBe(false);
    expect(sameAudience({ people: ["a@x.test"] }, "admins")).toBe(false);
  });
});

describe("VisibleSet (owner isolation)", () => {
  it("sees everything only for the reserved all-viewer", () => {
    const all = new VisibleSet(bots, groups, SEES_EVERYTHING);
    expect(all.everything).toBe(true);
    expect(all.bot("anything")).toBe(true);
    expect(all.thread("t-hr")).toBe(true);
  });

  it("answers bots, rooms, threads and sections by owner", () => {
    const bob = new VisibleSet(bots, groups, BOB);
    expect(bob.everything).toBe(false);
    expect([bob.bot("pub"), bob.bot("adm"), bob.bot("hr"), bob.bot("corp"), bob.bot("orphan"), bob.bot("sys"), bob.bot("unknown")])
      .toEqual([true, true, false, false, false, false, false]);
    // a room is visible only when the viewer owns it and every member is visible
    expect([bob.group("room-pub"), bob.group("room-mixed"), bob.group("room-empty"), bob.group("room-orphan")])
      .toEqual([true, false, false, false]);
    expect([bob.thread("t-pub-2"), bob.thread("t-hr"), bob.thread("t-room-mixed-2"), bob.thread("t-orphan"), bob.thread("t-unknown")])
      .toEqual([true, false, false, false, false]);
    expect(bob.sections(["Ops", "People", "Orphan", "Empty"])).toEqual(["Ops", "People", "Orphan", "Empty"]);

    const ada = new VisibleSet(bots, groups, ADA);
    expect([ada.bot("hr"), ada.bot("corp"), ada.bot("pub"), ada.group("room-mixed")]).toEqual([true, true, false, false]);
    expect(ada.sections(["Ops", "People"])).toEqual(["Ops", "People"]);
  });

  it("hides every ownerless and system:relay record from every user", () => {
    for (const viewer of [ADA, BOB, NO_VIEWER]) {
      const set = new VisibleSet(bots, groups, viewer);
      expect([set.bot("orphan"), set.bot("sys"), set.group("room-orphan"), set.thread("t-orphan"), set.thread("t-sys")])
        .toEqual([false, false, false, false, false]);
    }
  });

  it("refuses an attachment only when everything that uses it is hidden", () => {
    const bob = new VisibleSet(bots, groups, BOB);
    const refs: Record<string, string[]> = { "in-hr.png": ["t-hr"], "shared.png": ["t-hr", "t-pub"], "fresh.png": [] };
    const lookup = (name: string) => refs[name] ?? [];
    expect(bob.attachment("hr.png", lookup)).toBe(false); // another account's bot avatar
    expect(bob.attachment("in-hr.png", lookup)).toBe(false);
    expect(bob.attachment("shared.png", lookup)).toBe(true);
    expect(bob.attachment("fresh.png", lookup)).toBe(true);
    expect(new VisibleSet(bots, groups, ADA).attachment("in-hr.png", lookup)).toBe(true);
  });

  it("routes each path to the entity it names", () => {
    expect(pathSubject("/api/bots/hr/messages")).toEqual({ kind: "bot", id: "hr" });
    expect(pathSubject("/api/bots/hr")).toEqual({ kind: "bot", id: "hr" });
    expect(pathSubject("/api/threads/t-hr/export")).toEqual({ kind: "thread", id: "t-hr" });
    expect(pathSubject("/api/groups/room-mixed/read")).toEqual({ kind: "group", id: "room-mixed" });
    expect(pathSubject("/api/routines/r1/run")).toEqual({ kind: "routine", id: "r1" });
    expect(pathSubject("/api/routines/wake")).toBeNull();
    expect(pathSubject("/api/routine-runs/run1/seen")).toEqual({ kind: "routine-run", id: "run1" });
    expect(pathSubject("/api/routine-runs/seen-all")).toBeNull();
    expect(pathSubject("/api/attachments/a.png")).toEqual({ kind: "attachment", name: "a.png" });
    expect(pathSubject("/api/attachments")).toBeNull();
    expect(pathSubject("/api/bots")).toBeNull();
    expect(pathSubject("/api/groups")).toBeNull();
  });

  it("follows a routine to its room when it runs in one", () => {
    const bob = new VisibleSet(bots, groups, BOB);
    expect(routineVisible({ botId: "pub" }, bob)).toBe(true);
    expect(routineVisible({ botId: "hr" }, bob)).toBe(false);
    expect(routineVisible({ botId: "pub", groupId: "room-mixed" }, bob)).toBe(false);
  });
});

describe("live frames for a member", () => {
  const context = (visible: VisibleSet): FrameContext => ({
    visible,
    webhookBot: (id) => ({ "hook-hr": "hr", "hook-pub": "pub" } as Record<string, string>)[id],
    freshBot: (id) => ({ id, messages: [{ id: "m1" }] }),
    freshGroup: (id) => ({ id, messages: [] }),
  });
  const seen = (): StreamSeen => ({ bots: new Set(["pub", "corp"]), groups: new Set(["room-pub"]) });

  it("drops every frame about a hidden bot, thread or room", () => {
    const bob = new VisibleSet(bots, groups, BOB);
    const ctx = context(bob);
    const hidden: Array<Record<string, unknown>> = [
      { kind: "message", threadId: "t-hr", message: { id: "x" } },
      { kind: "message.patch", threadId: "t-room-mixed", message: { id: "x" } },
      { kind: "thread", threadId: "t-hr", activeLeafId: "x" },
      { kind: "bot", bot: { id: "hr" } },
      { kind: "group", group: { id: "room-mixed" } },
      { kind: "bot.deleted", botId: "hr" },
      { kind: "group.deleted", groupId: "room-mixed" },
      { kind: "notify", notification: { botId: "hr", threadId: "t-hr" } },
      { kind: "runtime", event: { type: "content.delta", threadId: "t-hr" } },
      { kind: "computer", botId: "corp", state: "waking" },
      { kind: "computer-control", botId: "corp", held: true },
      { kind: "routine", routine: { id: "r", botId: "hr" } },
      { kind: "routine.run", run: { id: "r", botId: "pub", groupId: "room-mixed" } },
      { kind: "webhook", webhook: { id: "hook-hr", botId: "hr" } },
      { kind: "webhook.attempt", attempt: { webhookId: "hook-hr" } },
      { kind: "future-kind", threadId: "t-hr" },
    ];
    for (const frame of hidden) expect(frameForMember(frame, ctx, seen()), JSON.stringify(frame)).toBeUndefined();
  });

  it("passes visible frames through untouched and narrows the lists", () => {
    const bob = new VisibleSet(bots, groups, BOB);
    const ctx = context(bob);
    const message = { kind: "message", threadId: "t-pub-2", message: { id: "x" } };
    expect(frameForMember(message, ctx, seen())).toBe(message);
    const hook = { kind: "webhook.attempt", attempt: { webhookId: "hook-pub" } };
    expect(frameForMember(hook, ctx, seen())).toBe(hook);
    expect(frameForMember({ kind: "sections", sections: ["Ops", "People"] }, ctx, seen())).toEqual({ kind: "sections", sections: ["Ops", "People"] });
    expect(frameForMember({ kind: "bot.queued", queues: { "t-pub": [1], "t-hr": [2] } }, ctx, seen())).toEqual({ kind: "bot.queued", queues: { "t-pub": [1] } });
    const config = { kind: "config", membership: {} };
    expect(frameForMember(config, ctx, seen())).toBe(config);
    // the owner's copy keeps its own visibility, and drops a teammate it cannot see
    expect(frameForMember({ kind: "bot", bot: { id: "pub", visibility: { people: ["@example.test"] }, peers: ["adm", "hr"] } }, ctx, seen()))
      .toEqual({ kind: "bot", bot: { id: "pub", visibility: { people: ["@example.test"] }, peers: ["adm"] } });
  });

  it("withdraws a bot once when it becomes hidden, and sends it whole when it appears", () => {
    const state = seen();
    const before = new VisibleSet(bots, groups, BOB);
    // Bob was shown "pub"; the bot is reassigned to Ada.
    const restricted = bots.map((bot) => (bot.id === "pub" ? { ...bot, ownerUserId: "ada-uuid" } : bot));
    const after = new VisibleSet(restricted, groups, BOB);
    expect(frameForMember({ kind: "bot", bot: { id: "pub" } }, context(after), state)).toEqual({ kind: "bot.deleted", botId: "pub" });
    expect(frameForMember({ kind: "bot", bot: { id: "pub" } }, context(after), state)).toBeUndefined();
    // and gives it back: the whole record, transcript page included
    expect(frameForMember({ kind: "bot", bot: { id: "pub", name: "Pub" } }, context(before), state))
      .toEqual({ kind: "bot", bot: { id: "pub", name: "Pub", messages: [{ id: "m1" }] } });
    expect(state.bots.has("pub")).toBe(true);
    // the same for a room
    const roomState = seen();
    const hiddenRoom = new VisibleSet(restricted, groups, BOB);
    expect(frameForMember({ kind: "group", group: { id: "room-pub" } }, context(hiddenRoom), roomState)).toEqual({ kind: "group.deleted", groupId: "room-pub" });
  });

  it("keeps a stream's record current while nothing is restricted", () => {
    const state: StreamSeen = { bots: new Set(), groups: new Set() };
    noteSeen({ kind: "bot", bot: { id: "new" } }, state);
    noteSeen({ kind: "group", group: { id: "room" } }, state);
    expect([...state.bots, ...state.groups]).toEqual(["new", "room"]);
    noteSeen({ kind: "bot.deleted", botId: "new" }, state);
    expect(state.bots.size).toBe(0);
  });

  it("narrows every bot in a JSON answer for a member", () => {
    const bob = new VisibleSet(bots, groups, BOB);
    const body = {
      bot: { id: "pub", visibility: { people: ["@example.test"] }, peers: ["adm", "hr"] },
      bots: [{ id: "pub", visibility: "everyone" }],
      result: { bot: { id: "corp", visibility: "admins" } },
      messages: [{ bot: { visibility: "untouched" } }],
      ok: true,
    };
    expect(memberBody(body, bob)).toEqual({
      bot: { id: "pub", visibility: { people: ["@example.test"] }, peers: ["adm"] },
      bots: [{ id: "pub", visibility: "everyone" }],
      result: { bot: { id: "corp", visibility: "admins" } },
      messages: [{ bot: { visibility: "untouched" } }],
      ok: true,
    });
    const all = new VisibleSet(bots, groups, SEES_EVERYTHING);
    expect(memberBody(body, all)).toBe(body);
  });

  it("strips nothing for someone who sees everything", () => {
    const bot = { id: "hr", visibility: "admins", peers: ["x"] };
    expect(memberBot(bot, new VisibleSet(bots, groups, SEES_EVERYTHING))).toBe(bot);
  });
});
