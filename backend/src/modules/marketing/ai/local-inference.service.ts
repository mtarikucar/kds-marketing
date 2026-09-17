import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { safeFetch } from "../../../common/util/safe-fetch";

const MAX_TEXT_CHARACTERS = 4096;
const MAX_LABELS = 16;
const MAX_LABEL_CHARACTERS = 96;
const MAX_CLASSIFY_REQUEST_BYTES = 32 * 1024;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_TRANSCRIPT_CHARACTERS = 32768;
const AUDIO_FETCH_TIMEOUT_MS = 30_000;
// Allow the server's 15s upload + 120s worker deadlines and time for the response.
const LOCAL_REQUEST_TIMEOUT_MS = 150_000;

function withinCharacterLimit(value: string, max: number): boolean {
  let count = 0;
  // Python measures Unicode code points, not JavaScript UTF-16 code units.
  for (const _character of value) if (++count > max) return false;
  return true;
}

function nonblankString(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    withinCharacterLimit(value, max) &&
    !!value.trim()
  );
}

/** Only the operator may configure this address; tenants cannot select network targets. */
@Injectable()
export class LocalInferenceService {
  isConfigured(): boolean {
    return !!(process.env.LOCAL_AI_URL && process.env.LOCAL_AI_TOKEN);
  }

  async classify(
    text: string,
    labels: string[],
  ): Promise<{ label: string; score: number; model: string }> {
    if (
      !nonblankString(text, MAX_TEXT_CHARACTERS) ||
      !Array.isArray(labels) ||
      labels.length < 1 ||
      labels.length > MAX_LABELS
    ) {
      throw new ServiceUnavailableException("LOCAL_AI_INVALID_INPUT");
    }
    const seen = new Set<string>();
    for (const label of labels) {
      if (
        !nonblankString(label, MAX_LABEL_CHARACTERS) ||
        seen.has(label.trim())
      ) {
        throw new ServiceUnavailableException("LOCAL_AI_INVALID_INPUT");
      }
      seen.add(label.trim());
    }
    const body = JSON.stringify({ text, labels });
    if (Buffer.byteLength(body, "utf8") > MAX_CLASSIFY_REQUEST_BYTES) {
      throw new ServiceUnavailableException("LOCAL_AI_INVALID_INPUT");
    }
    const result = await this.request("/classify", body, "application/json");
    if (
      !labels.includes(result?.label) ||
      typeof result.score !== "number" ||
      !Number.isFinite(result.score) ||
      result.score < 0 ||
      result.score > 1 ||
      !nonblankString(result.model, 256)
    ) {
      throw new ServiceUnavailableException("LOCAL_AI_INVALID_RESULT");
    }
    return { label: result.label, score: result.score, model: result.model };
  }

  async transcribeUrl(
    audioUrl: string,
    language?: string,
  ): Promise<{ text: string; provider: string; language?: string }> {
    this.endpoint(); // Refuse invalid/missing local configuration before fetching audio.
    const deadline = Date.now() + AUDIO_FETCH_TIMEOUT_MS;
    let response: Response;
    try {
      // safeFetch drains redirect bodies without a byte cap. Require the final
      // recording URL here so all accepted response bodies go through our reader.
      response = await safeFetch(audioUrl, {
        timeoutMs: AUDIO_FETCH_TIMEOUT_MS,
        maxRedirects: 0,
      });
    } catch {
      throw new ServiceUnavailableException("LOCAL_AUDIO_FETCH_FAILED");
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new ServiceUnavailableException("LOCAL_AUDIO_FETCH_FAILED");
    }
    const bytes = await this.readBounded(
      response,
      MAX_AUDIO_BYTES,
      deadline,
      "LOCAL_AUDIO_TOO_LARGE",
      "LOCAL_AUDIO_FETCH_FAILED",
    );
    if (!bytes.length)
      throw new ServiceUnavailableException("LOCAL_AUDIO_INVALID");
    const form = new FormData();
    form.append("file", new Blob([bytes]), "recording.audio");
    if (language !== undefined) form.append("language", language);
    // The local decoder enforces the 120-second limit on actual decoded samples.
    // Duration metadata from a remote URL cannot safely establish that limit here.
    const result = await this.request("/transcribe", form);
    if (
      typeof result?.text !== "string" ||
      !withinCharacterLimit(result.text, MAX_TRANSCRIPT_CHARACTERS) ||
      typeof result.language !== "string" ||
      !/^[a-z]{2,3}$/.test(result.language) ||
      !nonblankString(result.model, 256)
    ) {
      throw new ServiceUnavailableException("LOCAL_AI_INVALID_RESULT");
    }
    return {
      text: result.text.trim(),
      provider: "local-whisper",
      language: result.language,
    };
  }

