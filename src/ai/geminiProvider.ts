import { isObject } from "./claudeProvider.js";
import {
  type ChatRequest,
  type ChatResponse,
  type ContentPart,
  type EmbedTask,
  type Embedder,
  type FailureKind,
  type ModelTier,
  type Provider,
  ProviderError,
  redact,
  type ToolCallPart,
} from "./types.js";

export interface GeminiOptions {
  apiKey: string;
  mainModel: string;
  fastModel: string;
  embeddingModel: string;
  embeddingDimensions?: number;
  baseUrl?: string;
  fetch?: typeof fetch;
}

/**
 * Gemini 3 checks "thought signatures" on function calls it sees again. A call that came from Claude (after a switch)
 * has none; Google documents this value for exactly that case.
 */
export const DUMMY_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

/** Google Gemini through the generateContent REST API, with the key from GEMINI_API_KEY. */
export class GeminiProvider implements Provider, Embedder {
  readonly name = "gemini" as const;
  readonly model: string;
  readonly dimensions: number;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;
  #toolCounter = 0;

  constructor(private readonly options: GeminiOptions) {
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? fetch;
    this.#baseUrl = (options.baseUrl ?? "https://generativelanguage.googleapis.com").replace(/\/+$/, "");
    this.model = options.embeddingModel;
    this.dimensions = options.embeddingDimensions ?? 768;
  }

  modelFor(tier: ModelTier): string {
    return tier === "fast" ? this.options.fastModel : this.options.mainModel;
  }

