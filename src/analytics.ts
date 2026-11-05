import type { Database } from "./db/database.js";

/**
 * Statistics Engine: read-only queries over the real database for the Admin AI Assistant. Every function returns
 * plain rows; the AI turns them into conclusions. Nothing here is ever reachable from a customer conversation.
 */

export interface Period {
  since: number;
  until: number;
}

export function periodDays(days: number, now = Date.now() / 1000): Period {
  return { since: now - Math.max(0, days) * 86400, until: now };
}

/** Today from 00:00 Tashkent time (UTC+5). */
export function today(now = Date.now() / 1000): Period {
  const offset = 5 * 3600;
  const start = Math.floor((now + offset) / 86400) * 86400 - offset;
  return { since: start, until: now };
}

export async function overview(db: Database, period: Period): Promise<Record<string, number>> {
  const r = await db.query<Record<string, string>>(
    `SELECT
       (SELECT count(DISTINCT customer_id) FROM messages WHERE role = 'customer' AND ts BETWEEN to_timestamp($1) AND to_timestamp($2)) AS customers_who_wrote,
       (SELECT count(*) FROM customers WHERE first_seen BETWEEN to_timestamp($1) AND to_timestamp($2)) AS new_customers,
       (SELECT count(*) FROM messages WHERE ts BETWEEN to_timestamp($1) AND to_timestamp($2)) AS messages_total,
       (SELECT count(*) FROM messages WHERE role = 'customer' AND ts BETWEEN to_timestamp($1) AND to_timestamp($2)) AS customer_messages,
       (SELECT count(*) FROM messages WHERE role = 'bot' AND ts BETWEEN to_timestamp($1) AND to_timestamp($2)) AS bot_messages,
       (SELECT count(*) FROM messages WHERE role = 'admin' AND ts BETWEEN to_timestamp($1) AND to_timestamp($2)) AS admin_messages,
       (SELECT count(*) FROM ai_requests WHERE request_type = 'price_request' AND created_at BETWEEN to_timestamp($1) AND to_timestamp($2)) AS price_requests,
       (SELECT count(*) FROM ai_requests WHERE request_type IN ('complaint') AND created_at BETWEEN to_timestamp($1) AND to_timestamp($2)) AS complaints,
       (SELECT count(*) FROM ai_requests WHERE selected_workflow = 'escalate' AND created_at BETWEEN to_timestamp($1) AND to_timestamp($2)) AS escalations,
       (SELECT count(*) FROM customers) AS customers_all_time`,
    [period.since, period.until],
  );
  const row = r.rows[0] ?? {};
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)]));
}

export interface ChatRow {
  customer_id: number;
  name: string;
  username: string;
  company_name: string | null;
  messages: number;
  customer_messages: number;
  bot_messages: number;
  admin_messages: number;
  first_message: string;
  last_message: string;
  topic: string | null;
  outcome: string | null;
  next_task: string | null;
  stage: string | null;
  services: string[];
}

/** The chats with the most messages in the period (all time when days is 0). */
export async function topChats(db: Database, limit: number, period: Period | null): Promise<ChatRow[]> {
  const params: unknown[] = [Math.min(Math.max(limit, 1), 100)];
  let where = "";
  if (period) {
    params.push(period.since, period.until);
    where = "WHERE m.ts BETWEEN to_timestamp($2) AND to_timestamp($3)";
  }
  const r = await db.query<Record<string, unknown>>(
    `SELECT c.id AS customer_id, c.name, c.username, c.company_name,
            count(m.id) AS messages,
            count(m.id) FILTER (WHERE m.role = 'customer') AS customer_messages,
            count(m.id) FILTER (WHERE m.role = 'bot') AS bot_messages,
            count(m.id) FILTER (WHERE m.role = 'admin') AS admin_messages,
            to_char(min(m.ts) AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD HH24:MI') AS first_message,
            to_char(max(m.ts) AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD HH24:MI') AS last_message,
            s.analysis->>'topic' AS topic, s.analysis->>'outcome' AS outcome, s.analysis->>'next_task' AS next_task,
            p.stage,
            COALESCE((SELECT array_agg(service) FROM customer_services cs WHERE cs.customer_id = c.id), '{}') AS services
     FROM customers c JOIN messages m ON m.customer_id = c.id
     LEFT JOIN conversation_summaries s ON s.customer_id = c.id
     LEFT JOIN sales_pipeline p ON p.customer_id = c.id
     ${where}
     GROUP BY c.id, s.analysis, p.stage
     ORDER BY messages DESC, max(m.ts) DESC
     LIMIT $1`,
    params,
  );
  return r.rows.map((row) => ({
    customer_id: Number(row.customer_id),
    name: String(row.name ?? ""),
    username: String(row.username ?? ""),
    company_name: (row.company_name as string | null) ?? null,
    messages: Number(row.messages),
    customer_messages: Number(row.customer_messages),
    bot_messages: Number(row.bot_messages),
    admin_messages: Number(row.admin_messages),
    first_message: String(row.first_message ?? ""),
    last_message: String(row.last_message ?? ""),
    topic: (row.topic as string | null) ?? null,
    outcome: (row.outcome as string | null) ?? null,
    next_task: (row.next_task as string | null) ?? null,
    stage: (row.stage as string | null) ?? null,
    services: (row.services as string[]) ?? [],
  }));
}

