import pg from "pg";
import { MIGRATIONS } from "./migrations.js";

export type MessageRole = "customer" | "bot" | "admin";
export type VectorMode = "pgvector" | "array";

export interface StoredMessage {
  id: number;
  customerId: number;
  conversationId: string;
  role: MessageRole;
  author: string;
  text: string;
  language: string | null;
  /** Epoch seconds. */
  ts: number;
}

/** The facts the bot keeps about a customer (Customer Profile Memory). */
export interface CustomerProfile {
  id: number;
  name: string;
  username: string;
  language: string | null;
  firstSeen: number;
  lastSeen: number;
  companyName: string | null;
  stir: string | null;
  phone: string | null;
  email: string | null;
  activity: string | null;
  location: string | null;
  mineralType: string | null;
  mineral: string | null;
  licenseNumber: string | null;
  licenseExpiry: string | null;
  preferences: string | null;
  decisions: string | null;
  nextContactDate: string | null;
  services: string[];
  stage: string | null;
}

/** Fields the AI may fill in from a conversation. */
export const PROFILE_FIELDS = {
  company_name: "company_name",
  stir: "stir",
  phone: "phone",
  email: "email",
  activity: "activity",
  location: "location",
  mineral_type: "mineral_type",
  mineral: "mineral",
  license_number: "license_number",
  license_expiry: "license_expiry",
  preferences: "preferences",
  decisions: "decisions",
  next_contact_date: "next_contact_date",
} as const;
export type ProfileField = keyof typeof PROFILE_FIELDS;

export interface Summary {
  summary: string;
  analysis: Record<string, unknown>;
  lastMessageId: number;
  updatedAt: number;
}

export interface SimilarHit {
  messageId: number | null;
  customerId: number;
  content: string;
  score: number;
  ts: number;
}

export interface AiRequestRecord {
  requestId: string;
  chatId: number | null;
  customerId: number | null;
  adminId: number | null;
  incomingKey: string | null;
  requestType: string;
  complexity: string;
  contextCompleteness: string;
  selectedWorkflow: string;
  workflowPath: string[];
  confidenceScore: number | null;
  confidenceLevel: string | null;
  requiredPermissions: string[];
  executionStatus: string;
  finalResult: string | null;
  provider: string | null;
  model: string | null;
  topic: string | null;
  service: string | null;
  error: string | null;
}

export interface PendingReply {
  incomingKey: string;
  customerId: number;
  chat: Record<string, unknown>;
  attempts: number;
}

type Queryable = Pick<pg.Pool, "query">;

/**
 * PostgreSQL access. Every method is small and does one thing; the analytics queries live in analytics.ts and use
 * query() directly.
 */
export class Database {
  readonly vectorMode: VectorMode;
  readonly dimensions: number;

  private constructor(
    private readonly pool: pg.Pool,
    vectorMode: VectorMode,
    dimensions: number,
  ) {
    this.vectorMode = vectorMode;
    this.dimensions = dimensions;
  }

  /** Connects, creates pgvector if possible and applies the migrations. */
  static async connect(url: string, { dimensions = 768 }: { dimensions?: number } = {}): Promise<Database> {
    const pool = new pg.Pool({
      connectionString: url,
      max: 8,
      // Railway's internal network is plain TCP; public URLs ask for TLS themselves (sslmode=require).
      idleTimeoutMillis: 30_000,
    });
    pool.on("error", (err) => console.error(`${new Date().toISOString()} PostgreSQL pool error: ${err.message}`));
    let mode: VectorMode = "array";
    try {
      await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
      mode = "pgvector";
    } catch {
      mode = "array";
    }
    const db = new Database(pool, mode, dimensions);
    await db.migrate();
    // A database created earlier without pgvector keeps its real[] column even if the extension appears later.
    const column = await pool.query<{ udt_name: string }>(
      "SELECT udt_name FROM information_schema.columns WHERE table_name = 'memory_embeddings' AND column_name = 'embedding'",
    );
    const actual: VectorMode = column.rows[0]?.udt_name === "vector" ? "pgvector" : "array";
    return actual === mode ? db : new Database(pool, actual, dimensions);
  }

