import { safeFetch } from "../../../common/util/safe-fetch";
import { LocalInferenceService } from "./local-inference.service";

jest.mock("../../../common/util/safe-fetch", () => ({ safeFetch: jest.fn() }));

const ENDPOINT = "http://local-ai:8000";
const TOKEN = "local-test-token-with-at-least-32-characters";
const AUDIO_LIMIT = 8 * 1024 * 1024;

/** Leave the stream open so a rejected response must cancel it, not drain it. */
function streamedResponse(chunks: Uint8Array[], headers?: HeadersInit) {
  let next = 0;
  const cancel = jest.fn();
  const response = new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (next < chunks.length) controller.enqueue(chunks[next++]);
        },
        cancel,
      },
      { highWaterMark: 0 },
    ),
    { headers },
  );
  return { response, cancel };
}

describe("Local inference boundary", () => {
  const original = process.env;
  const oldFetch = global.fetch;
  const safeFetchMock = jest.mocked(safeFetch);

  beforeEach(() => {
    process.env = {
      ...original,
      LOCAL_AI_URL: ENDPOINT,
      LOCAL_AI_TOKEN: TOKEN,
    };
    global.fetch = jest.fn();
    safeFetchMock.mockReset();
  });
  afterEach(() => {
    process.env = original;
    global.fetch = oldFetch;
    jest.useRealTimers();
  });

  function classification(label = "satış") {
    return new Response(
      JSON.stringify({ label, score: 0.9, model: "local-nli" }),
    );
  }

  it("does not fetch when the local service is absent", async () => {
    delete process.env.LOCAL_AI_URL;
    delete process.env.LOCAL_AI_TOKEN;
    await expect(
      new LocalInferenceService().classify("hello", ["a", "b"]),
    ).rejects.toThrow("LOCAL_AI_NOT_CONFIGURED");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns the pretrained classification without an unbounded response.text read", async () => {
    const response = classification();
    jest
      .spyOn(response, "text")
      .mockRejectedValue(new Error("unbounded body read"));
    jest.mocked(global.fetch).mockResolvedValue(response);
    expect(
      await new LocalInferenceService().classify("Fiyat?", ["satış", "destek"]),
    ).toEqual({ label: "satış", score: 0.9, model: "local-nli" });
    expect(global.fetch).toHaveBeenCalledWith(
      `${ENDPOINT}/classify`,
      expect.objectContaining({
        redirect: "error",
        signal: expect.anything(),
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
        },
      }),
    );
  });

  it("accepts one candidate and counts Unicode characters like the local server", async () => {
    const label = "😀".repeat(96);
    jest.mocked(global.fetch).mockResolvedValue(classification(label));
    expect(
      await new LocalInferenceService().classify("😀".repeat(4096), [label]),
    ).toMatchObject({ label, score: 0.9 });
  });

  it("accepts the exact text and label-count limits", async () => {
    const labels = Array.from({ length: 16 }, (_, index) =>
      `${index}`.padEnd(96, "x"),
    );
    jest.mocked(global.fetch).mockResolvedValue(classification(labels[0]));
    expect(
      await new LocalInferenceService().classify("x".repeat(4096), labels),
    ).toMatchObject({ label: labels[0] });
  });

  it.each([
    ["non-string text", 123, ["a", "b"]],
    ["missing text", undefined, ["a", "b"]],
    ["blank text", "  ", ["a", "b"]],
    ["oversized text", "x".repeat(4097), ["a", "b"]],
    ["no labels", "ok", []],
    [
      "too many labels",
      "ok",
      Array.from({ length: 17 }, (_, index) => String(index)),
    ],
    ["oversized label", "ok", ["a".repeat(97), "b"]],
    ["non-string label", "ok", [null, "b"]],
    ["sparse labels", "ok", Array(2)],
    ["blank label", "ok", [" ", "b"]],
    ["duplicate labels", "ok", ["a", "a"]],
    ["duplicate trimmed labels", "ok", ["a", " a "]],
    ["non-array labels", "ok", "a"],
  ])("rejects %s before any fetch", async (_name, text, labels) => {
    await expect(
      new LocalInferenceService().classify(text as any, labels as any),
    ).rejects.toThrow("LOCAL_AI_INVALID_INPUT");
    expect(global.fetch).not.toHaveBeenCalled();
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it("enforces the raw JSON byte limit as well as character limits", async () => {
    const labels = Array.from({ length: 16 }, (_, index) =>
      String(index).padEnd(96, "\u0000"),
    );
    await expect(
      new LocalInferenceService().classify("\u0000".repeat(4096), labels),
    ).rejects.toThrow("LOCAL_AI_INVALID_INPUT");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each([
    { label: "invented", score: 0.9, model: "model" },
    { label: "a", score: -0.1, model: "model" },
    { label: "a", score: 1.1, model: "model" },
    { label: "a", score: "0.9", model: "model" },
    { label: "a", score: null, model: "model" },
    { label: "a", score: 0.9, model: "" },
    { label: "a", score: 0.9, model: " " },
    { label: "a", score: 0.9, model: 1 },
    null,
  ])("rejects malformed classifier output %#", async (result) => {
    jest
      .mocked(global.fetch)
      .mockResolvedValue(new Response(JSON.stringify(result)));
    await expect(
      new LocalInferenceService().classify("hello", ["a", "b"]),
    ).rejects.toThrow("LOCAL_AI_INVALID_RESULT");
  });

  it.each([undefined, { "content-length": "1" }])(
    "stops and cancels oversized response streams even with a missing/false length: %j",
    async (headers) => {
      const { response, cancel } = streamedResponse(
        [new Uint8Array(8192), new Uint8Array(8193)],
        headers,
      );
      jest.mocked(global.fetch).mockResolvedValue(response);
      await expect(
        new LocalInferenceService().classify("hello", ["a", "b"]),
      ).rejects.toThrow("LOCAL_AI_UNAVAILABLE");
      expect(cancel).toHaveBeenCalledTimes(1);
    },
  );

  it("cancels responses rejected by Content-Length before consuming bytes", async () => {
    const { response, cancel } = streamedResponse([], {
      "content-length": "16385",
    });
    jest.mocked(global.fetch).mockResolvedValue(response);
    await expect(
      new LocalInferenceService().classify("hello", ["a", "b"]),
    ).rejects.toThrow("LOCAL_AI_UNAVAILABLE");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("cancels unsuccessful response bodies without buffering error pages", async () => {
    const cancel = jest.fn();
    const body = new ReadableStream({ cancel });
    jest
      .mocked(global.fetch)
      .mockResolvedValue(new Response(body, { status: 503 }));
    await expect(
      new LocalInferenceService().classify("hello", ["a", "b"]),
    ).rejects.toThrow("LOCAL_AI_UNAVAILABLE");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("bounds a stalled response body after headers arrive", async () => {
    jest.useFakeTimers();
    const { response, cancel } = streamedResponse([]);
    jest.mocked(global.fetch).mockResolvedValue(response);
    const outcome = expect(
      new LocalInferenceService().classify("hello", ["a", "b"]),
    ).rejects.toThrow("LOCAL_AI_UNAVAILABLE");
    await jest.advanceTimersByTimeAsync(150_000);
    await outcome;
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    "not-a-url",
    "file:///etc/passwd",
    "http://user:pass@local-ai",
    `${ENDPOINT}?secret=x`,
    `${ENDPOINT}#fragment`,
  ])(
    "rejects invalid configured endpoint %s before fetching",
    async (endpoint) => {
      process.env.LOCAL_AI_URL = endpoint;
      await expect(
        new LocalInferenceService().classify("hello", ["a", "b"]),
      ).rejects.toThrow("LOCAL_AI_INVALID_ENDPOINT");
      expect(global.fetch).not.toHaveBeenCalled();
    },
  );

  it("uploads audio bytes to LOCAL with the language hint", async () => {
    safeFetchMock.mockResolvedValue(new Response("audio bytes"));
    jest.mocked(global.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          text: " Merhaba ",
          language: "tr",
          model: "Systran/faster-whisper-base",
        }),
      ),
    );
    expect(
      await new LocalInferenceService().transcribeUrl(
        "https://recordings.example/test.wav",
        "tr",
      ),
    ).toEqual({ text: "Merhaba", provider: "local-whisper", language: "tr" });
    expect(safeFetchMock).toHaveBeenCalledWith(
      "https://recordings.example/test.wav",
      expect.objectContaining({ timeoutMs: 30_000, maxRedirects: 0 }),
    );
    const [url, init] = jest.mocked(global.fetch).mock.calls[0];
    expect(url).toBe(`${ENDPOINT}/transcribe`);
    const form = init!.body as FormData;
    expect(form.get("language")).toBe("tr");
    expect(await (form.get("file") as Blob).text()).toBe("audio bytes");
  });

  it("accepts exactly 8 MiB of audio", async () => {
    safeFetchMock.mockResolvedValue(new Response(new Uint8Array(AUDIO_LIMIT)));
    jest
      .mocked(global.fetch)
      .mockResolvedValue(
        new Response(
          JSON.stringify({ text: "", language: "tr", model: "whisper" }),
        ),
      );
    await expect(
      new LocalInferenceService().transcribeUrl(
        "https://recordings.example/test.wav",
      ),
    ).resolves.toMatchObject({ provider: "local-whisper" });
    const form = jest.mocked(global.fetch).mock.calls[0][1]!.body as FormData;
    expect((form.get("file") as Blob).size).toBe(AUDIO_LIMIT);
  });

  it.each([undefined, { "content-length": "1" }])(
    "cancels audio exceeding 8 MiB before posting to LOCAL: %j",
    async (headers) => {
      const { response, cancel } = streamedResponse(
        [new Uint8Array(AUDIO_LIMIT), new Uint8Array(1)],
        headers,
      );
      safeFetchMock.mockResolvedValue(response);
      await expect(
        new LocalInferenceService().transcribeUrl(
          "https://recordings.example/test.wav",
        ),
      ).rejects.toThrow("LOCAL_AUDIO_TOO_LARGE");
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(global.fetch).not.toHaveBeenCalled();
    },
  );

  it("cancels audio with an oversized declared length", async () => {
    const { response, cancel } = streamedResponse([], {
      "content-length": String(AUDIO_LIMIT + 1),
    });
    safeFetchMock.mockResolvedValue(response);
    await expect(
      new LocalInferenceService().transcribeUrl(
        "https://recordings.example/test.wav",
      ),
    ).rejects.toThrow("LOCAL_AUDIO_TOO_LARGE");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects empty audio before posting to LOCAL", async () => {
    safeFetchMock.mockResolvedValue(new Response(""));
    await expect(
      new LocalInferenceService().transcribeUrl(
        "https://recordings.example/test.wav",
      ),
    ).rejects.toThrow("LOCAL_AUDIO_INVALID");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("bounds stalled recording downloads even after safeFetch returns headers", async () => {
    jest.useFakeTimers();
    const { response, cancel } = streamedResponse([]);
    safeFetchMock.mockResolvedValue(response);
    const outcome = expect(
      new LocalInferenceService().transcribeUrl(
        "https://recordings.example/test.wav",
      ),
    ).rejects.toThrow("LOCAL_AUDIO_FETCH_FAILED");
    await jest.advanceTimersByTimeAsync(30_001);
    await outcome;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each([
    { text: "x".repeat(32769), language: "tr", model: "whisper" },
    { text: "text", language: 1, model: "whisper" },
    { text: "text", language: "tr" },
  ])("rejects malformed transcription output %#", async (result) => {
    safeFetchMock.mockResolvedValue(new Response("audio"));
    jest
      .mocked(global.fetch)
      .mockResolvedValue(new Response(JSON.stringify(result)));
    await expect(
      new LocalInferenceService().transcribeUrl(
        "https://recordings.example/test.wav",
      ),
    ).rejects.toThrow("LOCAL_AI_INVALID_RESULT");
  });

  it("fails when the decoder rejects audio over 120 seconds without changing providers", async () => {
    safeFetchMock.mockResolvedValue(
      new Response("compressed audio longer than two minutes"),
    );
    jest.mocked(global.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          detail: "Audio exceeds 120 seconds; split it into shorter clips",
        }),
        { status: 422 },
      ),
    );
    await expect(
      new LocalInferenceService().transcribeUrl(
        "https://recordings.example/test.wav",
      ),
    ).rejects.toThrow("LOCAL_AI_UNAVAILABLE");
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(jest.mocked(global.fetch).mock.calls[0][0]).toBe(
      `${ENDPOINT}/transcribe`,
    );
  });
});
