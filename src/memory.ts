import { extractJson } from "./ai/json.js";
import type { AIProviderManager } from "./ai/providerManager.js";
import type { Embedder } from "./ai/types.js";
import type { CustomerProfile, Database, StoredMessage, Summary } from "./db/database.js";

/**
 * Memory Manager (TZ 17): short-term memory is the recent conversation (from the transcripts); long-term memory is
 * PostgreSQL — the customer profile, the conversation summary, remembered facts and semantic search over every earlier
 * message of THIS customer. Another customer's data is never read here: every query is filtered by customer ID.
 */

export const SUMMARY_EVERY_MESSAGES = 8;

export interface CustomerContext {
  profile: CustomerProfile | null;
  summary: Summary | null;
  /** Earlier messages related to the current question (outside the recent window). */
  related: { text: string; ts: number; role: string }[];
  memories: { kind: string; content: string }[];
}

export class MemoryManager {
  readonly #running = new Set<number>();

  constructor(
    private readonly db: Database,
    private readonly ai: AIProviderManager | null,
    private readonly embedder: Embedder | null,
    private readonly log: (message: string) => void,
  ) {}

  /**
   * Everything known about a customer for one reply. `exclude` holds the texts already in the recent window, so the
   * same message is not shown twice.
   */
  async context(customerId: number, query: string, { limit = 5, exclude = new Set<string>() }: { limit?: number; exclude?: Set<string> } = {}): Promise<CustomerContext> {
    const [profile, summary, memories] = await Promise.all([
      this.db.profile(customerId),
      this.db.summary(customerId),
      this.db.memories(customerId, 30),
    ]);
    const related: CustomerContext["related"] = [];
    const seen = new Set(exclude);
    const add = (text: string, ts: number, role: string): void => {
      const key = text.trim();
      if (!key || seen.has(key) || related.length >= limit) return;
      seen.add(key);
      related.push({ text: key, ts, role });
    };
    if (query.trim()) {
      let vectorDone = false;
      if (this.embedder) {
        try {
          const [vector] = await this.embedder.embed([query], "query");
          if (vector) {
            for (const hit of await this.db.searchSimilar(customerId, vector, limit * 3)) {
              if (hit.score >= 0.55) add(hit.content, hit.ts, "earlier");
            }
            vectorDone = true;
          }
        } catch (err) {
          this.log(`Semantic search failed, using keyword search: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (!vectorDone || related.length === 0) {
        for (const message of await this.db.searchKeyword(customerId, query, limit * 3)) add(message.text, message.ts, message.role);
      }
    }
    return { profile, summary, related, memories };
  }

  /** Stores the embedding of one message (in the background; failures are only logged). */
  async index(message: Pick<StoredMessage, "id" | "customerId" | "text">): Promise<void> {
    if (!this.embedder || message.text.length < 20 || /^\[(document|photo|sticker|voice)/.test(message.text)) return;
    try {
      const [vector] = await this.embedder.embed([message.text], "document");
      if (vector) await this.db.addEmbedding(message.customerId, message.id, message.text.slice(0, 4000), this.embedder.model, vector);
    } catch (err) {
      this.log(`Could not index message ${message.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Embeds messages that have none yet (after the JSON import, or after Gemini was down). */
  async backfill(limit = 50): Promise<number> {
    if (!this.embedder) return 0;
    const messages = await this.db.messagesWithoutEmbedding(limit);
    if (messages.length === 0) return 0;
    const vectors = await this.embedder.embed(messages.map((m) => m.text), "document");
    for (const [i, message] of messages.entries()) {
      const vector = vectors[i];
      if (vector) await this.db.addEmbedding(message.customerId, message.id, message.text.slice(0, 4000), this.embedder.model, vector);
    }
    return messages.length;
  }

  /**
   * Updates the conversation summary and its analysis (topic, questions, needs, objections, outcome, next task) once
   * SUMMARY_EVERY_MESSAGES new messages have arrived. Runs in the background after the reply.
   */
  async maybeSummarize(customerId: number, force = false): Promise<boolean> {
    if (!this.ai || this.#running.has(customerId)) return false;
    this.#running.add(customerId);
    try {
      const previous = await this.db.summary(customerId);
      const fresh = await this.db.messagesAfter(customerId, previous?.lastMessageId ?? 0, 400);
      if (fresh.length === 0 || (!force && fresh.length < SUMMARY_EVERY_MESSAGES)) return false;
      const transcript = fresh
        .map((m) => `[${new Date(m.ts * 1000).toISOString().slice(0, 16)}] ${m.role === "customer" ? "Mijoz" : m.role === "admin" ? "Admin" : "Bot"}: ${m.text.slice(0, 1500)}`)
        .join("\n");
      const response = await this.ai.chat({
        purpose: "summary",
        tier: "fast",
        maxTokens: 1500,
        system: SUMMARY_SYSTEM,
        messages: [
          {
            role: "user",
            content: `<previous_summary>\n${previous?.summary ?? "(none)"}\n</previous_summary>\n<previous_analysis>\n${JSON.stringify(previous?.analysis ?? {})}\n</previous_analysis>\n<new_messages>\n${transcript}\n</new_messages>`,
          },
        ],
      });
      const parsed = extractJson(response.text) as Record<string, unknown> | null;
      const summary = typeof parsed?.summary === "string" ? parsed.summary.trim() : response.text.trim();
      const analysis = parsed && typeof parsed.analysis === "object" && parsed.analysis !== null ? (parsed.analysis as Record<string, unknown>) : {};
      const last = fresh.at(-1);
      if (summary && last) await this.db.saveSummary(customerId, summary.slice(0, 3000), analysis, last.id);
      return true;
    } catch (err) {
      this.log(`Could not update the summary of ${customerId}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    } finally {
      this.#running.delete(customerId);
    }
  }
}

const SUMMARY_SYSTEM = `You maintain the memory of a company's Telegram assistant about ONE customer conversation.
Update the summary with the new messages. Write in Uzbek (Latin script). Keep facts the customer stated (company name, STIR, location, mineral, services, documents, decisions, dates), what the customer asked, what the bot answered, objections, and the current state. Do not invent anything.
Answer with JSON only:
{"summary": "<= 1200 characters",
 "analysis": {"topic": "main topic", "questions": ["main questions"], "need": "the customer's probable need", "service": "service of interest or null",
  "objections": ["..."], "answers": ["main answers the bot gave"], "outcome": "current result of the conversation", "next_task": "what should be done next",
  "sentiment": "positive|neutral|negative", "unanswered": ["questions the bot could not answer"]}}`;

/** The KNOWN FACTS block of the reply prompt. */
export function knownFactsBlock(profile: CustomerProfile | null): string {
  if (!profile) return "KNOWN FACTS: none yet.";
  const rows: [string, string | null][] = [
    ["Company name", profile.companyName],
    ["STIR", profile.stir],
    ["Phone the customer gave", profile.phone],
    ["Email", profile.email],
    ["Activity", profile.activity],
    ["Site location", profile.location],
    ["Mineral type (ruda/noruda)", profile.mineralType],
    ["Mineral", profile.mineral],
    ["Licence number", profile.licenseNumber],
    ["Licence valid until", profile.licenseExpiry],
    ["Preferences", profile.preferences],
    ["Decisions", profile.decisions],
    ["Services of interest", profile.services.length > 0 ? profile.services.join(", ") : null],
    ["Sales stage", profile.stage],
  ];
  const known = rows.filter(([, value]) => value);
  if (known.length === 0) return "KNOWN FACTS: none yet.";
  return `KNOWN FACTS about this customer (stated by them earlier; never ask for these again unless they contradict each other or a new task really needs a newer value):\n${known.map(([k, v]) => `- ${k}: ${v}`).join("\n")}`;
}
