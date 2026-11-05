import { describe, expect, it } from "vitest";
import { classifyClaude } from "../src/ai/claudeProvider.js";
import { classifyGemini, DUMMY_THOUGHT_SIGNATURE, GeminiProvider } from "../src/ai/geminiProvider.js";
import { AllProvidersDownError, ProviderError } from "../src/ai/types.js";
import { amountsIn, inventedAmounts, loadPriceList } from "../src/knowledge/prices.js";
import { bannedPhrases, removeBannedSentences, repeatedReply, reviewReply } from "../src/orchestrator/validation.js";
import { parseAnalysis, selectWorkflow } from "../src/orchestrator/decisionTree.js";
import { makeAi } from "./fakes.js";
import path from "node:path";
import { PROJECT_DIR } from "./harness.js";

const request = { purpose: "test", tier: "main" as const, system: "s", messages: [{ role: "user" as const, content: "salom" }] };

describe("AIProviderManager (TZ 16)", () => {
  it("uses Claude first", async () => {
    const { ai, claude, gemini } = makeAi(() => "ok");
    const response = await ai.chat(request);
    expect(response.provider).toBe("claude");
    expect(claude.calls).toHaveLength(1);
    expect(gemini.calls).toHaveLength(0);
  });

  it("switches to Gemini at once on an auth or billing failure, with the same request", async () => {
    const { ai, claude, gemini, events } = makeAi(() => "ok");
    claude.failure = new ProviderError("claude", "auth", "HTTP 401 authentication_error");
    const response = await ai.chat({ ...request, system: "full context" });
    expect(response.provider).toBe("gemini");
    expect(claude.calls).toHaveLength(1); // not retried
    expect(gemini.calls[0]?.system).toBe("full context");
    expect(events.map((e) => e.kind)).toEqual(["primary_down"]);
    expect(ai.status().circuitOpen).toBe(true);
  });

  it("retries a transient failure on Claude before switching", async () => {
    let n = 0;
    const { ai, claude } = makeAi((_req, provider) => {
      if (provider === "claude" && n++ === 0) return new ProviderError("claude", "server", "HTTP 500");
      return "ok";
    });
    const response = await ai.chat(request);
    expect(response.provider).toBe("claude");
    expect(claude.calls).toHaveLength(2);
  });

  it("keeps using Gemini while the circuit is open, probes Claude after the interval and goes back to it", async () => {
    const { ai, claude, gemini, events, clock } = makeAi(() => "ok", { probeIntervalMs: 300_000 });
    claude.failure = new ProviderError("claude", "billing", "credit balance is too low");
    await ai.chat(request);
    await ai.chat(request);
    expect(claude.calls).toHaveLength(1);
    expect(gemini.calls).toHaveLength(2);
    expect(await ai.probeIfDue()).toBe(false); // not due yet
    clock.t += 300_000;
    expect(await ai.probeIfDue()).toBe(false); // still failing
    expect(claude.probes).toBe(1);
    claude.failure = null;
    clock.t += 300_000;
    expect(await ai.probeIfDue()).toBe(true);
    expect(events.map((e) => e.kind)).toEqual(["primary_down", "primary_restored"]);
    expect((await ai.chat(request)).provider).toBe("claude");
  });

  it("tries Claude again on a request once the probe time has come (half-open), and falls back if it still fails", async () => {
    const { ai, claude, gemini, clock } = makeAi(() => "ok");
    claude.failure = new ProviderError("claude", "rate_limit", "429");
    await ai.chat(request);
    clock.t += 300_001;
    const response = await ai.chat(request);
    expect(claude.calls).toHaveLength(2);
    expect(response.provider).toBe("gemini");
    expect(gemini.calls).toHaveLength(2);
  });

  it("throws AllProvidersDownError and reports it once when both fail", async () => {
    const { ai, claude, gemini, events } = makeAi(() => "ok");
    claude.failure = new ProviderError("claude", "auth", "401");
    gemini.failure = new ProviderError("gemini", "server", "500");
    await expect(ai.chat(request)).rejects.toBeInstanceOf(AllProvidersDownError);
    await expect(ai.chat(request)).rejects.toBeInstanceOf(AllProvidersDownError);
    expect(events.filter((e) => e.kind === "all_down")).toHaveLength(1);
  });

  it("classifies API errors", () => {
    expect(classifyClaude(401, '{"error":{"type":"authentication_error","message":"invalid x-api-key"}}').kind).toBe("auth");
    expect(classifyClaude(400, '{"error":{"type":"invalid_request_error","message":"Your credit balance is too low"}}').kind).toBe("billing");
    expect(classifyClaude(429, "").kind).toBe("rate_limit");
    expect(classifyClaude(529, '{"error":{"type":"overloaded_error"}}').kind).toBe("overloaded");
    expect(classifyClaude(400, '{"error":{"type":"invalid_request_error","message":"bad"}}').kind).toBe("bad_request");
    expect(classifyGemini(400, '{"error":{"message":"API key not valid","status":"INVALID_ARGUMENT"}}').kind).toBe("auth");
    expect(classifyGemini(429, '{"error":{"status":"RESOURCE_EXHAUSTED"}}').kind).toBe("rate_limit");
    expect(classifyGemini(503, "").kind).toBe("overloaded");
  });

  it("Gemini adapter: key in a header, tool calls round-trip with a thought signature, secrets never in errors", async () => {
    const bodies: Record<string, unknown>[] = [];
    const headers: Record<string, string>[] = [];
    const urls: string[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      urls.push(url);
      headers.push(init.headers as Record<string, string>);
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ functionCall: { name: "top_chats", args: { limit: 3 } }, thoughtSignature: "sig-1" }] }, finishReason: "STOP" },
          ],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const gemini = new GeminiProvider({ apiKey: "SECRET-KEY", mainModel: "g-main", fastModel: "g-fast", embeddingModel: "e", fetch: fakeFetch });
    const controller = new AbortController();
    const first = await gemini.chat({ ...request, tools: [{ name: "top_chats", description: "d", parameters: { type: "object", properties: {} } }] }, controller.signal);
    expect(urls[0]).not.toContain("SECRET-KEY");
    expect(headers[0]?.["x-goog-api-key"]).toBe("SECRET-KEY");
    expect(first.toolCalls[0]?.meta?.thoughtSignature).toBe("sig-1");
    await gemini.chat(
      {
        ...request,
        messages: [
          { role: "user", content: "q" },
          { role: "assistant", content: [...first.content, { type: "tool_call", id: "from-claude", name: "x", input: {} }] },
          { role: "user", content: [{ type: "tool_result", id: "a", name: "top_chats", output: "[]" }] },
        ],
      },
      controller.signal,
    );
    const contents = bodies[1]?.contents as { parts: Record<string, unknown>[] }[];
    expect(contents[1]?.parts[0]?.thoughtSignature).toBe("sig-1");
    expect(contents[1]?.parts[1]?.thoughtSignature).toBe(DUMMY_THOUGHT_SIGNATURE);
    expect(contents[2]?.parts[0]?.functionResponse).toEqual({ name: "top_chats", response: { result: "[]" } });

    const failing = new GeminiProvider({
      apiKey: "SECRET-KEY",
      mainModel: "m",
      fastModel: "f",
      embeddingModel: "e",
      fetch: (async () => new Response('{"error":{"message":"bad key SECRET-KEY"}}', { status: 401 })) as unknown as typeof fetch,
    });
    const err = (await failing.chat(request, controller.signal).catch((e: unknown) => e)) as ProviderError;
    expect(err.kind).toBe("auth");
    expect(err.message).not.toContain("SECRET-KEY");
  });
});

