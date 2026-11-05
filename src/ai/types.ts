/**
 * Provider-neutral types shared by the Claude and Gemini adapters. Both providers take the same request and return
 * the same response shape, so the rest of the bot never knows which model answered.
 */

export type ProviderName = "claude" | "gemini";

/** "fast" = classification, extraction, summaries; "main" = replies to customers and admin analysis. */
export type ModelTier = "fast" | "main";

export interface TextPart {
  type: "text";
  text: string;
}

export interface ToolCallPart {
  type: "tool_call";
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Opaque provider data that must be sent back unchanged (Gemini thought signatures). */
  meta?: Record<string, unknown>;
}

export interface ToolResultPart {
  type: "tool_result";
  id: string;
  name: string;
  output: string;
  isError?: boolean;
}

export type ContentPart = TextPart | ToolCallPart | ToolResultPart;

export interface ChatMessage {
  role: "user" | "assistant";
  content: string | ContentPart[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON schema of the input object. */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  tier: ModelTier;
  maxTokens?: number;
  tools?: ToolDefinition[];
  /** Short label for logs and ai_provider_logs ("customer-reply", "analysis", "admin" ...). */
  purpose: string;
}

export interface ChatResponse {
  provider: ProviderName;
  model: string;
  text: string;
  toolCalls: ToolCallPart[];
  /** Everything the model returned, to append to the conversation in a tool loop. */
  content: ContentPart[];
  stopReason: "end" | "tool_use" | "max_tokens" | "other";
  usage: { inputTokens: number; outputTokens: number };
  latencyMs: number;
}

export type EmbedTask = "document" | "query";

export interface Provider {
  readonly name: ProviderName;
  chat(request: ChatRequest, signal: AbortSignal): Promise<ChatResponse>;
  /** A tiny request that proves the provider answers (used by the circuit breaker). */
  probe(signal: AbortSignal): Promise<void>;
  modelFor(tier: ModelTier): string;
}

export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[], task: EmbedTask): Promise<number[][]>;
}

/**
 * Why a provider call failed. Transient kinds are retried a few times on the same provider; the others switch to the
 * backup at once and open the circuit breaker (except bad_request, which is about this one request).
 */
export type FailureKind =
  | "not_configured"
  | "auth"
  | "billing"
  | "rate_limit"
  | "overloaded"
  | "server"
  | "timeout"
  | "network"
  | "bad_request"
  | "invalid_response";

export const TRANSIENT_FAILURES: ReadonlySet<FailureKind> = new Set(["overloaded", "server", "timeout", "network"]);

export class ProviderError extends Error {
  constructor(
    readonly provider: ProviderName,
    readonly kind: FailureKind,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Neither Claude nor Gemini could answer. The caller queues the work and tells the admins. */
export class AllProvidersDownError extends Error {
  constructor(readonly failures: ProviderError[]) {
    super(`All AI providers failed: ${failures.map((f) => `${f.provider}=${f.kind}`).join(", ") || "none configured"}`);
    this.name = "AllProvidersDownError";
  }
}

export function textOf(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/** Removes secrets that might appear in an error body or URL before it is logged. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (secret) out = out.split(secret).join("[REDACTED]");
  return out;
}