/** Customers matching a name, @username, company, STIR or ID. */
export async function findCustomers(db: Database, query: string, limit = 10): Promise<{ id: number; name: string; username: string; company_name: string | null; stir: string | null; last_seen: string }[]> {
  const q = query.trim().replace(/^@/, "");
  if (!q) return [];
  const r = await db.query<Record<string, unknown>>(
    `SELECT id, name, username, company_name, stir, to_char(last_seen AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD HH24:MI') AS last_seen
     FROM customers
     WHERE id::text = $1 OR stir = $1 OR username ILIKE $1 OR name ILIKE '%' || $1 || '%' OR company_name ILIKE '%' || $1 || '%'
     ORDER BY last_seen DESC LIMIT $2`,
    [q, limit],
  );
  return r.rows.map((row) => ({
    id: Number(row.id),
    name: String(row.name ?? ""),
    username: String(row.username ?? ""),
    company_name: (row.company_name as string | null) ?? null,
    stir: (row.stir as string | null) ?? null,
    last_seen: String(row.last_seen ?? ""),
  }));
}

export async function customerStats(db: Database, customerId: number): Promise<Record<string, unknown>> {
  const r = await db.query<Record<string, unknown>>(
    `SELECT count(*) AS messages,
            count(*) FILTER (WHERE role = 'customer') AS customer_messages,
            count(*) FILTER (WHERE role = 'bot') AS bot_messages,
            count(*) FILTER (WHERE role = 'admin') AS admin_messages,
            to_char(min(ts) AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD HH24:MI') AS started,
            to_char(max(ts) AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD HH24:MI') AS last_activity
     FROM messages WHERE customer_id = $1`,
    [customerId],
  );
  const pipeline = await db.query<Record<string, unknown>>("SELECT stage, objections, next_step, price_asked, offer_sent, rejected, complaint FROM sales_pipeline WHERE customer_id = $1", [customerId]);
  const requests = await db.query<{ request_type: string; n: string }>(
    "SELECT request_type, count(*) AS n FROM ai_requests WHERE customer_id = $1 GROUP BY request_type ORDER BY n DESC",
    [customerId],
  );
  const row = r.rows[0] ?? {};
  return {
    messages: Number(row.messages ?? 0),
    customer_messages: Number(row.customer_messages ?? 0),
    bot_messages: Number(row.bot_messages ?? 0),
    admin_messages: Number(row.admin_messages ?? 0),
    started: row.started ?? null,
    last_activity: row.last_activity ?? null,
    pipeline: pipeline.rows[0] ?? null,
    request_types: Object.fromEntries(requests.rows.map((x) => [x.request_type, Number(x.n)])),
  };
}

