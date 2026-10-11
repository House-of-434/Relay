import type { ScribeDescriptor } from "./scribe-monitor.ts";

/** Posts a descriptor to the capture worker's /join. The worker capability is
 * held in memory by the harness (PR 0 pattern) and passed in here — never an
 * environment variable an engine could inherit. */
export function createWorkerJoinClient(options: {
  url: string;
  capability: string | undefined;
  fetcher?: typeof fetch;
}): (descriptor: ScribeDescriptor) => Promise<{ status: string }> {
  const fetcher = options.fetcher ?? fetch;
  const joinUrl = new URL("/join", options.url).toString();
  return async (descriptor: ScribeDescriptor) => {
    if (typeof options.capability !== "string" || options.capability.length === 0) {
      throw new Error("the scribe worker capability is not configured");
    }
    const response = await fetcher(joinUrl, {
      method: "POST",
      redirect: "error",
      headers: { authorization: `Bearer ${options.capability}`, "content-type": "application/json" },
      body: JSON.stringify(descriptor),
    });
    if (!response.ok) throw new Error(`worker join failed (${response.status})`);
    return await response.json() as { status: string };
  };
}
