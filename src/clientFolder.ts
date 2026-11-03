import fs from "node:fs";
import path from "node:path";
import type { Language } from "./language.js";
import { appendJsonl, type Clock, ensurePrivateDir, isRecord, JsonFile } from "./store.js";

/** One file a client sent, as saved in their folder. Files are not checked: they are only counted and passed on. */
export interface ReceivedFile {
  /** Path inside the client folder, e.g. "received/20261102-114700_Ustav.pdf". */
  path: string;
  /** The name the client gave it. */
  name: string;
  /** Telegram file_id, so the file can be passed on without uploading it again (any size). */
  fileId?: string;
  ts: number;
}

/** A received file with its absolute path, ready to be sent. */
export interface PackageFile {
  /** 1-based number of the file in the order the client sent it. */
  number: number;
  file: string;
  name: string;
  fileId?: string;
}

export interface ClientStatus {
  /** Every file the client sent, oldest first. */
  received: ReceivedFile[];
  /** When the whole package went to the owner (once), or null. */
  packageSentAt: number | null;
  /** Keys of the documents the client said they do not have («❌ Menda yo'q»); they are not asked for. */
  missing: string[];
}

function toReceived(value: unknown): ReceivedFile | null {
  if (!isRecord(value) || typeof value.path !== "string" || typeof value.name !== "string") return null;
  const file: ReceivedFile = { path: value.path, name: value.name, ts: typeof value.ts === "number" ? value.ts : 0 };
  if (typeof value.fileId === "string") file.fileId = value.fileId;
  return file;
}

/**
 * Files of the earlier layout, when the bot checked every file: accepted/<doc>/<name> listed per document in
 * status.json. They count as received; a file that held several documents is counted once.
 */
function fromCheckedLayout(docs: unknown): ReceivedFile[] {
  if (!isRecord(docs)) return [];
  const out: ReceivedFile[] = [];
  const seen = new Set<string>();
  for (const [docKey, record] of Object.entries(docs)) {
    if (!isRecord(record) || !Array.isArray(record.files)) continue;
    const fileIds = isRecord(record.fileIds) ? record.fileIds : {};
    for (const saved of record.files) {
      if (typeof saved !== "string" || seen.has(saved)) continue;
      seen.add(saved);
      const fileId = fileIds[saved];
      out.push({
        path: path.join("accepted", docKey, saved),
        name: saved.replace(/^\d{8}-\d{6}_/, ""),
        ts: 0,
        ...(typeof fileId === "string" ? { fileId } : {}),
      });
    }
  }
  return out;
}

function toStatus(value: unknown): ClientStatus | null {
  if (!isRecord(value)) return null;
  const received = Array.isArray(value.received)
    ? value.received.map(toReceived).filter((f): f is ReceivedFile => f !== null)
    : fromCheckedLayout(value.docs);
  const missing = Array.isArray(value.missing)
    ? [...new Set(value.missing.filter((key): key is string => typeof key === "string"))]
    : [];
  return { received, packageSentAt: typeof value.packageSentAt === "number" ? value.packageSentAt : null, missing };
}

/** A file name that is safe on every file system, keeping letters of any script. */
export function safeFileName(name: string): string {
  const base = path.basename(name.replace(/\\/g, "/")).normalize("NFC");
  const cleaned = base.replace(/[^\p{L}\p{N}._ -]+/gu, "_").replace(/^\.+/, "").trim();
  const chars = Array.from(cleaned || "file");
  if (chars.length <= 100) return chars.join("");
  const ext = path.extname(cleaned).slice(0, 10);
  return chars.slice(0, 100 - ext.length).join("") + ext;
}

/** `20261027-170812` in Tashkent time, for file name prefixes. */
function stamp(epochSeconds: number): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tashkent",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(epochSeconds * 1000));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}${get("month")}${get("day")}-${get("hour")}${get("minute")}${get("second")}`;
}

function chatTime(epochSeconds: number): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Asia/Tashkent",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(epochSeconds * 1000));
}

