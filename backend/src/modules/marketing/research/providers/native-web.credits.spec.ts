import { NativeWebProvider } from "./native-web.provider";

describe("NativeWebProvider credit reservations", () => {
  const key = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
  });
  afterEach(() => {
    if (key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = key;
  });

  it.each(["search", "scrape"])(
    "requires a credit reservation before the platform %s call",
    async (operation) => {
      const anthropic = {
        assertApiAllowed: jest.fn(),
        recordExternalUsage: jest.fn().mockResolvedValue(undefined),
      };
      const credits = {
        reserveForJob: jest.fn().mockRejectedValue(new Error("cap")),
        refund: jest.fn(),
      };
      const provider = new NativeWebProvider(anthropic as any, credits as any);
      const create = jest.fn().mockResolvedValue({ content: [] });
      (provider as any).client = { messages: { create } };
      const call =
        operation === "search"
          ? provider.searchWeb("query", 8, "ws1")
          : provider.scrape("https://example.com", "ws1");
      await expect(call).rejects.toThrow("cap");
      expect(create).not.toHaveBeenCalled();
    },
  );

  it.each(["search", "scrape"])(
    "refunds the captured receipt if the %s API call throws",
    async (operation) => {
      const anthropic = {
        assertApiAllowed: jest.fn(),
        recordExternalUsage: jest.fn(),
      };
      const credits = {
        reserveForJob: jest.fn().mockResolvedValue(5),
        refund: jest.fn().mockResolvedValue(undefined),
      };
      const provider = new NativeWebProvider(anthropic as any, credits as any);
      (provider as any).client = {
        messages: {
          create: jest.fn().mockRejectedValue(new Error("vendor failed")),
        },
      };
      const call =
        operation === "search"
          ? provider.searchWeb("query", 8, "ws1")
          : provider.scrape("https://example.com", "ws1");
      await expect(call).rejects.toThrow("vendor failed");
      expect(credits.reserveForJob).toHaveBeenCalledWith(
        "ws1",
        operation === "search"
          ? "research.native_search"
          : "research.native_scrape",
      );
      expect(credits.refund).toHaveBeenCalledWith("ws1", 5);
    },
  );
});
