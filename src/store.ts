import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Language } from "./language.js";

export type Clock = () => number;

/** Creates the directory if needed and forces mode 0700 (mkdir's mode is subject to umask). */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

/** Writes a file atomically: a 0600 temp file in the same directory, then rename. */
export function writeFileAtomic(file: string, content: string): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(tmp, content, { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A JSON document on disk. Reads fall back to a default; writes are synchronous and atomic. */
export class JsonFile<T> {
  constructor(
    readonly file: string,
    private readonly fallback: () => T,
    private readonly validate: (value: unknown) => T | null,
  ) {}

  read(): T {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return this.validate(parsed) ?? this.fallback();
    } catch {
      return this.fallback();
    }
  }

  write(value: T): void {
    writeFileAtomic(this.file, JSON.stringify(value));
  }
}

export interface HistoryItem {
  role: "owner" | "other";
  name: string;
  text: string;
  lang: Language | null;
  ts: number;
}

function toHistoryItem(value: unknown): HistoryItem | null {
  if (!isRecord(value)) return null;
  const { role, name, text, lang, ts } = value;
  if (role !== "owner" && role !== "other") return null;
  if (typeof name !== "string" || typeof text !== "string" || typeof ts !== "number") return null;
  const language = lang === "uz" || lang === "ru" || lang === "en" ? lang : null;
  return { role, name, text, lang: language, ts };
}

/** Conversation history per business connection and chat, trimmed by count and age. */
export class HistoryStore {
  readonly #file: JsonFile<Record<string, HistoryItem[]>>;
  readonly #data: Record<string, HistoryItem[]>;

  constructor(
    file: string,
    private readonly limit: number,
    private readonly ttlDays: number,
    private readonly clock: Clock,
  ) {
    this.#file = new JsonFile(file, () => ({}), (value) => {
      if (!isRecord(value)) return null;
      const out: Record<string, HistoryItem[]> = {};
      for (const [key, items] of Object.entries(value)) {
        if (!Array.isArray(items)) continue;
        out[key] = items.map(toHistoryItem).filter((item): item is HistoryItem => item !== null);
      }
      return out;
    });
    this.#data = this.#file.read();
    if (this.#prune()) this.#file.write(this.#data);
  }

  static key(connectionId: string, chatId: number): string {
    return `${connectionId}:${chatId}`;
  }

  get(connectionId: string, chatId: number): HistoryItem[] {
    if (this.#prune()) this.#file.write(this.#data);
    return [...(this.#data[HistoryStore.key(connectionId, chatId)] ?? [])];
  }

  add(connectionId: string, chatId: number, item: Omit<HistoryItem, "ts">): void {
    const key = HistoryStore.key(connectionId, chatId);
    const items = this.#data[key] ?? [];
    items.push({ ...item, ts: this.clock() });
    this.#data[key] = items;
    this.#prune();
    this.#file.write(this.#data);
  }

  lastLanguage(connectionId: string, chatId: number): Language | null {
    const items = this.#data[HistoryStore.key(connectionId, chatId)] ?? [];
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item?.role === "other" && item.lang) return item.lang;
    }
    return null;
  }

  chatCount(): number {
    if (this.#prune()) this.#file.write(this.#data);
    return Object.keys(this.#data).length;
  }

  /** Drops expired and overflowing items and empty chats. Returns true when something changed. */
  #prune(): boolean {
    const cutoff = this.clock() - this.ttlDays * 86400;
    let changed = false;
    for (const [key, items] of Object.entries(this.#data)) {
      let kept = items.filter((item) => item.ts >= cutoff);
      if (kept.length > this.limit) kept = kept.slice(-this.limit);
      if (kept.length === 0) {
        delete this.#data[key];
        changed = true;
      } else if (kept.length !== items.length) {
        this.#data[key] = kept;
        changed = true;
      }
    }
    return changed;
  }
}

/** Remembers recently handled message keys (insertion ordered, persisted) to drop duplicates. */
export class SeenMessages {
  readonly #file: JsonFile<string[]>;
  readonly #keys: Map<string, true>;

  constructor(file: string, private readonly capacity = 5000) {
    this.#file = new JsonFile(file, () => [], (value) =>
      Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : null,
    );
    this.#keys = new Map(this.#file.read().map((key) => [key, true]));
  }

  /** Returns true the first time a key is seen and records it; false for every later call. */
  firstTime(key: string): boolean {
    if (this.#keys.has(key)) return false;
    this.#keys.set(key, true);
    while (this.#keys.size > this.capacity) {
      const oldest = this.#keys.keys().next();
      if (oldest.done) break;
      this.#keys.delete(oldest.value);
    }
    this.#file.write([...this.#keys.keys()]);
    return true;
  }
}

interface StateData {
  paused: boolean;
  limitUntil: number;
}

/** Pause flag and usage-limit deadline, kept across restarts. */
export class RuntimeState {
  readonly #file: JsonFile<StateData>;
  #data: StateData;

  constructor(file: string) {
    this.#file = new JsonFile<StateData>(file, () => ({ paused: false, limitUntil: 0 }), (value) => {
      if (!isRecord(value)) return null;
      return {
        paused: value.paused === true,
        limitUntil: typeof value.limitUntil === "number" ? value.limitUntil : 0,
      };
    });
    this.#data = this.#file.read();
  }

  get paused(): boolean {
    return this.#data.paused;
  }

  set paused(value: boolean) {
    this.#data = { ...this.#data, paused: value };
    this.#file.write(this.#data);
  }

  get limitUntil(): number {
    return this.#data.limitUntil;
  }

  set limitUntil(value: number) {
    this.#data = { ...this.#data, limitUntil: value };
    this.#file.write(this.#data);
  }
}

/** Appends one JSON line to a 0600 file. */
export function appendJsonl(file: string, record: Record<string, unknown>): void {
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

/** Removes lines older than ttlDays (by their `ts` field) from a JSONL file, atomically. */
export function pruneJsonl(file: string, ttlDays: number, clock: Clock): number {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return 0;
  }
  const cutoff = clock() - ttlDays * 86400;
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const kept = lines.filter((line) => {
    try {
      const parsed: unknown = JSON.parse(line);
      return isRecord(parsed) && typeof parsed.ts === "number" && parsed.ts >= cutoff;
    } catch {
      return false;
    }
  });
  const removed = lines.length - kept.length;
  if (removed > 0) writeFileAtomic(file, kept.map((line) => `${line}\n`).join(""));
  return removed;
}
