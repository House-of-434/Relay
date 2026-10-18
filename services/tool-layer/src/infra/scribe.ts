export const SCRIBE_INTERNAL_PATHS = {
  join: "/api/internal/scribe/join",
  stop: "/api/internal/scribe/stop",
} as const;

export interface ScribeJoinResult {
  status: "accepted" | "already_accepted";
  instance_id: string;
}

export interface ScribeStopResult {
  status: "stopped" | "not_recording";
  instance_id?: string;
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

  /** Stop a live capture the actor requested, by its meeting link or captured
   *  instance id. Returns stopped, or not_recording when nothing is live. */
  async stopMeeting(
    actorAssertion: string,
    input: { meetingUrl?: string; instanceId?: string },
  ): Promise<ScribeStopResult> {
    if (typeof this.capability !== "string" || Buffer.byteLength(this.capability) < 32) {
      throw new ScribeRequestError(503, "the meeting capture service is not configured");
    }
    let response: Response;
    try {
      response = await this.fetcher(new URL(SCRIBE_INTERNAL_PATHS.stop, this.bffInternalUrl), {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${this.capability}`,
          "x-relay-actor-user": actorAssertion,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...(input.instanceId ? { instance_id: input.instanceId } : {}),
          ...(input.meetingUrl ? { meeting_url: input.meetingUrl } : {}),
        }),
      });
    } catch {
      throw new ScribeRequestError(502, "the meeting capture service is unreachable");
    }
    if (!response.ok) {
      throw new ScribeRequestError(response.status, await safeErrorMessage(response));
    }
    const body = await response.json() as { status?: unknown; instance_id?: unknown };
    if (body.status !== "stopped" && body.status !== "not_recording") {
      throw new ScribeRequestError(502, "the meeting capture service answered unexpectedly");
    }
    return {
      status: body.status,
      ...(typeof body.instance_id === "string" ? { instance_id: body.instance_id } : {}),
    };
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
