// Where a turn's hands land. The policy is small but every branch was a
// real confusion: an Auto task that hopped surfaces between turns, a plea
// that named no place.
import { describe, expect, it } from "vitest";

import {
  parseSurface,
  resolveSurface,
  surfaceForTool,
  surfaceOfComputerKind,
  surfacePrompt,
} from "./surface.ts";

describe("resolveSurface", () => {
  it("a computer destination mounts only that computer: one place per turn", () => {
    for (const destination of ["cloud", "vm", "local"] as const) {
      expect(resolveSurface({ destination })).toEqual({ computer: destination, pinned: null, clearPin: false, note: "" });
    }
  });

  it("Off mounts no computer, and says which setting did it", () => {
    const plan = resolveSurface({ destination: "off" });
    expect(plan).toMatchObject({ computer: "off", pinned: null, clearPin: false });
    expect(plan.note).toMatch(/"Works on" setting is Off/);
    expect(plan.note).toMatch(/no computer is mounted/);
    // nothing mounted, so the surface paragraph stays silent and only the
    // note tells the model why it has no screen
    expect(surfacePrompt({ computer: null }, { note: plan.note })).toBe(plan.note);
  });

  it("Off is the one setting a conversation pin cannot override", () => {
    expect(resolveSurface({ destination: "off", pinnedSurface: "cloud" }))
      .toMatchObject({ computer: "off", pinned: null, clearPin: false });
  });

  it("a conversation pin wins over the bot's default, whatever that default is", () => {
    // pinned to a computer while the bot is on Auto
    for (const destination of [undefined] as const) {
      for (const pin of ["cloud", "vm", "local"] as const) {
        expect(resolveSurface({ destination, pinnedSurface: pin }))
          .toEqual({ computer: pin, pinned: pin, clearPin: false, note: "" });
      }
    }
  });

  it("Auto without a pin leaves the computer to the dispatch", () => {
    expect(resolveSurface({ destination: undefined })).toEqual({
      computer: undefined,
      pinned: null,
      clearPin: false,
      note: "",
    });
  });
});

describe("surfacePrompt", () => {
  it("names only the computer when it is the only surface", () => {
    const text = surfacePrompt({ computer: "vm" });
    expect(text).toMatch(/happens on the Local VM, web pages included/);
    expect(text).toMatch(/say in one short sentence where you are working/);
    expect(surfacePrompt({ computer: "local" })).toMatch(/tell them it is on this computer/);
  });

  it("explains unavailable tools, and carries the pin line and the note", () => {
    expect(surfacePrompt({ computer: null })).toContain("No computer tools are mounted");
    expect(surfacePrompt({ computer: "cloud" }, { pinned: "cloud" }))
      .toContain("This conversation is pinned to the cloud computer; changing places requires");
    expect(surfacePrompt({ computer: null }, { note: " NOTE." })).toBe(" NOTE.");
  });

  it.each(["local", "vm", "cloud"] as const)("requires observed results on the actual %s tools", (place) => {
    const text = surfacePrompt({ computer: place });
    expect(text).toContain("verify its result before claiming success");
    expect(text).toContain("Announcing an action is not performing it");
    expect(text).toContain("never act on a different computer or describe a host window as a VM");
    expect(text).toContain("use OpenMausBot's mounted computer tools first");
    expect(text).toContain("Do not substitute the provider's own desktop");
  });

  it("chooses and starts configured targets through chat instead of requiring menu nudges", () => {
    const text = surfacePrompt({ computer: null }, { canSelect: true });
    expect(text).toContain("use select_computer with no arguments");
    expect(text).toContain("surface auto instead of asking them to operate the menu");
    expect(text).toContain("highlight the selected target");
    expect(text).toContain("then you must carry out the task");
    expect(text).not.toContain("ask the user to choose and connect a computer");
  });

  it("keeps explicit destinations and uses a turn-bound switch when supported", () => {
    const text = surfacePrompt({ computer: "local" }, { pinned: "local", canSelect: true });
    expect(text).toContain("select the requested available place");
    expect(text).toContain("changing places requires select_computer");
    expect(text).toContain("Never silently replace an explicitly requested VM with the host desktop");
    expect(text).not.toContain("ask the user to change the conversation's computer selector");
  });

  // Every shape of the paragraph a turn can get: each mount, pinned or not,
  // with and without select_computer.
  const mounts: Array<{ computer: "cloud" | null }> = [
    { computer: "cloud" }, { computer: null },
  ];
  const shapes = mounts.flatMap((mounted) => ([{}, { canSelect: true }, { canSelect: true, pinned: "cloud" }] as Array<{ canSelect?: boolean; pinned?: "cloud" }>)
    .map((opts) => ({ mounted, opts })));

  it("tells a Cloud home's bots only about the places it has", () => {
    for (const { mounted, opts } of shapes) {
      const text = surfacePrompt(mounted, { ...opts, cloudHome: true });
      expect(text, JSON.stringify({ mounted, opts })).not.toMatch(/Local VM|\bVM\b|host desktop|user's host|host window/);
      if (mounted.computer) {
        expect(text).toContain("the cloud computer is remote");
        expect(text).toContain("never act on a different computer.");
      }
      if (opts.canSelect) expect(text).toContain("select an available cloud computer without asking");
    }
  });

  it("leaves every other server's paragraph exactly as it was", () => {
    for (const { mounted, opts } of shapes) {
      expect(surfacePrompt(mounted, { ...opts, cloudHome: false })).toBe(surfacePrompt(mounted, opts));
    }
    expect(surfacePrompt({ computer: "cloud" }, { canSelect: true }))
      .toContain("this computer is the user's host, Local VM is an isolated desktop, and the cloud computer is remote");
  });
});

describe("surfaceForTool", () => {
  it("trusts the Claude driver's server namespace", () => {
    expect(surfaceForTool("mcp__computer__browser_snapshot", { computer: "cloud" })).toBe("cloud");
    expect(surfaceForTool("mcp__computer__screenshot", { computer: "local" })).toBe("local");
  });

  it("only trusts a bare name when a computer was mounted", () => {
    expect(surfaceForTool("screenshot", { computer: "vm" })).toBe("vm");
    expect(surfaceForTool("browser_navigate", { computer: null })).toBeNull();
    expect(surfaceForTool("Bash: ls", { computer: "vm" })).toBeNull();
    expect(surfaceForTool("Read", { computer: null })).toBeNull();
  });
});

describe("surface parsing", () => {
  it("accepts only the three surfaces off the wire", () => {
    expect(parseSurface("browser")).toBeUndefined();
    expect(parseSurface("cloud")).toBe("cloud");
    expect(parseSurface("box")).toBeUndefined();
    expect(parseSurface(42)).toBeUndefined();
    expect(parseSurface(undefined)).toBeUndefined();
  });

  it("folds both cloud backends into one surface", () => {
    expect(surfaceOfComputerKind("box")).toBe("cloud");
    expect(surfaceOfComputerKind("vps")).toBe("cloud");
    expect(surfaceOfComputerKind("vm")).toBe("vm");
    expect(surfaceOfComputerKind("local")).toBe("local");
    expect(surfaceOfComputerKind(null)).toBeNull();
  });
});


it("does not instruct use of a selected browser when no surface is mounted", () => {
  expect(surfacePrompt({ computer: null }, { canSelect: true })).not.toContain("For online research");
  expect(surfacePrompt({ computer: "cloud" })).toContain("For online research");
});
