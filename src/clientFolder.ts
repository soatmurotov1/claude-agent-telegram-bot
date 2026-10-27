import fs from "node:fs";
import path from "node:path";
import type { Language } from "./language.js";
import { appendJsonl, type Clock, ensurePrivateDir, isRecord, JsonFile } from "./store.js";
import type { Template, TemplateDoc } from "./templates.js";

export type DocState = "accepted" | "rejected" | "missing" | "na";

export interface DocRecord {
  state: "accepted" | "rejected";
  /** Saved file names under accepted/<key>/ (accepted) or rejected/ (rejected), newest last. */
  files: string[];
  /** Why the latest file was rejected; empty once the document is accepted. */
  reasons: string[];
  ts: number;
}

/** What the accepted questionnaire said about the client, used to check the other documents. */
export interface Applicant {
  company: string;
  direction: string;
  /** Questionnaire items (1-10) marked "not applicable". */
  naItems: number[];
}

export interface ClientStatus {
  template: string;
  applicant: Applicant | null;
  docs: Record<string, DocRecord>;
}

export interface ProgressItem {
  doc: TemplateDoc;
  state: DocState;
  reasons: string[];
}

export interface Progress {
  /** Documents still required (not marked "not applicable"). */
  total: number;
  accepted: number;
  rejected: number;
  missing: number;
  readyPct: number;
  errorPct: number;
  missingPct: number;
  items: ProgressItem[];
}

function toStatus(value: unknown): ClientStatus | null {
  if (!isRecord(value)) return null;
  const docs: Record<string, DocRecord> = {};
  if (isRecord(value.docs)) {
    for (const [key, raw] of Object.entries(value.docs)) {
      if (!isRecord(raw) || (raw.state !== "accepted" && raw.state !== "rejected")) continue;
      docs[key] = {
        state: raw.state,
        files: Array.isArray(raw.files) ? raw.files.filter((f): f is string => typeof f === "string") : [],
        reasons: Array.isArray(raw.reasons) ? raw.reasons.filter((r): r is string => typeof r === "string") : [],
        ts: typeof raw.ts === "number" ? raw.ts : 0,
      };
    }
  }
  let applicant: Applicant | null = null;
  if (isRecord(value.applicant)) {
    const { company, direction, naItems } = value.applicant;
    applicant = {
      company: typeof company === "string" ? company : "",
      direction: typeof direction === "string" ? direction : "",
      naItems: Array.isArray(naItems) ? naItems.filter((n): n is number => Number.isInteger(n)) : [],
    };
  }
  return { template: typeof value.template === "string" ? value.template : "", applicant, docs };
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
 *   accepted/<doc>/     files that passed the template check
 *   rejected/           files that did not, with rejected/reasons.jsonl
 *   status.json         per-document state for the progress figures
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
    return new JsonFile(path.join(this.dir(userId), "status.json"), () => ({ template: "", applicant: null, docs: {} }), toStatus);
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

  setApplicant(userId: number, templateId: string, applicant: Applicant): void {
    this.#update(userId, (status) => {
      status.template = templateId;
      status.applicant = applicant;
    });
  }

  /** Copies an accepted file to accepted/<docKey>/ and marks the document accepted. Returns the saved path. */
  accept(userId: number, templateId: string, docKey: string, source: string, originalName: string): string {
    const dir = this.#ensure(userId, "accepted", docKey);
    const name = `${stamp(this.clock())}_${safeFileName(originalName)}`;
    const target = path.join(dir, name);
    fs.copyFileSync(source, target);
    fs.chmodSync(target, 0o600);
    this.#update(userId, (status) => {
      status.template = templateId;
      const known = status.docs[docKey];
      const files = known?.state === "accepted" ? [...known.files, name] : [name];
      status.docs[docKey] = { state: "accepted", files, reasons: [], ts: this.clock() };
    });
    return target;
  }

  /**
   * Copies a rejected file to rejected/ with its reasons. A document that was already accepted stays accepted:
   * a later wrong copy does not undo a good one. docKey is null for files that match no listed document.
   */
  reject(
    userId: number,
    templateId: string,
    docKey: string | null,
    source: string | null,
    originalName: string,
    reasons: string[],
  ): void {
    const dir = this.#ensure(userId, "rejected");
    const name = `${stamp(this.clock())}_${safeFileName(originalName)}`;
    if (source) {
      const target = path.join(dir, name);
      fs.copyFileSync(source, target);
      fs.chmodSync(target, 0o600);
    }
    appendJsonl(path.join(dir, "reasons.jsonl"), {
      ts: this.clock(),
      file: source ? name : null,
      original: originalName,
      doc: docKey,
      reasons,
    });
    if (docKey === null) return;
    this.#update(userId, (status) => {
      status.template = templateId;
      const known = status.docs[docKey];
      if (known?.state === "accepted") return;
      status.docs[docKey] = { state: "rejected", files: [...(known?.files ?? []), name], reasons, ts: this.clock() };
    });
  }

  /** Accepted files as absolute paths, grouped by document key in template order. */
  acceptedFiles(userId: number): { docKey: string; file: string }[] {
    const status = this.status(userId);
    const out: { docKey: string; file: string }[] = [];
    for (const [docKey, record] of Object.entries(status.docs)) {
      if (record.state !== "accepted") continue;
      for (const name of record.files) {
        const file = path.join(this.dir(userId), "accepted", docKey, name);
        if (fs.existsSync(file)) out.push({ docKey, file });
      }
    }
    return out;
  }

  /** Removes the whole client folder. Returns true when there was one. */
  delete(userId: number): boolean {
    const dir = this.dir(userId);
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }
}