/**
 * One folder per client under data/clients/<userId>/:
 *   chat.txt            the whole conversation as plain text
 *   received/           every file the client sent (not checked)
 *   refused.jsonl       files that could not be taken (too large, download failed)
 *   status.json         the received files, the documents the client does not have, and whether the
 *                       package went to the owner
 * Folders are kept until the owner deletes the chat; HISTORY_TTL_DAYS does not apply to them.
 */
export class ClientFolders {
  constructor(
    readonly root: string,
    private readonly clock: Clock,
  ) {}

  dir(userId: number): string {
    return path.join(this.root, String(Math.trunc(userId)));
  }

  exists(userId: number): boolean {
    return fs.existsSync(this.dir(userId));
  }

  #ensure(userId: number, ...sub: string[]): string {
    ensurePrivateDir(this.root);
    let dir = this.dir(userId);
    ensurePrivateDir(dir);
    for (const part of sub) {
      dir = path.join(dir, part);
      ensurePrivateDir(dir);
    }
    return dir;
  }

  chatFile(userId: number): string {
    return path.join(this.dir(userId), "chat.txt");
  }

  /** Appends one message to chat.txt, continuation lines indented. */
  appendChat(userId: number, who: string, text: string, ts = this.clock()): void {
    this.#ensure(userId);
    const body = text.replace(/\r\n?/g, "\n").split("\n").join("\n    ");
    fs.appendFileSync(this.chatFile(userId), `[${chatTime(ts)}] ${who}: ${body}\n`, { mode: 0o600 });
  }

  chatText(userId: number): string | null {
    try {
      return fs.readFileSync(this.chatFile(userId), "utf8");
    } catch {
      return null;
    }
  }

  #statusFile(userId: number): JsonFile<ClientStatus> {
    return new JsonFile<ClientStatus>(
      path.join(this.dir(userId), "status.json"),
      () => ({ received: [], packageSentAt: null, missing: [] }),
      toStatus,
    );
  }

  status(userId: number): ClientStatus {
    return this.#statusFile(userId).read();
  }

  #update(userId: number, change: (status: ClientStatus) => void): ClientStatus {
    this.#ensure(userId);
    const file = this.#statusFile(userId);
    const status = file.read();
    change(status);
    file.write(status);
    return status;
  }

  /** Copies a file the client sent into received/ and counts it. Returns its number (1-based). */
  receive(userId: number, source: string, originalName: string, fileId?: string): number {
    const dir = this.#ensure(userId, "received");
    let name = `${stamp(this.clock())}_${safeFileName(originalName)}`;
    // Two files with the same name in the same second.
    for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${stamp(this.clock())}-${i}_${safeFileName(originalName)}`;
    const target = path.join(dir, name);
    fs.copyFileSync(source, target);
    fs.chmodSync(target, 0o600);
    let count = 0;
    this.#update(userId, (status) => {
      status.received.push({ path: path.join("received", name), name: originalName, ts: this.clock(), ...(fileId ? { fileId } : {}) });
      count = status.received.length;
    });
    return count;
  }

  /** Remembers a file that could not be taken (too large, download failed), with the reason. */
  refuse(userId: number, originalName: string, reason: string): void {
    this.#ensure(userId);
    appendJsonl(path.join(this.dir(userId), "refused.jsonl"), { ts: this.clock(), original: originalName, reason });
  }

  /** Marks a document as one the client does not have, or unmarks it. Returns the keys marked now. */
  toggleMissing(userId: number, key: string): string[] {
    return this.#update(userId, (status) => {
      status.missing = status.missing.includes(key)
        ? status.missing.filter((k) => k !== key)
        : [...status.missing, key];
    }).missing;
  }

  /** Remembers that the whole package went to the owner. Returns true the first time only. */
  markPackageSent(userId: number): boolean {
    let first = false;
    this.#update(userId, (status) => {
      if (status.packageSentAt !== null) return;
      status.packageSentAt = this.clock();
      first = true;
    });
    return first;
  }

  /** The received files that still exist on disk, numbered in the order the client sent them. */
  receivedFiles(userId: number): PackageFile[] {
    return this.status(userId).received.flatMap((entry, i): PackageFile[] => {
      const file = path.join(this.dir(userId), entry.path);
      if (!fs.existsSync(file)) return [];
      return [{ number: i + 1, file, name: entry.name, ...(entry.fileId ? { fileId: entry.fileId } : {}) }];
    });
  }

  /** Removes the whole client folder. Returns true when there was one. */
  delete(userId: number): boolean {
    const dir = this.dir(userId);
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }
}

const STATUS_WORDS: Record<
  Language,
  {
    title: string;
    received: (n: number, total: number) => string;
    missing: (n: number) => string;
    more: (n: number) => string;
    done: string;
    allMissing: string;
    list: string;
    absent: string;
    hint: string;
  }
> = {
  uz: {
    title: "📊 Hujjatlar holati",
    received: (n, total) => `Qabul qilingan fayllar: ${n}/${total}`,
    missing: (n) => `«Menda yo'q» deb belgilangan: ${n} ta hujjat`,
    more: (n) => `Yana ${n} ta fayl yuboring.`,
    done: "Barcha fayllar qabul qilindi va mutaxassisimizga yuborildi.",
    allMissing: "Barcha hujjatlar «menda yo'q» deb belgilangan.",
    list: "Kerakli hujjatlar (har birini alohida fayl qilib yuboring):",
    absent: "yo'q",
    hint: "Biror hujjat sizda bo'lmasa, «❌ Menda yo'q hujjatlar» tugmasini bosing.",
  },
  ru: {
    title: "📊 Статус документов",
    received: (n, total) => `Получено файлов: ${n}/${total}`,
    missing: (n) => `Отмечено «у меня нет»: ${n}`,
    more: (n) => `Отправьте ещё ${n}.`,
    done: "Все файлы получены и переданы нашему специалисту.",
    allMissing: "Все документы отмечены как отсутствующие.",
    list: "Нужные документы (каждый отдельным файлом):",
    absent: "нет",
    hint: "Если какого-то документа у Вас нет, нажмите «❌ Menda yo'q hujjatlar».",
  },
  en: {
    title: "📊 Document status",
    received: (n, total) => `Files received: ${n}/${total}`,
    missing: (n) => `Marked as "I don't have it": ${n}`,
    more: (n) => `Please send ${n} more.`,
    done: "All files have been received and passed to our specialist.",
    allMissing: "All documents are marked as missing.",
    list: "Documents needed (each as a separate file):",
    absent: "missing",
    hint: "If you do not have a document, press «❌ Menda yo'q hujjatlar».",
  },
};

/**
 * The client-facing status: how many files arrived out of how many are needed, and the list of documents as a
 * reminder (files are not checked, so the list has no ticks). `missing` holds the 0-based positions in `titles` of
 * the documents the client does not have: they are marked ❌ and not counted in `total`.
 */
export function statusText(
  received: number,
  total: number,
  titles: readonly string[],
  language: Language | null,
  { missing = new Set<number>(), hint = false }: { missing?: ReadonlySet<number>; hint?: boolean } = {},
): string {
  const w = STATUS_WORDS[language ?? "uz"];
  const lines = [w.title, w.received(Math.min(received, total), total)];
  if (missing.size > 0) lines.push(w.missing(missing.size));
  lines.push("");
  if (total === 0) {
    lines.push(w.allMissing);
  } else if (received >= total) {
    lines.push(w.done);
  } else {
    lines.push(w.more(total - received));
    if (titles.length > 0) {
      lines.push(
        "",
        w.list,
        ...titles.map((title, i) => (missing.has(i) ? `${i + 1}. ❌ ${title} — ${w.absent}` : `${i + 1}. ${title}`)),
      );
    }
    if (hint) lines.push("", w.hint);
  }
  return lines.join("\n");
}
