// The Jev decision model included with Cloud Pro (docs/cloud-pro.md).
// The Admin relays it on its own account, so its provider key never reaches
// this machine; each Cloud home gets its own relay token:
//
//   RELAY_CLOUD_DECIDER_URL + RELAY_CLOUD_DECIDER_TOKEN  the Jev relay, a Jev base URL
//
// An included token is only a fallback. The person's own key (Settings, or
// RELAY_JEV_API_KEY) always wins, and removing it falls back again, so the
// credential is resolved on every request, never cached. An included token is
// never written to config.json, never reported to a client, and never the
// saved key Settings verifies, rotates or clears.
import { JEV_DEFAULT_BASE_URL } from "./decider/jev.ts";

/** Also on WORKSPACE_CREDENTIAL_ENV (config.ts). */
export const INCLUDED_TOKEN_ENV = ["RELAY_CLOUD_DECIDER_TOKEN"] as const;

export interface ServiceCredential {
  token: string;
  /** The only base URL this token is ever sent to. */
  api: string;
  /** Cloud Pro's included token, not the person's own key. */
  included: boolean;
}

interface Included {
  decider: ServiceCredential | null;
}

function includedService(url: string | undefined, token: string | undefined): ServiceCredential | null {
  const api = url?.trim().replace(/\/+$/, "");
  const secret = token?.trim();
  return api && secret ? { token: secret, api, included: true } : null;
}

const includedFrom = (env: NodeJS.ProcessEnv): Included => ({
  // A Jev base URL as it is: the decider adds /v1/systemone, the relay's one route.
  decider: includedService(env.RELAY_CLOUD_DECIDER_URL, env.RELAY_CLOUD_DECIDER_TOKEN),
});

let held: Included | null = null;

/** At server startup: keep the included tokens in memory and drop them from
 * the environment, as with the Cloud bootstrap secret, so nothing the server
 * starts can inherit them. Before this (tests, scripts) they are read from
 * the environment on each call. */
export function holdIncludedServices(env: NodeJS.ProcessEnv = process.env): void {
  held = includedFrom(env);
  for (const name of INCLUDED_TOKEN_ENV) delete env[name];
}

function resolve(own: string | undefined, providerApi: string, included: ServiceCredential | null): ServiceCredential | null {
  if (own) {
    // A leased computer descriptor hands the token in use back as a plain
    // token; the included one still goes only to its relay.
    if (included && own === included.token) return included;
    return { token: own, api: providerApi, included: false };
  }
  return included;
}

/** The decision model's credential in use: the person's own Jev key (saved,
 * or RELAY_JEV_API_KEY) with their `decider.baseUrl` or Jev's own, else the
 * included token with the relay. `api` is a Jev base URL. */
export function deciderCredential(
  own: string | undefined,
  ownBaseUrl: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ServiceCredential | null {
  return resolve(own?.trim(), ownBaseUrl?.trim() || JEV_DEFAULT_BASE_URL, (held ?? includedFrom(env)).decider);
}
