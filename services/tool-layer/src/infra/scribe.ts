export const SCRIBE_INTERNAL_PATHS = {
  join: "/api/internal/scribe/join",
} as const;

/** Native meeting id from a URL, mirroring the capture worker's nativeIdFor
 * (services/scribe-capture/src/urls.ts) — Meet path code, Zoom /j|wc|s id,
 * Teams /meet id. Kept in sync by the parity tests below; the worker remains
 * the source of truth for joining. */
export function nativeIdForUrl(url: string): { platform: "google_meet" | "zoom" | "teams"; nativeId: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "meet.google.com") {
    const code = parsed.pathname.replace(/^\//, "").split("/")[0];
    return code ? { platform: "google_meet", nativeId: code } : null;
  }
  const zoom = host === "zoom.us" || host.endsWith(".zoom.us");
  const teams = host === "teams.microsoft.com" || host === "teams.live.com";
  if (!zoom && !teams) return null;
  const seg = parsed.pathname.split("/").filter(Boolean);
  const markers = zoom ? ["j", "wc", "s"] : ["meet"];
  const i = seg.findIndex((s) => markers.includes(s));
  const id = i >= 0 ? seg[i + 1] : undefined;
  if (!id) return null;
  return { platform: zoom ? "zoom" : "teams", nativeId: id };
}

export interface ScribeJoinResult {
  status: "accepted" | "already_accepted";
  instance_id: string;
}

export class ScribeRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ScribeRequestError";
    this.status = status;
  }
}

export interface RelayScribeJoinClientOptions {
  bffInternalUrl: string;
  capability: string | undefined;
  fetcher?: typeof fetch;
}

/**
 * Ask Scribe to capture a meeting now, via the BFF. The Tool Layer cannot
 * call the harness directly (the harness edge gate requires a loopback
 * Host, and compose callers address it by container name), so this client
 * targets the BFF's join route with the same dual auth as the Gmail and
 * Calendar clients. The BFF verifies both and proxies to the harness over
 * loopback, where both are verified again. The Tool Layer never touches the
 * capture worker: it authorizes the operation, and the harness (which alone
 * holds the worker capability) executes it.
 */
export class RelayScribeJoinClient {
  private readonly bffInternalUrl: string;
  private readonly capability: string | undefined;
  private readonly fetcher: typeof fetch;

  constructor(options: RelayScribeJoinClientOptions) {
    this.bffInternalUrl = options.bffInternalUrl.replace(/\/+$/, "");
    this.capability = options.capability;
    this.fetcher = options.fetcher ?? fetch;
  }

  async joinMeeting(
    actorAssertion: string,
    input: { requestKey: string; meetingUrl: string; title?: string },
  ): Promise<ScribeJoinResult> {
    if (typeof this.capability !== "string" || Buffer.byteLength(this.capability) < 32) {
      throw new ScribeRequestError(503, "the meeting capture service is not configured");
    }
    let response: Response;
    try {
      response = await this.fetcher(new URL(SCRIBE_INTERNAL_PATHS.join, this.bffInternalUrl), {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${this.capability}`,
          "x-relay-actor-user": actorAssertion,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          request_key: input.requestKey,
          meeting_url: input.meetingUrl,
          ...(input.title ? { title: input.title } : {}),
        }),
      });
    } catch {
      throw new ScribeRequestError(502, "the meeting capture service is unreachable");
    }
    if (!response.ok) {
      throw new ScribeRequestError(response.status, await safeErrorMessage(response));
    }
    const body = await response.json() as { status?: unknown; instance_id?: unknown };
    if ((body.status !== "accepted" && body.status !== "already_accepted") || typeof body.instance_id !== "string") {
      throw new ScribeRequestError(502, "the meeting capture service answered unexpectedly");
    }
    return { status: body.status, instance_id: body.instance_id };
  }
}

async function safeErrorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown };
    return typeof body.error === "string" && body.error.length > 0 && body.error.length <= 200
      ? body.error
      : "the capture request was refused";
  } catch {
    return "the capture request was refused";
  }
}
