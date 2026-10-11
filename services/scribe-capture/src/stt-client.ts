/** STT client. The worker sends 16 kHz mono WAV and receives text. Kept behind
 * this interface so the model/transport is swappable (Parakeet int8 today,
 * Canary or Vexa's stt.v1 multipart contract later) without touching capture. */

export interface Transcription {
  text: string;
  audio_seconds?: number;
}

export interface SttClient {
  transcribe(wav: Buffer): Promise<Transcription>;
}

export interface HttpSttClientOptions {
  baseUrl: string;
  path?: string;
  fetcher?: typeof fetch;
}

export class SttError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SttError";
  }
}

export class HttpSttClient implements SttClient {
  private readonly url: string;
  private readonly fetcher: typeof fetch;

  constructor(options: HttpSttClientOptions) {
    this.url = options.baseUrl.replace(/\/+$/, "") + (options.path ?? "/transcribe");
    this.fetcher = options.fetcher ?? fetch;
  }

  async transcribe(wav: Buffer): Promise<Transcription> {
    let response: Response;
    try {
      response = await this.fetcher(this.url, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(wav),
      });
    } catch {
      throw new SttError("the STT server is unreachable");
    }
    if (!response.ok) throw new SttError(`STT rejected with ${response.status}`);
    const body = await response.json() as { text?: unknown; audio_seconds?: unknown };
    return {
      text: typeof body.text === "string" ? body.text : "",
      audio_seconds: typeof body.audio_seconds === "number" ? body.audio_seconds : undefined,
    };
  }
}

/** Wrap raw 16 kHz mono int16 PCM as a WAV container. */
export function pcm16ToWav(pcm: Buffer, sampleRate = 16_000): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