export async function customerMessages(
  db: Database,
  customerId: number,
  options: { limit?: number; query?: string; role?: "customer" | "bot" | "admin"; newestFirst?: boolean },
): Promise<{ ts: string; role: string; text: string }[]> {
  const params: unknown[] = [customerId];
  const where = ["customer_id = $1"];
  if (options.role) {
    params.push(options.role);
    where.push(`role = $${params.length}`);
  }
  if (options.query?.trim()) {
    params.push(`%${options.query.trim()}%`);
    where.push(`text ILIKE $${params.length}`);
  }
  params.push(Math.min(Math.max(options.limit ?? 30, 1), 300));
  const r = await db.query<{ ts: string; role: string; text: string }>(
    `SELECT to_char(ts AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD HH24:MI') AS ts, role, text FROM messages
     WHERE ${where.join(" AND ")} ORDER BY messages.ts DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  const rows = r.rows.map((row) => ({ ts: row.ts, role: row.role, text: row.text.slice(0, 2000) }));
  return options.newestFirst ? rows : rows.reverse();
}

export async function requestTypeStats(db: Database, period: Period): Promise<Record<string, unknown>> {
  const types = await db.query<{ request_type: string; n: string }>(
    `SELECT request_type, count(*) AS n FROM ai_requests WHERE customer_id IS NOT NULL AND created_at BETWEEN to_timestamp($1) AND to_timestamp($2)
     GROUP BY request_type ORDER BY n DESC`,
    [period.since, period.until],
  );
  const topics = await db.query<{ topic: string; n: string }>(
    `SELECT lower(topic) AS topic, count(*) AS n FROM ai_requests WHERE topic IS NOT NULL AND topic <> '' AND customer_id IS NOT NULL
       AND created_at BETWEEN to_timestamp($1) AND to_timestamp($2) GROUP BY lower(topic) ORDER BY n DESC LIMIT 25`,
    [period.since, period.until],
  );
  const services = await db.query<{ service: string; customers: string; price_asked: string }>(
    `SELECT service, count(*) AS customers, count(*) FILTER (WHERE status = 'price_asked') AS price_asked FROM customer_services
     WHERE last_at BETWEEN to_timestamp($1) AND to_timestamp($2) GROUP BY service ORDER BY customers DESC LIMIT 25`,
    [period.since, period.until],
  );
  return {
    request_types: types.rows.map((x) => ({ type: x.request_type, count: Number(x.n) })),
    topics: topics.rows.map((x) => ({ topic: x.topic, count: Number(x.n) })),
    services: services.rows.map((x) => ({ service: x.service, customers: Number(x.customers), price_asked: Number(x.price_asked) })),
  };
}

export const CUSTOMER_CRITERIA = [
  "price_asked",
  "interested",
  "complaint",
  "rejected",
  "offer_sent",
  "escalated",
  "unanswered_chat",
  "license_expiring",
  "active",
  "documents_sent",
] as const;
export type CustomerCriterion = (typeof CUSTOMER_CRITERIA)[number];

/** Customers that match one criterion, newest activity first. */
export async function customersBy(
  db: Database,
  criterion: CustomerCriterion,
  options: { period?: Period | null; days?: number; limit?: number },
): Promise<Record<string, unknown>[]> {
  const limit = Math.min(Math.max(options.limit ?? 30, 1), 200);
  const base = `SELECT c.id AS customer_id, c.name, c.username, c.company_name, c.stir,
                       to_char(c.last_seen AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD HH24:MI') AS last_seen,
                       p.stage, s.analysis->>'topic' AS topic, s.analysis->>'outcome' AS outcome`;
  const joins = `FROM customers c LEFT JOIN sales_pipeline p ON p.customer_id = c.id LEFT JOIN conversation_summaries s ON s.customer_id = c.id`;
  const period = options.period ?? null;
  const inPeriod = (column: string, first: number): string =>
    period ? ` AND ${column} BETWEEN to_timestamp($${first}) AND to_timestamp($${first + 1})` : "";
  const periodParams = period ? [period.since, period.until] : [];
  let sql: string;
  let params: unknown[];
  switch (criterion) {
    case "price_asked":
    case "complaint":
    case "escalated": {
      const condition =
        criterion === "price_asked"
          ? "r.request_type = 'price_request'"
          : criterion === "complaint"
            ? "r.request_type = 'complaint'"
            : "r.selected_workflow = 'escalate'";
      sql = `${base}, count(r.request_id) AS times, to_char(max(r.created_at) AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD HH24:MI') AS last_time,
                    string_agg(DISTINCT r.service, ', ') AS services
             ${joins} JOIN ai_requests r ON r.customer_id = c.id
             WHERE ${condition}${inPeriod("r.created_at", 2)}
             GROUP BY c.id, p.stage, s.analysis ORDER BY max(r.created_at) DESC LIMIT $1`;
      params = [limit, ...periodParams];
      break;
    }
    case "interested":
      sql = `${base}, string_agg(cs.service, ', ') AS services ${joins} JOIN customer_services cs ON cs.customer_id = c.id
             WHERE true${inPeriod("cs.last_at", 2)} GROUP BY c.id, p.stage, s.analysis ORDER BY max(cs.last_at) DESC LIMIT $1`;
      params = [limit, ...periodParams];
      break;
    case "rejected":
      sql = `${base}, p.objections ${joins} WHERE (p.rejected OR p.stage = 'rejected')${inPeriod("p.updated_at", 2)}
             ORDER BY p.updated_at DESC LIMIT $1`;
      params = [limit, ...periodParams];
      break;
    case "offer_sent":
      sql = `${base} ${joins} WHERE (p.offer_sent OR p.stage IN ('negotiation'))${inPeriod("p.updated_at", 2)} ORDER BY p.updated_at DESC LIMIT $1`;
      params = [limit, ...periodParams];
      break;
    case "documents_sent":
      sql = `${base} ${joins} WHERE p.stage IN ('documents_in_progress', 'documents_sent')${inPeriod("p.updated_at", 2)} ORDER BY p.updated_at DESC LIMIT $1`;
      params = [limit, ...periodParams];
      break;
    case "unanswered_chat":
      sql = `${base}, last.text AS last_customer_message, to_char(last.ts AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD HH24:MI') AS written_at
             ${joins}
             JOIN LATERAL (SELECT role, text, ts FROM messages m WHERE m.customer_id = c.id ORDER BY ts DESC, id DESC LIMIT 1) last ON true
             WHERE last.role = 'customer'${inPeriod("last.ts", 2)} ORDER BY last.ts DESC LIMIT $1`;
      params = [limit, ...periodParams];
      break;
    case "license_expiring":
      sql = `${base}, c.license_number, to_char(c.license_expiry, 'YYYY-MM-DD') AS license_expiry,
                    (c.license_expiry - (now() AT TIME ZONE 'Asia/Tashkent')::date) AS days_left
             ${joins} WHERE c.license_expiry IS NOT NULL
               AND c.license_expiry BETWEEN (now() AT TIME ZONE 'Asia/Tashkent')::date AND (now() AT TIME ZONE 'Asia/Tashkent')::date + $2::int
             ORDER BY c.license_expiry ASC LIMIT $1`;
      params = [limit, options.days ?? 30];
      break;
    case "active":
      sql = `${base}, count(m.id) AS messages ${joins} JOIN messages m ON m.customer_id = c.id AND m.role = 'customer'
             WHERE true${inPeriod("m.ts", 2)} GROUP BY c.id, p.stage, s.analysis ORDER BY messages DESC LIMIT $1`;
      params = [limit, ...periodParams];
      break;
  }
  const r = await db.query<Record<string, unknown>>(sql, params);
  return r.rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === "string" && /^\d+$/.test(v) && k !== "stir" && k !== "username" ? Number(v) : v])));
}

/** Questions the bot could not answer well: low confidence, missing facts, or listed as unanswered in summaries. */
export async function unansweredQuestions(db: Database, period: Period, limit = 40): Promise<Record<string, unknown>[]> {
  const r = await db.query<Record<string, unknown>>(
    `SELECT r.customer_id, c.name, c.company_name, r.request_type, r.topic, r.confidence_score, r.selected_workflow,
            to_char(r.created_at AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD HH24:MI') AS at,
            (SELECT text FROM messages m WHERE m.customer_id = r.customer_id AND m.role = 'customer' AND m.ts <= r.created_at
             ORDER BY m.ts DESC LIMIT 1) AS question
     FROM ai_requests r JOIN customers c ON c.id = r.customer_id
     WHERE r.created_at BETWEEN to_timestamp($1) AND to_timestamp($2)
       AND (r.confidence_score < 0.45 OR r.context_completeness = 'insufficient' OR r.execution_status IN ('failed', 'queued'))
     ORDER BY r.created_at DESC LIMIT $3`,
    [period.since, period.until, limit],
  );
  const fromSummaries = await db.query<{ customer_id: string; name: string; unanswered: unknown }>(
    `SELECT s.customer_id, c.name, s.analysis->'unanswered' AS unanswered FROM conversation_summaries s JOIN customers c ON c.id = s.customer_id
     WHERE jsonb_typeof(s.analysis->'unanswered') = 'array' AND jsonb_array_length(s.analysis->'unanswered') > 0
       AND s.updated_at BETWEEN to_timestamp($1) AND to_timestamp($2)`,
    [period.since, period.until],
  );
  return [
    ...r.rows,
    ...fromSummaries.rows.map((row) => ({ customer_id: Number(row.customer_id), name: row.name, from_summary: row.unanswered })),
  ];
}

export async function providerStats(db: Database, period: Period): Promise<Record<string, unknown>[]> {
  const r = await db.query<Record<string, unknown>>(
    `SELECT provider, count(*) FILTER (WHERE ok) AS ok_calls, count(*) FILTER (WHERE NOT ok) AS failed_calls,
            sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens, round(avg(latency_ms)) AS avg_latency_ms
     FROM ai_provider_logs WHERE created_at BETWEEN to_timestamp($1) AND to_timestamp($2) GROUP BY provider`,
    [period.since, period.until],
  );
  return r.rows;
}

/** Messages of every chat that mention the query (admin search). */
export async function searchAll(db: Database, query: string, period: Period | null, limit = 30): Promise<Record<string, unknown>[]> {
  const hits = await db.searchKeyword(null, query, limit, period?.since);
  const names = new Map<number, string>();
  for (const hit of hits) {
    if (names.has(hit.customerId)) continue;
    const profile = await db.profile(hit.customerId);
    names.set(hit.customerId, profile ? `${profile.name}${profile.companyName ? ` (${profile.companyName})` : ""}` : String(hit.customerId));
  }
  return hits.map((hit) => ({
    customer_id: hit.customerId,
    customer: names.get(hit.customerId),
    role: hit.role,
    at: new Date(hit.ts * 1000).toISOString().slice(0, 16).replace("T", " "),
    text: hit.text.slice(0, 600),
  }));
}
