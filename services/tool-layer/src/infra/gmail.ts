export const GMAIL_INTERNAL_PATHS = {
  messagesList: "/api/internal/gmail/messages/list",
  messagesGet: "/api/internal/gmail/messages/get",
  send: "/api/internal/gmail/send",
} as const;

export interface GmailMessageSummary {
  id: string;
  threadId?: string | null;
}

export interface GmailMessage {
  id: string;
  threadId?: string | null;
  from?: string;
  to?: string;
  subject?: string;
  date?: string;
  snippet?: string;
}

export interface GmailSentMessage {
  id?: string | null;
  threadId?: string | null;
}

export class GmailRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "GmailRequestError";
    this.status = status;
  }
}

export interface RelayGmailClientOptions {
  bffInternalUrl: string;
  capability: string | undefined;
  fetcher?: typeof fetch;
}

/**
 * The Tool Layer never holds a Google credential. It authorizes the operation,
 * then asks the BFF to run it using the signed actor assertion it already
 * verified, and the BFF derives the mailbox from that verified identity.
 */
export class RelayGmailClient {
  private readonly bffInternalUrl: string;
  private readonly capability: string | undefined;
  private readonly fetcher: typeof fetch;

  constructor(options: RelayGmailClientOptions) {
    this.bffInternalUrl = options.bffInternalUrl.replace(/\/+$/, "");
    this.capability = options.capability;
    this.fetcher = options.fetcher ?? fetch;
  }

  private async call<Result>(path: string, actorAssertion: string, payload: unknown): Promise<Result> {
    if (typeof this.capability !== "string" || Buffer.byteLength(this.capability) < 32) {
      throw new GmailRequestError(503, "the Gmail connector service is not configured");
    }
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, this.bffInternalUrl), {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${this.capability}`,
          "x-relay-actor-user": actorAssertion,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch {
      throw new GmailRequestError(502, "the Gmail connector service is unreachable");
    }
    if (!response.ok) {
      throw new GmailRequestError(response.status, await safeErrorMessage(response));
    }
    return await response.json() as Result;
  }

  searchMessages(actorAssertion: string, input: { query: string; maxResults?: number }) {
    return this.call<{ account: { email: string }; messages: GmailMessageSummary[] }>(
      GMAIL_INTERNAL_PATHS.messagesList,
      actorAssertion,
      input,
    );
  }

  getMessage(actorAssertion: string, input: { messageId: string }) {
    return this.call<{ account: { email: string }; message: GmailMessage }>(
      GMAIL_INTERNAL_PATHS.messagesGet,
      actorAssertion,
      input,
    );
  }

  sendEmail(actorAssertion: string, input: { to: string[]; cc?: string[]; bcc?: string[]; subject: string; body: string }) {
    return this.call<{ account: { email: string }; sent: { id?: string | null; threadId?: string | null }; to: string[]; cc: string[]; bcc: string[] }>(
      GMAIL_INTERNAL_PATHS.send,
      actorAssertion,
      input,
    );
  }
}

async function safeErrorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown };
    return typeof body.error === "string" && body.error.length > 0 && body.error.length <= 200
      ? body.error
      : "the Gmail request was refused";
  } catch {
    return "the Gmail request was refused";
  }
}