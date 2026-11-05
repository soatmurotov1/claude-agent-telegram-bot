import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "../store.js";
import type { Database, MessageRole } from "./database.js";

/**
 * The same key for a message whether it is written live or imported from transcripts.json, so the import can run at
 * every start: it fills in what is missing (e.g. messages written while the database was down) and never duplicates.
 */
export function messageKey(source: string, chatId: number, ts: number, fromCustomer: boolean, text: string): string {
  return crypto
    .createHash("sha1")
    .update(`${source}\u0000${chatId}\u0000${Math.round(ts)}\u0000${fromCustomer ? "c" : "o"}\u0000${text}`)
    .digest("hex");
}

export interface ImportResult {
  customers: number;
  messages: number;
}

/** Copies data/users.json and data/transcripts.json into PostgreSQL. The JSON files are left as they are. */
export async function importJsonData(db: Database, dataDir: string): Promise<ImportResult> {
  const result: ImportResult = { customers: 0, messages: 0 };
  const users = readJson(path.join(dataDir, "users.json"));
  if (Array.isArray(users)) {
    for (const user of users) {
      if (!isRecord(user) || typeof user.id !== "number") continue;
      await db.touchCustomer(user.id, String(user.name ?? ""), String(user.username ?? ""), null, Number(user.lastSeen ?? 0) || Date.now() / 1000);
      if (typeof user.firstSeen === "number") {
        await db.query("UPDATE customers SET first_seen = LEAST(first_seen, to_timestamp($2)) WHERE id = $1", [user.id, user.firstSeen]);
      }
      result.customers++;
    }
  }
  const transcripts = readJson(path.join(dataDir, "transcripts.json"));
  // Only the tail that may be missing is imported again: messages older than what the database already holds for
  // that customer are skipped (the unique key would skip them anyway; this keeps restarts fast).
  const latest = new Map<number, number>();
  const rows = await db.query<{ customer_id: string; ts: string }>(
    "SELECT customer_id, extract(epoch FROM max(ts)) AS ts FROM messages GROUP BY customer_id",
  );
  for (const row of rows.rows) latest.set(Number(row.customer_id), Number(row.ts));
  if (isRecord(transcripts)) {
    for (const [key, items] of Object.entries(transcripts)) {
      const split = key.lastIndexOf(":");
      const source = key.slice(0, split);
      const chatId = Number(key.slice(split + 1));
      if (!source || !Number.isSafeInteger(chatId) || !Array.isArray(items)) continue;
      for (const item of items) {
        if (!isRecord(item) || typeof item.text !== "string" || typeof item.ts !== "number") continue;
        if (item.ts < (latest.get(chatId) ?? -Infinity) - 3600) continue;
        const fromCustomer = item.role === "other";
        const role: MessageRole = fromCustomer ? "customer" : "bot";
        const id = await db.addMessage({
          customerId: chatId,
          source,
          role,
          author: String(item.name ?? ""),
          text: item.text,
          language: typeof item.lang === "string" ? item.lang : null,
          ts: item.ts,
          importKey: messageKey(source, chatId, item.ts, fromCustomer, item.text),
        });
        if (id !== null) result.messages++;
      }
    }
  }
  return result;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