describe("price list and reply checks", () => {
  const list = loadPriceList(path.join(PROJECT_DIR, "knowledge", "prices.json"));

  it("loads the price list with the exact amounts and days", () => {
    expect(list).not.toBeNull();
    const noruda = list!.groups.find((g) => g.key === "noruda")!;
    expect(noruda.items.find((i) => i.key === "uter")).toMatchObject({ price: 8_000_000, days: 10 });
    expect(noruda.items.find((i) => i.key === "tog_ajratmasi")).toMatchObject({ price: 15_000_000, days: 30 });
    expect(list!.groups.find((g) => g.key === "ruda")!.items.every((i) => i.price === null)).toBe(true);
  });

  it("finds amounts in text and flags the ones not in the list", () => {
    expect(amountsIn("UTER 8 000 000 so'm, ZEP 9 mln, 10 kun, tel +998 99 850 24 01")).toEqual([9_000_000, 8_000_000]);
    expect(inventedAmounts("UTER taxminan 8 000 000 so'm", list)).toEqual([]);
    expect(inventedAmounts("UTER taxminan 7 500 000 so'm", list)).toEqual([7_500_000]);
    expect(inventedAmounts("Toposyomka 500 000 – 1 000 000 so'm/gektar", list)).toEqual([]);
  });

  it("finds the forbidden 'an employee will answer' phrases in every language", () => {
    for (const text of [
      "Mas'ul xodim sizga javob beradi.",
      "Xodimimiz bilan bog'laning.",
      "Sizning savolingizni xodimga yubordim.",
      "Mutaxassisimiz keyinroq javob beradi.",
      "Bu chatga mas'ul xodim javob beradi.",
      "Наш специалист свяжется с Вами.",
      "Ответственный сотрудник ответит Вам.",
      "An employee will reply to you shortly.",
    ]) {
      expect(bannedPhrases(text), text).not.toHaveLength(0);
    }
    expect(bannedPhrases("«SANOATGEOKONTEXXIZMAT» mas'uliyati cheklangan jamiyati")).toHaveLength(0);
    expect(removeBannedSentences("UTER 8 000 000 so'm. Mas'ul xodim javob beradi. Rahmat.")).toBe("UTER 8 000 000 so'm. Rahmat.");
  });

  it("notices a repeated reply and a question about a fact already given", () => {
    const earlier = "Investitsiya uchun 14 ta hujjat kerak, ularni shu chatga alohida fayl qilib yuboring va yo'qlarini belgilang.";
    expect(repeatedReply(earlier, [earlier])).toBe(earlier);
    expect(repeatedReply("Ha.", ["Ha."])).toBeNull();
    const review = reviewReply({
      reply: "Iltimos, korxonangizning STIR raqamini yuboring?",
      previousReplies: [],
      known: { companyName: "Ideal Shag'al", stir: "123456789", mineralType: null, location: null },
      priceList: list,
    });
    expect(review.problems).toContain("asked_known_fact");
  });
});

describe("decision tree", () => {
  it("maps the AI's analysis to a workflow and asks first when facts are missing", () => {
    expect(selectWorkflow(parseAnalysis({ request_type: "price_request" }))).toBe("price_answer");
    expect(selectWorkflow(parseAnalysis({ request_type: "complaint" }))).toBe("escalate");
    expect(
      selectWorkflow(parseAnalysis({ request_type: "info_question", context_completeness: "insufficient", missing_info: ["faoliyat turi"] })),
    ).toBe("clarify");
  });

  it("keeps only valid facts", () => {
    const a = parseAnalysis({ facts: { stir: "12345 6789", company_name: "Ideal", mineral_type: "noruda", license_expiry: "31.12.2026" } });
    expect(a.facts).toEqual({ stir: "123456789", company_name: "Ideal", mineral_type: "noruda" });
    expect(parseAnalysis("garbage").fromAi).toBe(false);
  });
});
