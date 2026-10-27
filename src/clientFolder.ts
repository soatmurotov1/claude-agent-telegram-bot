import fs from "node:fs";
import path from "node:path";
import type { Language } from "./language.js";
import { appendJsonl, type Clock, ensurePrivateDir, isRecord, JsonFile } from "./store.js";
import type { Template, TemplateDoc, TemplatePart } from "./templates.js";

/** "partial": some parts of the document were accepted, the others have not been sent yet. */
export type DocState = "accepted" | "rejected" | "partial" | "missing" | "na";

export interface PartRecord {
  state: "accepted" | "rejected";
  /** Why the latest file for this part was rejected; empty once it is accepted. */
  reasons: string[];
  ts: number;
}

export interface DocRecord {
  /** Accepted file names under accepted/<doc key>/, oldest first. */
  files: string[];
  parts: Record<string, PartRecord>;
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
  /** When every required document was first accepted (the owner is told once), or null. */
  completedAt: number | null;
}

export interface ProgressItem {
  doc: TemplateDoc;
  state: DocState;
  /** Rejected parts not accepted since, with the reasons. */
  rejectedParts: { part: TemplatePart; reasons: string[] }[];
  /** Required parts not accepted yet. */
  missingParts: TemplatePart[];
}

export interface Progress {
  /** Required documents still needed (not optional, not marked "not applicable"). */
  total: number;
  accepted: number;
  rejected: number;
  /** Not sent yet or only partly sent. */
  missing: number;
  readyPct: number;
  errorPct: number;
  missingPct: number;
  /** Required documents first, then optional ones (the questionnaire). */
  items: ProgressItem[];
}

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