  async migrate(): Promise<number> {
    await this.pool.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    );
    const done = new Set((await this.pool.query<{ version: number }>("SELECT version FROM schema_migrations")).rows.map((r) => r.version));
    let applied = 0;
    for (const migration of MIGRATIONS) {
      if (done.has(migration.version)) continue;
      const vector = this.vectorMode === "pgvector" ? `vector(${this.dimensions})` : "real[]";
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(migration.sql(vector));
        if (this.vectorMode === "pgvector" && migration.version === 1) {
          await client.query(
            "CREATE INDEX IF NOT EXISTS memory_embeddings_hnsw ON memory_embeddings USING hnsw (embedding vector_cosine_ops)",
          );
        }
        await client.query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [migration.version, migration.name]);
        await client.query("COMMIT");
        applied++;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }
    return applied;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  query<R extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<pg.QueryResult<R>> {
    return (this.pool as Queryable).query<R>(sql, params);
  }

  // ---- idempotency -------------------------------------------------------------------------------------------

  /** True the first time a Telegram message key is seen (survives a lost volume, unlike seen.json). */
  async firstTime(key: string): Promise<boolean> {
    const result = await this.query("INSERT INTO processed_updates (key) VALUES ($1) ON CONFLICT DO NOTHING", [key]);
    return result.rowCount === 1;
  }

  async replyExists(incomingKey: string): Promise<boolean> {
    const result = await this.query("SELECT 1 FROM outgoing_replies WHERE incoming_key = $1", [incomingKey]);
    return (result.rowCount ?? 0) > 0;
  }

  /** Records the reply to one incoming message. Returns false when a reply was already recorded. */
  async recordReply(incomingKey: string, customerId: number, text: string, provider: string | null): Promise<boolean> {
    const result = await this.query(
      "INSERT INTO outgoing_replies (incoming_key, customer_id, text, provider) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
      [incomingKey, customerId, text, provider],
    );
    return result.rowCount === 1;
  }

  // ---- customers, conversations, messages ----------------------------------------------------------------------

  async touchCustomer(id: number, name: string, username: string, language: string | null, ts: number): Promise<void> {
    await this.query(
      `INSERT INTO customers (id, name, username, language, first_seen, last_seen)
       VALUES ($1, $2, $3, $4, to_timestamp($5), to_timestamp($5))
       ON CONFLICT (id) DO UPDATE SET
         name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE customers.name END,
         username = CASE WHEN EXCLUDED.username <> '' THEN EXCLUDED.username ELSE customers.username END,
         language = COALESCE(EXCLUDED.language, customers.language),
         last_seen = GREATEST(customers.last_seen, EXCLUDED.last_seen),
         first_seen = LEAST(customers.first_seen, EXCLUDED.first_seen)`,
      [id, name, username, language, ts],
    );
  }

  async addMessage(input: {
    customerId: number;
    source: string;
    role: MessageRole;
    author: string;
    text: string;
    language: string | null;
    ts: number;
    telegramMessageId?: number | null;
    importKey?: string | null;
  }): Promise<number | null> {
    const conversationId = `${input.source}:${input.customerId}`;
    await this.query(
      `INSERT INTO customers (id, first_seen, last_seen) VALUES ($1, to_timestamp($2), to_timestamp($2)) ON CONFLICT (id) DO NOTHING`,
      [input.customerId, input.ts],
    );
    await this.query(
      `INSERT INTO conversations (id, customer_id, source, started_at, last_activity)
       VALUES ($1, $2, $3, to_timestamp($4), to_timestamp($4))
       ON CONFLICT (id) DO UPDATE SET last_activity = GREATEST(conversations.last_activity, EXCLUDED.last_activity),
         started_at = LEAST(conversations.started_at, EXCLUDED.started_at)`,
      [conversationId, input.customerId, input.source, input.ts],
    );
    const result = await this.query<{ id: string }>(
      `INSERT INTO messages (customer_id, conversation_id, role, author, text, language, telegram_message_id, ts, import_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8), $9)
       ON CONFLICT (import_key) DO NOTHING RETURNING id`,
      [
        input.customerId,
        conversationId,
        input.role,
        input.author,
        input.text,
        input.language,
        input.telegramMessageId ?? null,
        input.ts,
        input.importKey ?? null,
      ],
    );
    const id = result.rows[0]?.id;
    return id === undefined ? null : Number(id);
  }

  async recentMessages(customerId: number, limit: number): Promise<StoredMessage[]> {
    const result = await this.query<MessageRow>(
      `SELECT * FROM (SELECT ${MESSAGE_COLUMNS} FROM messages WHERE customer_id = $1 ORDER BY ts DESC, id DESC LIMIT $2) recent
       ORDER BY ts ASC, id ASC`,
      [customerId, limit],
    );
    return result.rows.map(toMessage);
  }

  async messagesAfter(customerId: number, afterId: number, limit = 500): Promise<StoredMessage[]> {
    const result = await this.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE customer_id = $1 AND id > $2 ORDER BY ts ASC, id ASC LIMIT $3`,
      [customerId, afterId, limit],
    );
    return result.rows.map(toMessage);
  }

  async messageCount(customerId: number): Promise<number> {
    const result = await this.query<{ n: string }>("SELECT count(*) AS n FROM messages WHERE customer_id = $1", [customerId]);
    return Number(result.rows[0]?.n ?? 0);
  }

  async customerIds(): Promise<number[]> {
    const result = await this.query<{ id: string }>("SELECT id FROM customers ORDER BY last_seen DESC");
    return result.rows.map((row) => Number(row.id));
  }

  /** The admin's 🗑: removes the customer and, by cascade, every row about them. */
  async deleteCustomer(customerId: number): Promise<void> {
    await this.query("DELETE FROM customers WHERE id = $1", [customerId]);
  }

  // ---- profile ---------------------------------------------------------------------------------------------------

  async profile(customerId: number): Promise<CustomerProfile | null> {
    const result = await this.query<ProfileRow>(
      `SELECT c.*, extract(epoch FROM c.first_seen) AS first_epoch, extract(epoch FROM c.last_seen) AS last_epoch,
              to_char(c.license_expiry, 'YYYY-MM-DD') AS license_expiry_text,
              to_char(c.next_contact_date, 'YYYY-MM-DD') AS next_contact_text,
              COALESCE((SELECT array_agg(service ORDER BY first_at) FROM customer_services s WHERE s.customer_id = c.id), '{}') AS services,
              (SELECT stage FROM sales_pipeline p WHERE p.customer_id = c.id) AS stage
       FROM customers c WHERE c.id = $1`,
      [customerId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: Number(row.id),
      name: row.name,
      username: row.username,
      language: row.language,
      firstSeen: Number(row.first_epoch),
      lastSeen: Number(row.last_epoch),
      companyName: row.company_name,
      stir: row.stir,
      phone: row.phone,
      email: row.email,
      activity: row.activity,
      location: row.location,
      mineralType: row.mineral_type,
      mineral: row.mineral,
      licenseNumber: row.license_number,
      licenseExpiry: row.license_expiry_text,
      preferences: row.preferences,
      decisions: row.decisions,
      nextContactDate: row.next_contact_text,
      services: row.services ?? [],
      stage: row.stage,
    };
  }

  /**
   * Stores facts the customer stated. A fact is overwritten only with a new non-empty value, and the previous value
   * is kept in `facts` so a contradiction can be noticed.
   */
  async updateProfile(customerId: number, facts: Partial<Record<ProfileField, string>>, ts: number): Promise<string[]> {
    const changed: string[] = [];
    const current = await this.profile(customerId);
    if (!current) return changed;
    const currentValues: Record<ProfileField, string | null> = {
      company_name: current.companyName,
      stir: current.stir,
      phone: current.phone,
      email: current.email,
      activity: current.activity,
      location: current.location,
      mineral_type: current.mineralType,
      mineral: current.mineral,
      license_number: current.licenseNumber,
      license_expiry: current.licenseExpiry,
      preferences: current.preferences,
      decisions: current.decisions,
      next_contact_date: current.nextContactDate,
    };
    for (const [field, raw] of Object.entries(facts) as [ProfileField, string][]) {
      if (!(field in PROFILE_FIELDS)) continue;
      const value = String(raw ?? "").trim();
      if (!value || value === currentValues[field]) continue;
      const column = PROFILE_FIELDS[field];
      const isDate = field === "license_expiry" || field === "next_contact_date";
      if (isDate && !/^\d{4}-\d{2}-\d{2}$/.test(value)) continue;
      await this.query(
        `UPDATE customers SET ${column} = $2${isDate ? "::date" : ""},
           facts = jsonb_set(facts, ARRAY[$3::text], jsonb_build_object('value', $2::text, 'previous', $4::text, 'at', $5::numeric)),
           updated_at = now()
         WHERE id = $1`,
        [customerId, value, field, currentValues[field], ts],
      );
      changed.push(field);
    }
    const company = facts.company_name?.trim() || current.companyName;
    const stir = facts.stir?.trim() || current.stir;
    if (changed.includes("company_name") || changed.includes("stir")) {
      await this.query(
        `INSERT INTO companies (customer_id, name, stir) VALUES ($1, $2, $3)
         ON CONFLICT (customer_id, stir) DO UPDATE SET name = EXCLUDED.name`,
        [customerId, company, stir ?? ""],
      );
    }
    if (changed.includes("license_number") || changed.includes("license_expiry")) {
      const number = facts.license_number?.trim() || current.licenseNumber || "";
      const expiry = facts.license_expiry?.trim() || current.licenseExpiry;
      await this.query(
        `INSERT INTO licenses (customer_id, number, expires_on, mineral) VALUES ($1, $2, $3::date, $4)
         ON CONFLICT (customer_id, number) DO UPDATE SET expires_on = COALESCE(EXCLUDED.expires_on, licenses.expires_on)`,
        [customerId, number, expiry && /^\d{4}-\d{2}-\d{2}$/.test(expiry) ? expiry : null, current.mineral],
      );
    }
    return changed;
  }

  async addServices(customerId: number, services: string[], status: "interested" | "price_asked"): Promise<void> {
    for (const service of services.map((s) => s.trim()).filter(Boolean)) {
      await this.query(
        `INSERT INTO customer_services (customer_id, service, status) VALUES ($1, $2, $3)
         ON CONFLICT (customer_id, service) DO UPDATE SET last_at = now(),
           status = CASE WHEN EXCLUDED.status = 'price_asked' THEN 'price_asked' ELSE customer_services.status END`,
        [customerId, service.slice(0, 120), status],
      );
    }
  }

  async updatePipeline(
    customerId: number,
    patch: { stage?: string; objection?: string; nextStep?: string; priceAsked?: boolean; rejected?: boolean; complaint?: boolean },
  ): Promise<void> {
    await this.query(
      `INSERT INTO sales_pipeline (customer_id, stage, objections, next_step, price_asked, rejected, complaint)
       VALUES ($1, COALESCE($2, 'new'), CASE WHEN $3::text IS NULL THEN '{}'::text[] ELSE ARRAY[$3::text] END, $4,
               COALESCE($5, false), COALESCE($6, false), COALESCE($7, false))
       ON CONFLICT (customer_id) DO UPDATE SET
         stage = COALESCE($2, sales_pipeline.stage),
         objections = CASE WHEN $3::text IS NULL OR $3::text = ANY(sales_pipeline.objections) THEN sales_pipeline.objections
                           ELSE array_append(sales_pipeline.objections, $3::text) END,
         next_step = COALESCE($4, sales_pipeline.next_step),
         price_asked = sales_pipeline.price_asked OR COALESCE($5, false),
         rejected = COALESCE($6, sales_pipeline.rejected),
         complaint = sales_pipeline.complaint OR COALESCE($7, false),
         updated_at = now()`,
      [
        customerId,
        patch.stage ?? null,
        patch.objection ?? null,
        patch.nextStep ?? null,
        patch.priceAsked ?? null,
        patch.rejected ?? null,
        patch.complaint ?? null,
      ],
    );
  }

  async addMemory(customerId: number, kind: string, content: string, sourceMessageId: number | null): Promise<void> {
    await this.query(
      "INSERT INTO customer_memories (customer_id, kind, content, source_message_id) VALUES ($1, $2, $3, $4)",
      [customerId, kind, content.slice(0, 1000), sourceMessageId],
    );
  }

  async memories(customerId: number, limit = 40): Promise<{ kind: string; content: string; ts: number }[]> {
    const result = await this.query<{ kind: string; content: string; ts: string }>(
      `SELECT kind, content, extract(epoch FROM created_at) AS ts FROM customer_memories WHERE customer_id = $1
       ORDER BY created_at DESC LIMIT $2`,
      [customerId, limit],
    );
    return result.rows.map((row) => ({ kind: row.kind, content: row.content, ts: Number(row.ts) })).reverse();
  }

  // ---- summaries -------------------------------------------------------------------------------------------------

  async summary(customerId: number): Promise<Summary | null> {
    const result = await this.query<{ summary: string; analysis: Record<string, unknown>; last_message_id: string; updated: string }>(
      `SELECT summary, analysis, last_message_id, extract(epoch FROM updated_at) AS updated
       FROM conversation_summaries WHERE customer_id = $1`,
      [customerId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { summary: row.summary, analysis: row.analysis, lastMessageId: Number(row.last_message_id), updatedAt: Number(row.updated) };
  }

  async saveSummary(customerId: number, summary: string, analysis: Record<string, unknown>, lastMessageId: number): Promise<void> {
    await this.query(
      `INSERT INTO conversation_summaries (customer_id, summary, analysis, last_message_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (customer_id) DO UPDATE SET summary = EXCLUDED.summary, analysis = EXCLUDED.analysis,
         last_message_id = EXCLUDED.last_message_id, updated_at = now()`,
      [customerId, summary, JSON.stringify(analysis), lastMessageId],
    );
  }

  // ---- semantic memory -------------------------------------------------------------------------------------------

  async addEmbedding(customerId: number, messageId: number | null, content: string, model: string, vector: number[]): Promise<void> {
    const value = this.vectorMode === "pgvector" ? `[${vector.join(",")}]` : vector;
    await this.query(
      `INSERT INTO memory_embeddings (customer_id, message_id, content, model, embedding) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (message_id) DO NOTHING`,
      [customerId, messageId, content, model, value],
    );
  }

  /** Messages that have no embedding yet (for the background backfill). */
  async messagesWithoutEmbedding(limit: number): Promise<StoredMessage[]> {
    const result = await this.query<MessageRow>(
      `SELECT m.id, m.customer_id, m.conversation_id, m.role, m.author, m.text, m.language, extract(epoch FROM m.ts) AS ts
       FROM messages m
       WHERE NOT EXISTS (SELECT 1 FROM memory_embeddings e WHERE e.message_id = m.id) AND length(m.text) >= 20
         AND m.text NOT LIKE '[document]%' AND m.text NOT LIKE '[photo]%'
       ORDER BY m.id DESC LIMIT $1`,
      [limit],
    );
    return result.rows.map(toMessage);
  }

  /** Nearest earlier messages by meaning; customerId null searches every chat (admin only). */
  async searchSimilar(customerId: number | null, vector: number[], limit: number, excludeAfterId?: number): Promise<SimilarHit[]> {
    const params: unknown[] = [];
    const where: string[] = [];
    if (customerId !== null) {
      params.push(customerId);
      where.push(`e.customer_id = $${params.length}`);
    }
    if (excludeAfterId !== undefined) {
      params.push(excludeAfterId);
      where.push(`(e.message_id IS NULL OR e.message_id < $${params.length})`);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    if (this.vectorMode === "pgvector") {
      params.push(`[${vector.join(",")}]`);
      const vectorParam = `$${params.length}`;
      params.push(limit);
      const result = await this.query<{ message_id: string | null; customer_id: string; content: string; score: number; ts: string }>(
        `SELECT e.message_id, e.customer_id, e.content, 1 - (e.embedding <=> ${vectorParam}::vector) AS score,
                extract(epoch FROM COALESCE(m.ts, e.created_at)) AS ts
         FROM memory_embeddings e LEFT JOIN messages m ON m.id = e.message_id ${whereSql}
         ORDER BY e.embedding <=> ${vectorParam}::vector LIMIT $${params.length}`,
        params,
      );
      return result.rows.map((row) => ({
        messageId: row.message_id === null ? null : Number(row.message_id),
        customerId: Number(row.customer_id),
        content: row.content,
        score: Number(row.score),
        ts: Number(row.ts),
      }));
    }
    // real[] fallback: the candidates are scored in Node (fine for a few thousand rows per customer).
    const result = await this.query<{ message_id: string | null; customer_id: string; content: string; embedding: number[]; ts: string }>(
      `SELECT e.message_id, e.customer_id, e.content, e.embedding, extract(epoch FROM COALESCE(m.ts, e.created_at)) AS ts
       FROM memory_embeddings e LEFT JOIN messages m ON m.id = e.message_id ${whereSql}
       ORDER BY e.id DESC LIMIT 5000`,
      params,
    );
    return result.rows
      .map((row) => ({
        messageId: row.message_id === null ? null : Number(row.message_id),
        customerId: Number(row.customer_id),
        content: row.content,
        score: cosine(vector, row.embedding.map(Number)),
        ts: Number(row.ts),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** Keyword search (used when no embeddings are available, and by the admin's search). */
  async searchKeyword(customerId: number | null, query: string, limit: number, sinceEpoch?: number): Promise<StoredMessage[]> {
    const words = query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 3)
      .slice(0, 8);
    if (words.length === 0) return [];
    const params: unknown[] = [words.map((w) => `%${w}%`)];
    const where = ["m.text ILIKE ANY($1)"];
    if (customerId !== null) {
      params.push(customerId);
      where.push(`m.customer_id = $${params.length}`);
    }
    if (sinceEpoch !== undefined) {
      params.push(sinceEpoch);
      where.push(`m.ts >= to_timestamp($${params.length})`);
    }
    params.push(limit);
    const result = await this.query<MessageRow>(
      `SELECT m.id, m.customer_id, m.conversation_id, m.role, m.author, m.text, m.language, extract(epoch FROM m.ts) AS ts
       FROM messages m WHERE ${where.join(" AND ")} ORDER BY m.ts DESC LIMIT $${params.length}`,
      params,
    );
    return result.rows.map(toMessage);
  }

  // ---- AI bookkeeping ----------------------------------------------------------------------------------------------

  async saveAiRequest(record: AiRequestRecord): Promise<void> {
    await this.query(
      `INSERT INTO ai_requests (request_id, chat_id, customer_id, admin_id, incoming_key, request_type, complexity,
         context_completeness, selected_workflow, workflow_path, confidence_score, confidence_level, required_permissions,
         execution_status, final_result, provider, model, topic, service, error, finished_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20, now())
       ON CONFLICT (request_id) DO UPDATE SET execution_status = EXCLUDED.execution_status,
         final_result = EXCLUDED.final_result, selected_workflow = EXCLUDED.selected_workflow,
         workflow_path = EXCLUDED.workflow_path, provider = EXCLUDED.provider, model = EXCLUDED.model,
         error = EXCLUDED.error, finished_at = now()`,
      [
        record.requestId,
        record.chatId,
        record.customerId,
        record.adminId,
        record.incomingKey,
        record.requestType,
        record.complexity,
        record.contextCompleteness,
        record.selectedWorkflow,
        record.workflowPath,
        record.confidenceScore,
        record.confidenceLevel,
        record.requiredPermissions,
        record.executionStatus,
        record.finalResult?.slice(0, 4000) ?? null,
        record.provider,
        record.model,
        record.topic,
        record.service,
        record.error?.slice(0, 1000) ?? null,
      ],
    );
  }

  async logProvider(entry: {
    provider: string;
    model: string;
    purpose: string;
    ok: boolean;
    failure: string | null;
    error: string | null;
    latencyMs: number;
    inputTokens: number;
    outputTokens: number;
    attempt: number;
  }): Promise<void> {
    await this.query(
      `INSERT INTO ai_provider_logs (provider, model, purpose, ok, failure, error, latency_ms, input_tokens, output_tokens, attempt)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        entry.provider,
        entry.model,
        entry.purpose,
        entry.ok,
        entry.failure,
        entry.error?.slice(0, 1000) ?? null,
        Math.round(entry.latencyMs),
        entry.inputTokens,
        entry.outputTokens,
        entry.attempt,
      ],
    );
  }

  // ---- pending replies (both providers down) ------------------------------------------------------------------------

  async enqueuePending(incomingKey: string, customerId: number, chat: Record<string, unknown>, error: string): Promise<void> {
    await this.query(
      `INSERT INTO pending_replies (incoming_key, customer_id, chat, last_error) VALUES ($1, $2, $3, $4)
       ON CONFLICT (incoming_key) DO UPDATE SET attempts = pending_replies.attempts + 1, last_error = EXCLUDED.last_error,
         status = 'waiting', updated_at = now()`,
      [incomingKey, customerId, JSON.stringify(chat), error.slice(0, 500)],
    );
  }

  async pendingReplies(limit = 20): Promise<PendingReply[]> {
    const result = await this.query<{ incoming_key: string; customer_id: string; chat: Record<string, unknown>; attempts: number }>(
      "SELECT incoming_key, customer_id, chat, attempts FROM pending_replies WHERE status = 'waiting' ORDER BY created_at LIMIT $1",
      [limit],
    );
    return result.rows.map((row) => ({
      incomingKey: row.incoming_key,
      customerId: Number(row.customer_id),
      chat: row.chat,
      attempts: row.attempts,
    }));
  }

  async finishPending(incomingKey: string): Promise<void> {
    await this.query("UPDATE pending_replies SET status = 'done', updated_at = now() WHERE incoming_key = $1", [incomingKey]);
  }

  // ---- admin -----------------------------------------------------------------------------------------------------

  async addAdminMessage(adminId: number, role: "admin" | "assistant", text: string): Promise<void> {
    await this.query("INSERT INTO admin_messages (admin_id, role, text) VALUES ($1, $2, $3)", [adminId, role, text.slice(0, 12000)]);
  }

  async adminMessages(adminId: number, limit: number): Promise<{ role: "admin" | "assistant"; text: string }[]> {
    const result = await this.query<{ role: "admin" | "assistant"; text: string }>(
      "SELECT role, text FROM (SELECT id, role, text FROM admin_messages WHERE admin_id = $1 ORDER BY id DESC LIMIT $2) r ORDER BY id ASC",
      [adminId, limit],
    );
    return result.rows;
  }

  async adminFocus(adminId: number): Promise<Record<string, unknown>> {
    const result = await this.query<{ focus: Record<string, unknown> }>("SELECT focus FROM admin_state WHERE admin_id = $1", [adminId]);
    return result.rows[0]?.focus ?? {};
  }

  async setAdminFocus(adminId: number, focus: Record<string, unknown>): Promise<void> {
    await this.query(
      `INSERT INTO admin_state (admin_id, focus) VALUES ($1, $2)
       ON CONFLICT (admin_id) DO UPDATE SET focus = admin_state.focus || EXCLUDED.focus, updated_at = now()`,
      [adminId, JSON.stringify(focus)],
    );
  }

  async adminAction(adminId: number, action: string, target: string | null, details: Record<string, unknown> = {}): Promise<void> {
    await this.query("INSERT INTO admin_actions (admin_id, action, target, details) VALUES ($1, $2, $3, $4)", [
      adminId,
      action,
      target,
      JSON.stringify(details),
    ]);
  }

  async audit(actor: string, event: string, details: Record<string, unknown> = {}): Promise<void> {
    await this.query("INSERT INTO audit_logs (actor, event, details) VALUES ($1, $2, $3)", [actor, event, JSON.stringify(details)]);
  }

  async saveReport(adminId: number | null, title: string, format: string, fileName: string): Promise<void> {
    await this.query("INSERT INTO reports (admin_id, title, format, file_name) VALUES ($1, $2, $3, $4)", [adminId, title, format, fileName]);
  }

  async setKnowledge(key: string, title: string, content: string, verified: boolean, source: string): Promise<void> {
    await this.query(
      `INSERT INTO company_knowledge (key, title, content, verified, source) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (key) DO UPDATE SET title = EXCLUDED.title, content = EXCLUDED.content, verified = EXCLUDED.verified,
         source = EXCLUDED.source, updated_at = now()`,
      [key, title, content, verified, source],
    );
  }

  async markTaskRun(name: string, status: string, details: Record<string, unknown> = {}): Promise<void> {
    await this.query(
      `INSERT INTO scheduled_tasks (name, last_run_at, last_status, details) VALUES ($1, now(), $2, $3)
       ON CONFLICT (name) DO UPDATE SET last_run_at = now(), last_status = EXCLUDED.last_status, details = EXCLUDED.details`,
      [name, status, JSON.stringify(details)],
    );
  }
}

const MESSAGE_COLUMNS = "id, customer_id, conversation_id, role, author, text, language, extract(epoch FROM ts) AS ts";

interface MessageRow {
  id: string;
  customer_id: string;
  conversation_id: string;
  role: MessageRole;
  author: string;
  text: string;
  language: string | null;
  ts: string;
}

interface ProfileRow {
  id: string;
  name: string;
  username: string;
  language: string | null;
  first_epoch: string;
  last_epoch: string;
  company_name: string | null;
  stir: string | null;
  phone: string | null;
  email: string | null;
  activity: string | null;
  location: string | null;
  mineral_type: string | null;
  mineral: string | null;
  license_number: string | null;
  license_expiry_text: string | null;
  preferences: string | null;
  decisions: string | null;
  next_contact_text: string | null;
  services: string[] | null;
  stage: string | null;
}

function toMessage(row: MessageRow): StoredMessage {
  return {
    id: Number(row.id),
    customerId: Number(row.customer_id),
    conversationId: row.conversation_id,
    role: row.role,
    author: row.author,
    text: row.text,
    language: row.language,
    ts: Number(row.ts),
  };
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}