  async chat(request: ChatRequest, signal: AbortSignal): Promise<ChatResponse> {
    let model = this.modelFor(request.tier);
    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: request.messages.map((message) => ({
        role: message.role === "assistant" ? "model" : "user",
        parts:
          typeof message.content === "string"
            ? [{ text: message.content }]
            : message.content.map((part) => toGeminiPart(part)),
      })),
      generationConfig: { maxOutputTokens: request.maxTokens ?? 1500 },
    };
    if (request.tools && request.tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
        },
      ];
    }
    const started = Date.now();
    // A busy model (503) or a model-level quota (429) is common on Gemini: try the other configured model before
    // giving up, so a customer is not left without an answer because one model is overloaded.
    const candidates = [...new Set([model, this.options.fastModel, this.options.mainModel])];
    let json: Record<string, unknown> | null = null;
    let lastError: unknown = null;
    for (const name of candidates) {
      try {
        json = await this.#post(`/v1beta/models/${encodeURIComponent(name)}:generateContent`, body, signal);
        model = name;
        break;
      } catch (error) {
        lastError = error;
        const retryable =
          error instanceof ProviderError &&
          (["overloaded", "server", "rate_limit"].includes(error.kind) || error.message.includes("HTTP 404"));
        if (!retryable) throw error;
      }
    }
    if (!json) throw lastError;
    const candidate = Array.isArray(json.candidates) && isObject(json.candidates[0]) ? json.candidates[0] : null;
    if (!candidate) {
      const blocked = isObject(json.promptFeedback) ? String(json.promptFeedback.blockReason ?? "") : "";
      throw new ProviderError("gemini", "invalid_response", `Gemini returned no candidate${blocked ? ` (${blocked})` : ""}`);
    }
    const parts =
      isObject(candidate.content) && Array.isArray(candidate.content.parts)
        ? (candidate.content.parts as Record<string, unknown>[])
        : [];
    const content: ContentPart[] = [];
    for (const part of parts) {
      if (part.thought === true) continue;
      if (isObject(part.functionCall) && typeof part.functionCall.name === "string") {
        const meta: Record<string, unknown> = {};
        if (typeof part.thoughtSignature === "string") meta.thoughtSignature = part.thoughtSignature;
        content.push({
          type: "tool_call",
          id: typeof part.functionCall.id === "string" ? part.functionCall.id : `gemini-call-${++this.#toolCounter}`,
          name: part.functionCall.name,
          input: isObject(part.functionCall.args) ? part.functionCall.args : {},
          meta,
        });
      } else if (typeof part.text === "string") {
        content.push({ type: "text", text: part.text });
      }
    }
    const toolCalls = content.filter((part): part is ToolCallPart => part.type === "tool_call");
    const text = content
      .filter((part) => part.type === "text")
      .map((part) => (part as { text: string }).text)
      .join("")
      .trim();
    const finish = String(candidate.finishReason ?? "");
    if (!text && toolCalls.length === 0) {
      throw new ProviderError("gemini", "invalid_response", `Gemini returned an empty answer (${finish || "no reason"})`);
    }
    const usage = isObject(json.usageMetadata) ? json.usageMetadata : {};
    return {
      provider: "gemini",
      model,
      text,
      toolCalls,
      content,
      stopReason: toolCalls.length > 0 ? "tool_use" : finish === "MAX_TOKENS" ? "max_tokens" : finish === "STOP" ? "end" : "other",
      usage: { inputTokens: Number(usage.promptTokenCount ?? 0), outputTokens: Number(usage.candidatesTokenCount ?? 0) },
      latencyMs: Date.now() - started,
    };
  }

  async probe(signal: AbortSignal): Promise<void> {
    await this.#post(
      `/v1beta/models/${encodeURIComponent(this.options.fastModel)}:generateContent`,
      { contents: [{ role: "user", parts: [{ text: "ping" }] }], generationConfig: { maxOutputTokens: 1 } },
      signal,
    );
  }

  async embed(texts: string[], task: EmbedTask): Promise<number[][]> {
    if (texts.length === 0) return [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const model = `models/${this.options.embeddingModel}`;
      const json = await this.#post(
        `/v1beta/${model}:batchEmbedContents`,
        {
          requests: texts.map((text) => ({
            model,
            content: { parts: [{ text: text.slice(0, 8000) }] },
            taskType: task === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
            outputDimensionality: this.dimensions,
          })),
        },
        controller.signal,
      );
      const embeddings = Array.isArray(json.embeddings) ? json.embeddings : [];
      const vectors = embeddings.map((item) =>
        isObject(item) && Array.isArray(item.values) ? item.values.map(Number) : [],
      );
      if (vectors.length !== texts.length || vectors.some((v) => v.length !== this.dimensions)) {
        throw new ProviderError("gemini", "invalid_response", "Gemini returned embeddings of an unexpected size");
      }
      return vectors.map(normalize);
    } finally {
      clearTimeout(timer);
    }
  }

  async #post(endpoint: string, body: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (!this.#apiKey) throw new ProviderError("gemini", "not_configured", "GEMINI_API_KEY is not set");
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${endpoint}`, {
        method: "POST",
        // The key goes in a header, never in the URL, so it cannot end up in a logged URL.
        headers: { "content-type": "application/json", "x-goog-api-key": this.#apiKey },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw new ProviderError("gemini", "timeout", "Gemini did not answer in time");
      throw new ProviderError("gemini", "network", this.#clean(`network error: ${err instanceof Error ? err.message : String(err)}`));
    }
    const raw = await response.text().catch(() => "");
    if (!response.ok) {
      const { kind, message } = classifyGemini(response.status, raw);
      throw new ProviderError("gemini", kind, this.#clean(message), response.status);
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isObject(parsed)) throw new Error("not an object");
      return parsed;
    } catch {
      throw new ProviderError("gemini", "invalid_response", "Gemini returned something that is not JSON");
    }
  }

  #clean(text: string): string {
    return redact(text, [this.#apiKey]).slice(0, 500);
  }
}

export function classifyGemini(status: number, body: string): { kind: FailureKind; message: string } {
  let detail = body.slice(0, 300);
  let state = "";
  try {
    const parsed: unknown = JSON.parse(body);
    if (isObject(parsed) && isObject(parsed.error)) {
      detail = String(parsed.error.message ?? detail);
      state = String(parsed.error.status ?? "");
    }
  } catch {
    // keep the raw text
  }
  const message = `HTTP ${status}${state ? ` ${state}` : ""}: ${detail}`;
  if (/api key|API_KEY_INVALID|permission/i.test(detail) && (status === 400 || status === 401 || status === 403)) {
    return { kind: "auth", message };
  }
  if (status === 401 || status === 403) return { kind: "auth", message };
  if (/billing|quota/i.test(detail) && status !== 429) return { kind: "billing", message };
  if (status === 429) return { kind: "rate_limit", message };
  if (status === 503) return { kind: "overloaded", message };
  if (status >= 500) return { kind: "server", message };
  if (status === 408 || status === 504) return { kind: "timeout", message };
  return { kind: "bad_request", message };
}

function toGeminiPart(part: ContentPart): Record<string, unknown> {
  if (part.type === "text") return { text: part.text };
  if (part.type === "tool_call") {
    const signature = typeof part.meta?.thoughtSignature === "string" ? part.meta.thoughtSignature : DUMMY_THOUGHT_SIGNATURE;
    return { functionCall: { name: part.name, args: part.input }, thoughtSignature: signature };
  }
  return { functionResponse: { name: part.name, response: { result: part.output, ...(part.isError ? { error: true } : {}) } } };
}

function normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return norm > 0 ? vector.map((v) => v / norm) : vector;
}