function toStatus(value: unknown): ClientStatus | null {
  if (!isRecord(value)) return null;
  const docs: Record<string, DocRecord> = {};
  if (isRecord(value.docs)) {
    for (const [key, raw] of Object.entries(value.docs)) {
      // Records without parts come from an older template layout and are dropped.
      if (!isRecord(raw) || !isRecord(raw.parts)) continue;
      const parts: Record<string, PartRecord> = {};
      for (const [partKey, part] of Object.entries(raw.parts)) {
        if (!isRecord(part) || (part.state !== "accepted" && part.state !== "rejected")) continue;
        parts[partKey] = { state: part.state, reasons: stringList(part.reasons), ts: typeof part.ts === "number" ? part.ts : 0 };
      }
      docs[key] = { files: stringList(raw.files), parts };
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
  return {
    template: typeof value.template === "string" ? value.template : "",
    applicant,
    docs,
    completedAt: typeof value.completedAt === "number" ? value.completedAt : null,
  };
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
    return new JsonFile<ClientStatus>(
      path.join(this.dir(userId), "status.json"),
      () => ({ template: "", applicant: null, docs: {}, completedAt: null }),
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

  setApplicant(userId: number, templateId: string, applicant: Applicant): void {
    this.#update(userId, (status) => {
      status.template = templateId;
      status.applicant = applicant;
    });
  }

  /**
   * Copies an accepted file to accepted/<docKey>/ and marks the parts it contains accepted. Returns the saved path.
   */
  accept(
    userId: number,
    templateId: string,
    docKey: string,
    partKeys: readonly string[],
    source: string,
    originalName: string,
  ): string {
    const dir = this.#ensure(userId, "accepted", docKey);
    const name = `${stamp(this.clock())}_${safeFileName(originalName)}`;
    const target = path.join(dir, name);
    fs.copyFileSync(source, target);
    fs.chmodSync(target, 0o600);
    this.#update(userId, (status) => {
      status.template = templateId;
      const record = status.docs[docKey] ?? { files: [], parts: {} };
      record.files.push(name);
      for (const part of partKeys) record.parts[part] = { state: "accepted", reasons: [], ts: this.clock() };
      status.docs[docKey] = record;
    });
    return target;
  }

  /** Remembers that every required document has been accepted, once. Returns true the first time. */
  markComplete(userId: number): boolean {
    let first = false;
    this.#update(userId, (status) => {
      if (status.completedAt !== null) return;
      status.completedAt = this.clock();
      first = true;
    });
    return first;
  }

  /**
   * Copies a rejected file to rejected/ with its reasons and marks its parts rejected. A part that was already
   * accepted stays accepted: a later wrong copy does not undo a good one. docKey is null for files that match no
   * listed document.
   */
  reject(
    userId: number,
    templateId: string,
    docKey: string | null,
    partKeys: readonly string[],
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
      parts: partKeys,
      reasons,
    });
    if (docKey === null || partKeys.length === 0) return;
    this.#update(userId, (status) => {
      status.template = templateId;
      const record = status.docs[docKey] ?? { files: [], parts: {} };
      for (const part of partKeys) {
        if (record.parts[part]?.state === "accepted") continue;
        record.parts[part] = { state: "rejected", reasons, ts: this.clock() };
      }
      status.docs[docKey] = record;
    });
  }

  /** Accepted files as absolute paths, grouped by document key. */
  acceptedFiles(userId: number): { docKey: string; file: string }[] {
    const status = this.status(userId);
    const out: { docKey: string; file: string }[] = [];
    for (const [docKey, record] of Object.entries(status.docs)) {
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

/** Whether a part is not needed because the questionnaire marked all its items "not applicable". */
export function isNotApplicable(part: TemplatePart, applicant: Applicant | null): boolean {
  if (!applicant || part.naItems.length === 0) return false;
  return part.naItems.every((item) => applicant.naItems.includes(item));
}

/** The state of one document from the states of its required parts. */
export function docProgress(doc: TemplateDoc, status: ClientStatus): ProgressItem {
  const needed = doc.parts.filter((part) => !isNotApplicable(part, status.applicant));
  if (needed.length === 0) return { doc, state: "na", rejectedParts: [], missingParts: [] };
  const parts = status.docs[doc.key]?.parts ?? {};
  const accepted = needed.filter((part) => parts[part.key]?.state === "accepted");
  const rejectedParts = needed
    .filter((part) => parts[part.key]?.state === "rejected")
    .map((part) => ({ part, reasons: parts[part.key]?.reasons ?? [] }));
  const missingParts = needed.filter((part) => parts[part.key]?.state !== "accepted");
  let state: DocState = "missing";
  if (accepted.length === needed.length) state = "accepted";
  else if (rejectedParts.length > 0) state = "rejected";
  else if (accepted.length > 0) state = "partial";
  return { doc, state, rejectedParts, missingParts };
}

export function progress(status: ClientStatus, template: Template): Progress {
  const required = template.documents.filter((doc) => doc.required).map((doc) => docProgress(doc, status));
  const optional = template.documents.filter((doc) => !doc.required).map((doc) => docProgress(doc, status));
  const count = (...states: DocState[]): number => required.filter((item) => states.includes(item.state)).length;
  const accepted = count("accepted");
  const rejected = count("rejected");
  const missing = count("missing", "partial");
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
    items: [...required, ...optional],
  };
}

const PROGRESS_WORDS: Record<
  Language,
  {
    title: string;
    ready: string;
    errors: string;
    missing: string;
    na: string;
    stillMissing: string;
    optional: string;
    fix: string;
    next: string;
    done: string;
  }
> = {
  uz: {
    title: "📊 Hujjatlar holati",
    ready: "Tayyor",
    errors: "Xato",
    missing: "Yetishmaydi",
    na: "kerak emas",
    stillMissing: "yetishmaydi",
    optional: "ixtiyoriy",
    fix: "Xato hujjatlarni tuzatib, qayta yuboring.",
    next: "Qolgan hujjatlarni shu chatga fayl qilib yuboring.",
    done: "Barcha hujjatlar qabul qilindi va mutaxassisimizga yuborildi.",
  },
  ru: {
    title: "📊 Статус документов",
    ready: "Готово",
    errors: "С ошибками",
    missing: "Не хватает",
    na: "не требуется",
    stillMissing: "не хватает",
    optional: "по желанию",
    fix: "Исправьте документы с ошибками и отправьте их ещё раз.",
    next: "Остальные документы отправьте файлами в этот чат.",
    done: "Все документы приняты и переданы нашему специалисту.",
  },
  en: {
    title: "📊 Document status",
    ready: "Ready",
    errors: "With errors",
    missing: "Missing",
    na: "not needed",
    stillMissing: "missing",
    optional: "optional",
    fix: "Please correct the documents with errors and send them again.",
    next: "Please send the remaining documents as files in this chat.",
    done: "All documents have been accepted and passed to our specialist.",
  },
};

/** The client-facing progress message: percentages and one numbered line per required document. */
export function progressText(p: Progress, language: Language | null): string {
  const lang = language ?? "uz";
  const w = PROGRESS_WORDS[lang];
  const lines = [
    w.title,
    `${w.ready}: ${p.readyPct}% (${p.accepted}/${p.total}) · ${w.errors}: ${p.errorPct}% (${p.rejected}) · ` +
      `${w.missing}: ${p.missingPct}% (${p.missing})`,
    "",
  ];
  let n = 0;
  for (const item of p.items) {
    const title = item.doc.required ? `${++n}. ${item.doc.title[lang]}` : `${item.doc.title[lang]} (${w.optional})`;
    const several = item.doc.parts.length > 1;
    const reasons = item.rejectedParts.flatMap(({ part, reasons: list }) =>
      several ? list.map((reason) => `${part.title[lang]}: ${reason}`) : list,
    );
    const missing = item.missingParts.filter((part) => !item.rejectedParts.some((r) => r.part.key === part.key));
    const missingText = several && missing.length ? ` — ${w.stillMissing}: ${missing.map((part) => part.title[lang]).join(", ")}` : "";
    if (item.state === "accepted") lines.push(`✅ ${title}`);
    else if (item.state === "na") lines.push(`➖ ${title} (${w.na})`);
    else if (item.state === "missing") lines.push(`⬜ ${title}`);
    else if (item.state === "partial") lines.push(`🟡 ${title}${missingText}`);
    else lines.push(`❌ ${title}${reasons.length ? `: ${reasons.join("; ")}` : ""}${missingText}`);
  }
  lines.push("");
  if (p.total > 0 && p.accepted === p.total) lines.push(w.done);
  else {
    if (p.rejected > 0) lines.push(w.fix);
    if (p.missing > 0) lines.push(w.next);
  }
  return lines.join("\n").trim();
}