/** Whether a document is not needed because the questionnaire marked all its items "not applicable". */
export function isNotApplicable(doc: TemplateDoc, applicant: Applicant | null): boolean {
  if (!applicant || doc.naItems.length === 0) return false;
  return doc.naItems.every((item) => applicant.naItems.includes(item));
}

export function progress(status: ClientStatus, template: Template): Progress {
  const items = template.documents.map((doc): ProgressItem => {
    if (isNotApplicable(doc, status.applicant)) return { doc, state: "na", reasons: [] };
    const record = status.docs[doc.key];
    if (!record) return { doc, state: "missing", reasons: [] };
    return { doc, state: record.state, reasons: record.reasons };
  });
  const count = (state: DocState): number => items.filter((item) => item.state === state).length;
  const accepted = count("accepted");
  const rejected = count("rejected");
  const missing = count("missing");
  const total = accepted + rejected + missing;
  const readyPct = total === 0 ? 100 : Math.round((accepted / total) * 100);
  const errorPct = total === 0 ? 0 : Math.round((rejected / total) * 100);
  return {
    total,
    accepted,
    rejected,
    missing,
    readyPct,
    errorPct,
    missingPct: Math.max(0, 100 - readyPct - errorPct),
    items,
  };
}

const PROGRESS_WORDS: Record<
  Language,
  { title: string; ready: string; errors: string; missing: string; na: string; fix: string; next: string; done: string }
> = {
  uz: {
    title: "📊 Hujjatlar holati",
    ready: "Tayyor",
    errors: "Xato",
    missing: "Yetishmaydi",
    na: "kerak emas",
    fix: "Xato hujjatlarni tuzatib, qayta yuboring.",
    next: "Qolgan hujjatlarni shu chatga fayl qilib yuboring.",
    done: "Barcha hujjatlar qabul qilindi.",
  },
  ru: {
    title: "📊 Статус документов",
    ready: "Готово",
    errors: "С ошибками",
    missing: "Не хватает",
    na: "не требуется",
    fix: "Исправьте документы с ошибками и отправьте их ещё раз.",
    next: "Остальные документы отправьте файлами в этот чат.",
    done: "Все документы приняты.",
  },
  en: {
    title: "📊 Document status",
    ready: "Ready",
    errors: "With errors",
    missing: "Missing",
    na: "not needed",
    fix: "Please correct the documents with errors and send them again.",
    next: "Please send the remaining documents as files in this chat.",
    done: "All documents have been accepted.",
  },
};

/** The client-facing progress message: percentages and one line per document. */
export function progressText(p: Progress, language: Language | null): string {
  const lang = language ?? "uz";
  const w = PROGRESS_WORDS[lang];
  const lines = [
    w.title,
    `${w.ready}: ${p.readyPct}% (${p.accepted}/${p.total}) · ${w.errors}: ${p.errorPct}% (${p.rejected}) · ` +
      `${w.missing}: ${p.missingPct}% (${p.missing})`,
    "",
  ];
  for (const item of p.items) {
    const title = item.doc.title[lang];
    if (item.state === "accepted") lines.push(`✅ ${title}`);
    else if (item.state === "na") lines.push(`➖ ${title} (${w.na})`);
    else if (item.state === "missing") lines.push(`⬜ ${title}`);
    else lines.push(`❌ ${title}${item.reasons.length ? `: ${item.reasons.join("; ")}` : ""}`);
  }
  lines.push("");
  if (p.total > 0 && p.accepted === p.total) lines.push(w.done);
  else {
    if (p.rejected > 0) lines.push(w.fix);
    if (p.missing > 0) lines.push(w.next);
  }
  return lines.join("\n").trim();
}
