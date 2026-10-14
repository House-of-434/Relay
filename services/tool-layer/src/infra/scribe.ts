export const SCRIBE_INTERNAL_PATHS = {
  join: "/api/internal/scribe/join",
} as const;

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
  harnessInternalUrl: string;
  capability: string | undefined;
  fetcher?: typeof fetch;
}

/**
 * Ask the harness to capture a meeting now. The Tool Layer never touches the
 * capture worker: it authorizes the operation, then asks the harness (which
 * alone holds the worker capability) using the signed actor assertion it
 * already verified. The harness derives organizer identity from that verified
 * identity; the request body carries no identity fields.
 */
export class RelayScribeJoinClient {
  private readonly harnessInternalUrl: string;
  private readonly capability: string | undefined;
  private readonly fetcher: typeof fetch;

  constructor(options: RelayScribeJoinClientOptions) {
    this.harnessInternalUrl = options.harnessInternalUrl.replace(/\/+$/, "");
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
      response = await this.fetcher(new URL(SCRIBE_INTERNAL_PATHS.join, this.harnessInternalUrl), {
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
