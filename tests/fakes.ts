import crypto from "node:crypto";
import pg from "pg";
import { AIProviderManager, type SwitchEvent } from "../src/ai/providerManager.js";
import {
  type ChatRequest,
  type ChatResponse,
  type ContentPart,
  type EmbedTask,
  type Embedder,
  type ModelTier,
  type Provider,
  ProviderError,
  type ProviderName,
  type ToolCallPart,
} from "../src/ai/types.js";
import { Database } from "../src/db/database.js";

export type Answer =
  | string
  | ProviderError
  | { text?: string; toolCalls?: { name: string; input: Record<string, unknown> }[] };
export type Script = (request: ChatRequest, provider: ProviderName) => Answer | Promise<Answer>;

/** A provider that answers from a script; every request is recorded. */
export class FakeProvider implements Provider {
  readonly calls: ChatRequest[] = [];
  /** When set, every call (and probe) fails with it. */
  failure: ProviderError | null = null;
  probes = 0;
  #ids = 0;

  constructor(
    readonly name: ProviderName,
    public script: Script,
  ) {}

  modelFor(tier: ModelTier): string {
    return `${this.name}-${tier}`;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.calls.push(structuredClone(request));
    if (this.failure) throw this.failure;
    const answer = await this.script(request, this.name);
    if (answer instanceof ProviderError) throw answer;
    const text = typeof answer === "string" ? answer : (answer.text ?? "");
    const toolCalls: ToolCallPart[] =
      typeof answer === "string"
        ? []
        : (answer.toolCalls ?? []).map((call) => ({ type: "tool_call", id: `call-${++this.#ids}`, name: call.name, input: call.input }));
    const content: ContentPart[] = [...(text ? [{ type: "text" as const, text }] : []), ...toolCalls];
    return {
      provider: this.name,
      model: this.modelFor(request.tier),
      text,
      toolCalls,
      content,
      stopReason: toolCalls.length > 0 ? "tool_use" : "end",
      usage: { inputTokens: 10, outputTokens: 10 },
      latencyMs: 1,
    };
  }

  async probe(): Promise<void> {
    this.probes++;
    if (this.failure) throw this.failure;
  }

  /** Requests of one purpose ("analysis", "customer-reply", "admin", "summary" ...). */
  of(purpose: string): ChatRequest[] {
    return this.calls.filter((call) => call.purpose === purpose);
  }
}

/** Bag-of-words vectors: texts that share words are similar, so semantic search can be tested offline. */
export class FakeEmbedder implements Embedder {
  readonly model = "fake-embedding";
  readonly dimensions = 768;
  calls = 0;

  async embed(texts: string[], _task: EmbedTask): Promise<number[][]> {
    this.calls++;
    return texts.map((text) => {
      const vector = new Array<number>(this.dimensions).fill(0);
      for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3)) {
        const stem = word.slice(0, 6);
        const hash = crypto.createHash("md5").update(stem).digest();
        vector[hash.readUInt16BE(0) % this.dimensions]! += 1;
      }
      const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0)) || 1;
      return vector.map((v) => v / norm);
    });
  }
}

export interface AiSetup {
  claude: FakeProvider;
  gemini: FakeProvider;
  ai: AIProviderManager;
  events: SwitchEvent[];
  clock: { t: number };
}

/** Claude + Gemini fakes behind a real AIProviderManager (no waiting between retries). */
export function makeAi(script: Script, { probeIntervalMs = 300_000 }: { probeIntervalMs?: number } = {}): AiSetup {
  const claude = new FakeProvider("claude", script);
  const gemini = new FakeProvider("gemini", script);
  const events: SwitchEvent[] = [];
  const clock = { t: 1_000_000 };
  const ai = new AIProviderManager({
    primary: claude,
    backup: gemini,
    retries: 1,
    probeIntervalMs,
    sleep: async () => undefined,
    now: () => clock.t,
    onSwitch: (event) => events.push(event),
  });
  return { claude, gemini, ai, events, clock };
}

/** The last user message of a request as text. */
export function lastUserText(request: ChatRequest): string {
  const last = [...request.messages].reverse().find((m) => m.role === "user");
  if (!last) return "";
  return typeof last.content === "string" ? last.content : last.content.map((p) => (p.type === "text" ? p.text : p.type === "tool_result" ? p.output : "")).join("");
}

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";

const created: { name: string; db: Database }[] = [];

/** A fresh, empty database for one test (needs TEST_DATABASE_URL pointing at a server where we may CREATE DATABASE). */
export async function makeTestDb(): Promise<Database> {
  const name = `sgk_t_${crypto.randomBytes(5).toString("hex")}`;
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  const db = await Database.connect(url.toString());
  created.push({ name, db });
  return db;
}

export async function dropTestDbs(): Promise<void> {
  for (const { name, db } of created.splice(0)) {
    await db.close().catch(() => undefined);
    const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
    await admin.end();
  }
}
