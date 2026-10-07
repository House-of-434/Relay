import { describe, expect, it, vi } from "vitest";
import { clearTourSeen, readTourSeen, tourSeenComplete, tourStorage, writeTourSeen, type StorageLike } from "./first-run";

function memory(initial?: string | null): StorageLike & { value: string | null } {
  const store = {
    value: initial ?? null,
    getItem: () => store.value,
    setItem: (_key: string, value: string) => { store.value = value; },
    removeItem: () => { store.value = null; },
  };
  return store;
}

describe("the tour's browser record", () => {
  it("starts empty and keeps each step once", () => {
    const storage = memory();
    expect(readTourSeen(storage)).toEqual([]);
    expect(writeTourSeen(storage, "tour.composer")).toEqual(["tour.composer"]);
    expect(writeTourSeen(storage, "tour.tools")).toEqual(["tour.composer", "tour.tools"]);
    // a repeat writes nothing and returns the same list
    expect(writeTourSeen(storage, "tour.composer")).toEqual(["tour.composer", "tour.tools"]);
    expect(JSON.parse(storage.value!)).toEqual(["tour.composer", "tour.tools"]);
  });

  it("reads back what a previous visit wrote", () => {
    const storage = memory();
    writeTourSeen(storage, "tour.composer");
    writeTourSeen(storage, "spot.approval");
    expect(readTourSeen(storage)).toEqual(["tour.composer", "spot.approval"]);
  });

  it("drops anything that is not a step id this app generates", () => {
    // hand-edited, or left by a build whose steps no longer exist
    const storage = memory(JSON.stringify(["tour.composer", "admin", "", "tour.old", 42, null]));
    expect(readTourSeen(storage)).toEqual(["tour.composer"]);
  });

  it("reads nothing from storage that is missing, empty or not a list", () => {
    expect(readTourSeen(memory(null))).toEqual([]);
    expect(readTourSeen(memory(""))).toEqual([]);
    expect(readTourSeen(memory("{"))).toEqual([]);
    expect(readTourSeen(memory('{"tour.composer":true}'))).toEqual([]);
  });

  it("completes only when every step has been seen", () => {
    const steps = ["tour.composer", "tour.tools", "tour.done"];
    const storage = memory();
    expect(tourSeenComplete(storage, steps)).toBe(false);
    writeTourSeen(storage, "tour.composer");
    expect(tourSeenComplete(storage, steps)).toBe(false);
    for (const id of steps.slice(1)) writeTourSeen(storage, id);
    expect(tourSeenComplete(storage, steps)).toBe(true);
  });

  it("forgets everything on a replay", () => {
    const storage = memory();
    writeTourSeen(storage, "tour.composer");
    clearTourSeen(storage);
    expect(readTourSeen(storage)).toEqual([]);
    expect(tourSeenComplete(storage, ["tour.composer"])).toBe(false);
  });

  it("does nothing at all without storage", () => {
    // a private window, or blocked cookies: the tour still runs, it just
    // cannot remember. Nothing here may throw.
    expect(readTourSeen(null)).toEqual([]);
    expect(writeTourSeen(null, "tour.composer")).toEqual(["tour.composer"]);
    expect(tourSeenComplete(null, ["tour.composer"])).toBe(false);
    expect(() => clearTourSeen(null)).not.toThrow();
  });

  it("survives storage that throws on read and on write", () => {
    const hostile: StorageLike = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    };
    expect(readTourSeen(hostile)).toEqual([]);
    expect(writeTourSeen(hostile, "tour.composer")).toEqual(["tour.composer"]);
    expect(() => clearTourSeen(hostile)).not.toThrow();
  });

  it("reports no storage where there is none", () => {
    vi.stubGlobal("localStorage", undefined);
    try {
      expect(tourStorage()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
    // and where reading the property throws, as blocked cookies do
    vi.stubGlobal("localStorage", { get getItem(): never { throw new Error("blocked"); } });
    try {
      expect(tourStorage()).not.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

