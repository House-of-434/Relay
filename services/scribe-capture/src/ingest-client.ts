import type { MeetingRow, Segment } from "./types.js";

export interface IngestResult {
  meeting_id: string;
  upserted: number;
}

export class IngestConflictError extends Error {
  constructor(readonly instanceId: string) {
    super(`live meeting conflict for ${instanceId}`);
    this.name = "IngestConflictError";
  }
}

export class IngestClientError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "IngestClientError";
  }
}

export interface IngestClientOptions {
  url: string;
  capability: string | undefined;
  fetcher?: typeof fetch;
}

/** Writes meeting rows and segments through the Tool Layer ingest route. The
 * route is the single DB gate; this client holds only the ingest capability. */
export class IngestClient {
  private readonly url: string;
  private readonly capability: string | undefined;
  private readonly fetcher: typeof fetch;

  constructor(options: IngestClientOptions) {
    this.url = options.url;
    this.capability = options.capability;
    this.fetcher = options.fetcher ?? fetch;
  }

  async post(meeting: MeetingRow, segments: Segment[]): Promise<IngestResult> {
    if (typeof this.capability !== "string" || Buffer.byteLength(this.capability) < 32) {
      throw new IngestClientError(503, "the transcript ingest capability is not configured");
    }
    let response: Response;
    try {
      response = await this.fetcher(this.url, {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${this.capability}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ meeting, segments }),
      });
    } catch {
      throw new IngestClientError(502, "the transcript ingest route is unreachable");
    }
    if (response.status === 409) {
      throw new IngestConflictError(meeting.instance_id);
    }
    if (!response.ok) {
      throw new IngestClientError(response.status, `ingest rejected with ${response.status}`);
    }
    return await response.json() as IngestResult;
  }
}