  private endpoint(): string {
    if (!this.isConfigured())
      throw new ServiceUnavailableException("LOCAL_AI_NOT_CONFIGURED");
    try {
      const url = new URL(process.env.LOCAL_AI_URL!);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        throw new Error("Invalid endpoint");
      }
      return url.toString().replace(/\/$/, "");
    } catch {
      throw new ServiceUnavailableException("LOCAL_AI_INVALID_ENDPOINT");
    }
  }

  private async request(
    path: "/classify" | "/transcribe",
    body: string | FormData,
    contentType?: string,
  ): Promise<any> {
    const endpoint = this.endpoint();
    const controller = new AbortController();
    const deadline = Date.now() + LOCAL_REQUEST_TIMEOUT_MS;
    const timer = setTimeout(
      () => controller.abort(),
      LOCAL_REQUEST_TIMEOUT_MS,
    );
    try {
      const response = await fetch(endpoint + path, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${process.env.LOCAL_AI_TOKEN}`,
          ...(contentType ? { "Content-Type": contentType } : {}),
        },
        body,
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new Error(`status ${response.status}`);
      }
      const maxBytes = path === "/classify" ? 16 * 1024 : 256 * 1024;
      const bytes = await this.readBounded(
        response,
        maxBytes,
        deadline,
        "LOCAL_AI_UNAVAILABLE",
        "LOCAL_AI_UNAVAILABLE",
      );
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      throw new ServiceUnavailableException(
        "LOCAL_AI_UNAVAILABLE: Yerel model yanıt vermedi; ücretli API kullanılmadı.",
      );
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  private async readBounded(
    response: Response,
    maxBytes: number,
    deadline: number,
    tooLarge: string,
    unavailable: string,
  ): Promise<Buffer<ArrayBuffer>> {
    if (!response.body) throw new ServiceUnavailableException(unavailable);
    const length = response.headers.get("content-length");
    if (
      length !== null &&
      (!/^\d+$/.test(length) || Number(length) > maxBytes)
    ) {
      void response.body.cancel().catch(() => undefined);
      throw new ServiceUnavailableException(
        /^\d+$/.test(length) ? tooLarge : unavailable,
      );
    }
    const reader = response.body.getReader();
    let timer: ReturnType<typeof setTimeout>;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new ServiceUnavailableException(unavailable)),
        Math.max(0, deadline - Date.now()),
      );
    });
    const read = async () => {
      // Fixed allocation also bounds overhead from many tiny/empty stream chunks.
      const buffer = Buffer.allocUnsafe(maxBytes);
      let size = 0;
      for (;;) {
        if (Date.now() >= deadline)
          throw new ServiceUnavailableException(unavailable);
        const { done, value } = await reader.read();
        if (done) return buffer.subarray(0, size);
        if (value.byteLength > maxBytes - size)
          throw new ServiceUnavailableException(tooLarge);
        buffer.set(value, size);
        size += value.byteLength;
      }
    };
    try {
      return await Promise.race([read(), expired]);
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException(unavailable);
    } finally {
      clearTimeout(timer);
      // Do not wait forever for a remote/malformed stream's cancellation promise.
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}
