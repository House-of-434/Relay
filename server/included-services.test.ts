// Which credential a Jev request uses, and where it may go. The relay knows
// only the Admin's account: an own key must never reach it, and the included
// token must never reach the provider.
import { afterEach, describe, expect, it, vi } from "vitest";

import { jevEndpoint } from "./decider/jev.ts";
import { deciderCredential } from "./included-services.ts";

// A Jev base URL: the relay's one route is <this>/v1/systemone.
const RELAY_DECIDER = "https://cloud.example.test/api/cloud/services/decider";
const cloud = {
  RELAY_CLOUD_DECIDER_URL: RELAY_DECIDER,
  RELAY_CLOUD_DECIDER_TOKEN: "relay_decide_included",
};

describe("Jev credential", () => {
  // `api` is a Jev base URL: the backend adds /v1/systemone.
  const endpoint = (credential: ReturnType<typeof deciderCredential>) => String(jevEndpoint(credential?.api));

  it("falls back to the included token, sent only to the relay's one route, when there is no own key", () => {
    for (const own of [undefined, "", "   "]) {
      const credential = deciderCredential(own, undefined, cloud);
      expect(credential).toEqual({ token: "relay_decide_included", api: RELAY_DECIDER, included: true });
      expect(endpoint(credential)).toBe(`${RELAY_DECIDER}/v1/systemone`);
    }
  });

  it("uses the person's own key, sent only to Jev or their own base URL", () => {
    const own = deciderCredential(" tsk_own ", undefined, cloud);
    expect(own).toEqual({ token: "tsk_own", api: "https://api.typesafe.ai", included: false });
    expect(endpoint(own)).toBe("https://api.typesafe.ai/v1/systemone");
    const local = deciderCredential("tsk_own", "http://127.0.0.1:9", cloud);
    expect(local).toEqual({ token: "tsk_own", api: "http://127.0.0.1:9", included: false });
    expect(endpoint(local)).toBe("http://127.0.0.1:9/v1/systemone");
  });

  it("sends the included token only to the relay, whatever base URL is set for own keys", () => {
    expect(deciderCredential(undefined, "http://127.0.0.1:9", cloud)).toMatchObject({ token: "relay_decide_included", included: true });
    expect(endpoint(deciderCredential(undefined, "http://127.0.0.1:9", cloud))).toBe(`${RELAY_DECIDER}/v1/systemone`);
    // Pasted back as if it were an own key, it still goes only to the relay.
    expect(endpoint(deciderCredential("relay_decide_included", undefined, cloud))).toBe(`${RELAY_DECIDER}/v1/systemone`);
  });

  it("is included only when both the relay URL and the token are set", () => {
    expect(deciderCredential(undefined, undefined, {})).toBeNull();
    expect(deciderCredential(undefined, undefined, { RELAY_CLOUD_DECIDER_TOKEN: "relay_decide_included" })).toBeNull();
    expect(deciderCredential(undefined, undefined, { RELAY_CLOUD_DECIDER_URL: RELAY_DECIDER })).toBeNull();
    expect(deciderCredential(undefined, undefined, { RELAY_CLOUD_DECIDER_URL: RELAY_DECIDER, RELAY_CLOUD_DECIDER_TOKEN: "  " })).toBeNull();
    const slashed = deciderCredential(undefined, undefined, { RELAY_CLOUD_DECIDER_URL: `${RELAY_DECIDER}/`, RELAY_CLOUD_DECIDER_TOKEN: " relay_decide_included " });
    expect(slashed).toEqual({ token: "relay_decide_included", api: RELAY_DECIDER, included: true });
  });

  it("uses the relay URL as it is: the final URL is exactly <RELAY_CLOUD_DECIDER_URL>/v1/systemone", () => {
    for (const url of [RELAY_DECIDER, "https://relay.example.test/v1", "https://relay.example.test/a/v1/b"]) {
      const credential = deciderCredential(undefined, undefined, { RELAY_CLOUD_DECIDER_URL: url, RELAY_CLOUD_DECIDER_TOKEN: "relay_decide_included" });
      expect(credential?.api).toBe(url);
      expect(endpoint(credential)).toBe(`${url}/v1/systemone`);
    }
  });

  it("never takes another service's relay token", () => {
    const { RELAY_CLOUD_DECIDER_URL: _url, RELAY_CLOUD_DECIDER_TOKEN: _token, ...others } = cloud;
    expect(deciderCredential(undefined, undefined, others)).toBeNull();
  });
});

describe("holdIncludedServices", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("keeps the tokens in memory and removes them from the environment, so nothing started later inherits them", async () => {
    for (const [name, value] of Object.entries(cloud)) vi.stubEnv(name, value);
    // A fresh module: the hold is process-wide state.
    vi.resetModules();
    const services = await import("./included-services.ts");
    services.holdIncludedServices();
    expect(process.env.RELAY_CLOUD_DECIDER_TOKEN).toBeUndefined();
    // The URLs are not secrets and stay.
    expect(process.env.RELAY_CLOUD_DECIDER_URL).toBe(RELAY_DECIDER);
    expect(services.deciderCredential(undefined, undefined)).toEqual({ token: "relay_decide_included", api: RELAY_DECIDER, included: true });
    // The person's own key still wins, and still goes only to the provider.
    expect(services.deciderCredential("tsk_own", undefined)).toEqual({ token: "tsk_own", api: "https://api.typesafe.ai", included: false });
  });
});
