import {
  type ChatRequest,
  type ChatResponse,
  type ContentPart,
  type FailureKind,
  type ModelTier,
  type Provider,
  ProviderError,
  redact,
  type ToolCallPart,
} from "./types.js";

export interface ClaudeOptions {
  apiKey: string;
  mainModel: string;
  fastModel: string;
  baseUrl?: string;
  /** Replaced in tests. */
  fetch?: typeof fetch;
}

const API_VERSION = "2023-06-01";

/** Claude through the Anthropic Messages API (an API key, never a subscription token). */
export class ClaudeProvider implements Provider {
  readonly name = "claude" as const;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;

  constructor(private readonly options: ClaudeOptions) {
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? fetch;
    this.#baseUrl = (options.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  }

  modelFor(tier: ModelTier): string {
    return tier === "fast" ? this.options.fastModel : this.options.mainModel;
  }

  async chat(request: ChatRequest, signal: AbortSignal): Promise<ChatResponse> {
    const model = this.modelFor(request.tier);
    const body: Record<string, unknown> = {
      model,
      max_tokens: request.maxTokens ?? 1500,
      system: request.system,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: typeof message.content === "string" ? message.content : message.content.map(toAnthropicBlock),
      })),
    };
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      }));
    }
    const started = Date.now();
    const json = await this.#post("/v1/messages", body, signal);
    const blocks = Array.isArray(json.content) ? (json.content as Record<string, unknown>[]) : [];
    const content: ContentPart[] = [];
    for (const block of blocks) {
      if (block.type === "text" && typeof block.text === "string") content.push({ type: "text", text: block.text });
      if (block.type === "tool_use" && typeof block.name === "string") {
        content.push({
          type: "tool_call",
          id: String(block.id ?? ""),
          name: block.name,
          input: isObject(block.input) ? block.input : {},
        });
      }
    }
    const toolCalls = content.filter((part): part is ToolCallPart => part.type === "tool_call");
    const text = content
      .filter((part) => part.type === "text")
      .map((part) => (part as { text: string }).text)
      .join("")
      .trim();
    if (!text && toolCalls.length === 0) {
      throw new ProviderError("claude", "invalid_response", "Claude returned an empty answer");
    }
    const usage = isObject(json.usage) ? json.usage : {};
    const stop = json.stop_reason;
    return {
      provider: "claude",
      model: typeof json.model === "string" ? json.model : model,
      text,
      toolCalls,
      content,
      stopReason: stop === "tool_use" ? "tool_use" : stop === "max_tokens" ? "max_tokens" : stop === "end_turn" ? "end" : "other",
      usage: { inputTokens: Number(usage.input_tokens ?? 0), outputTokens: Number(usage.output_tokens ?? 0) },
      latencyMs: Date.now() - started,
    };
  }

  async probe(signal: AbortSignal): Promise<void> {
    await this.#post(
      "/v1/messages",
      { model: this.options.fastModel, max_tokens: 1, messages: [{ role: "user", content: "ping" }] },
      signal,
    );
  }

  async #post(endpoint: string, body: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (!this.#apiKey) throw new ProviderError("claude", "not_configured", "ANTHROPIC_API_KEY is not set");
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${endpoint}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.#apiKey,
          "anthropic-version": API_VERSION,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw new ProviderError("claude", "timeout", "Claude did not answer in time");
      throw new ProviderError("claude", "network", this.#clean(`network error: ${errorText(err)}`));
    }
    const raw = await response.text().catch(() => "");
    if (!response.ok) {
      const { kind, message } = classifyClaude(response.status, raw);
      throw new ProviderError("claude", kind, this.#clean(message), response.status);
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isObject(parsed)) throw new Error("not an object");
      return parsed;
    } catch {
      throw new ProviderError("claude", "invalid_response", "Claude returned something that is not JSON");
    }
  }

  #clean(text: string): string {
    return redact(text, [this.#apiKey]).slice(0, 500);
  }
}

/** Maps an HTTP status and error body of the Anthropic API to a failure kind. */
export function classifyClaude(status: number, body: string): { kind: FailureKind; message: string } {
  let type = "";
  let detail = body.slice(0, 300);
  try {
    const parsed: unknown = JSON.parse(body);
    if (isObject(parsed) && isObject(parsed.error)) {
      type = String(parsed.error.type ?? "");
      detail = String(parsed.error.message ?? detail);
    }
  } catch {
    // keep the raw text
  }
  const message = `HTTP ${status}${type ? ` ${type}` : ""}: ${detail}`;
  if (/credit balance|billing|payment|insufficient.*(credit|fund)|spend limit/i.test(detail) || type === "billing_error") {
    return { kind: "billing", message };
  }
  if (status === 401 || status === 403 || type === "authentication_error" || type === "permission_error") {
    return { kind: "auth", message };
  }
  if (status === 429 || type === "rate_limit_error") return { kind: "rate_limit", message };
  if (status === 529 || type === "overloaded_error") return { kind: "overloaded", message };
  if (status >= 500) return { kind: "server", message };
  if (status === 408) return { kind: "timeout", message };
  return { kind: "bad_request", message };
}

function toAnthropicBlock(part: ContentPart): Record<string, unknown> {
  if (part.type === "text") return { type: "text", text: part.text };
  if (part.type === "tool_call") return { type: "tool_use", id: part.id, name: part.name, input: part.input };
  return { type: "tool_result", tool_use_id: part.id, content: part.output, ...(part.isError ? { is_error: true } : {}) };
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
