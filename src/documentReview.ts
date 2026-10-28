import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import type { Applicant, ClientFolders } from "./clientFolder.js";
import type { Language } from "./language.js";
import { buildReviewSystemPrompt, buildReviewUserPrompt } from "./prompts.js";
import { ensurePrivateDir, isRecord, JsonFile } from "./store.js";
import type { Template, TemplateDoc, TemplatePart } from "./templates.js";

/** Extracted text sent to Claude is cut at this many characters. */
const MAX_TEXT_CHARS = 60_000;
/** Laws summaries added to the review prompt are cut at this many characters. */
const MAX_LAWS_CHARS = 40_000;

/** How a file is checked: its text is extracted here, Claude opens it itself, or it cannot be checked. */
export type FileKind = "docx" | "xlsx" | "text" | "pdf" | "image" | "unsupported";

const KIND_BY_EXT: Record<string, FileKind> = {
  ".docx": "docx",
  ".docm": "docx",
  ".xlsx": "xlsx",
  ".xlsm": "xlsx",
  ".txt": "text",
  ".csv": "text",
  ".md": "text",
  ".pdf": "pdf",
  ".jpg": "image",
  ".jpeg": "image",
  ".png": "image",
  ".webp": "image",
  ".gif": "image",
};

export function fileKind(name: string): FileKind {
  return KIND_BY_EXT[path.extname(name).toLowerCase()] ?? "unsupported";
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, "&");
}

/** Symbol-font characters Word uses for ticked and empty boxes. */
const CHECKED_SYMBOLS = new Set(["F0FE", "F0FD", "F0FB", "F0FC", "F078", "F0D6", "F052"]);
const EMPTY_SYMBOLS = new Set(["F0A8", "F06F", "F071", "F0A3"]);

function runText(run: string): string {
  let text = "";
  const parts = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>|<w:cr\/>|<w:sym\s[^>]*w:char="([0-9A-Fa-f]+)"[^>]*\/>/g;
  for (const m of run.matchAll(parts)) {
    if (m[1] !== undefined) text += decodeXml(m[1]);
    else if (m[2] !== undefined) {
      const code = m[2].toUpperCase();
      text += CHECKED_SYMBOLS.has(code) ? "☒" : EMPTY_SYMBOLS.has(code) ? "☐" : "";
    } else if (m[0] === "<w:tab/>") text += "\t";
    else text += "\n";
  }
  // Text the client highlighted or shaded is often how they mark an option.
  const rPr = /<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(run)?.[1] ?? "";
  const highlighted =
    /<w:highlight\s+w:val="(?!none)[^"]+"/.test(rPr) || /<w:shd\s[^>]*w:fill="(?!auto|FFFFFF|ffffff)[0-9A-Fa-f]{6}"/.test(rPr);
  return highlighted && text.trim() ? `⟦${text}⟧` : text;
}

/** Plain text of a Word document: paragraphs on lines, table cells separated by " | ", checkbox states kept. */
export async function docxText(data: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(data);
  const xml = await zip.file("word/document.xml")?.async("string");
  if (xml === undefined) throw new Error("not a Word document (word/document.xml is missing)");
  let out = "";
  const tokens =
    /<w:r[ >][\s\S]*?<\/w:r>|<\/w:p>|<\/w:tc>|<w:checkBox\b[\s\S]*?(?:<\/w:checkBox>|\/>)|<w14:checked\s+w14:val="([01])"\s*\/>/g;
  let pendingSdtCheck: string | null = null;
  for (const m of xml.matchAll(tokens)) {
    const token = m[0];
    if (token === "</w:p>") out += "\n";
    else if (token === "</w:tc>") out += " | ";
    else if (token.startsWith("<w:checkBox")) {
      // Legacy form field: ticked when <w:checked/> or <w:default w:val="1"/> is set.
      const ticked = /<w:checked(?:\s+w:val="(?:1|true)")?\s*\/>/.test(token) || /<w:default\s+w:val="(?:1|true)"/.test(token);
      out += ticked ? "☒" : "☐";
    } else if (token.startsWith("<w14:checked")) {
      pendingSdtCheck = m[1] === "1" ? "☒" : "☐";
    } else {
      let text = runText(token);
      // A content-control checkbox shows its own glyph; make sure the state is the one Word stored.
      if (pendingSdtCheck !== null && /[☐☒☑✓✔x]/i.test(text)) {
        text = text.replace(/[☐☒☑✓✔]/, pendingSdtCheck);
        pendingSdtCheck = null;
      }
      out += text;
    }
  }
  return out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/(\s*\|\s*)+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Plain text of an Excel workbook: one line per row, cells separated by " | ". */
export async function xlsxText(data: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(data);
  const shared: string[] = [];
  const sharedXml = await zip.file("xl/sharedStrings.xml")?.async("string");
  if (sharedXml) {
    for (const si of sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      const body = si[1] ?? "";
      shared.push([...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1] ?? "")).join(""));
    }
  }
  const sheets = Object.keys(zip.files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1]) - Number(/(\d+)\.xml$/.exec(b)?.[1]));
  if (sheets.length === 0) throw new Error("not an Excel workbook (no worksheets)");
  const out: string[] = [];
  for (const [i, name] of sheets.entries()) {
    const xml = (await zip.file(name)?.async("string")) ?? "";
    out.push(`--- Sheet ${i + 1} ---`);
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const cell of (row[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cell[1] ?? "";
        const body = cell[2] ?? "";
        const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        const inline = /<is>([\s\S]*?)<\/is>/.exec(body)?.[1];
        let text = "";
        if (/\bt="s"/.test(attrs) && value !== undefined) text = shared[Number(value)] ?? "";
        else if (inline !== undefined) text = [...inline.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1] ?? "")).join("");
        else if (value !== undefined) text = decodeXml(value);
        if (text.trim()) cells.push(text.trim());
      }
      if (cells.length > 0) out.push(cells.join(" | "));
    }
  }
  return out.join("\n");
}

/** Text Claude gets for a file, or null when Claude should open the file itself (PDF, images). */
export async function extractText(file: string, kind: FileKind): Promise<string | null> {
  if (kind === "pdf" || kind === "image" || kind === "unsupported") return null;
  const data = await fs.promises.readFile(file);
  let text: string;
  if (kind === "docx") text = await docxText(data);
  else if (kind === "xlsx") text = await xlsxText(data);
  else text = data.toString("utf8");
  if (text.length > MAX_TEXT_CHARS) text = `${text.slice(0, MAX_TEXT_CHARS)}\n[... the rest of the file was cut off ...]`;
  return text;
}

/** All laws/*.md files with their <!-- comments --> removed, for the review prompt. */
export function readLaws(dir: string): string {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".md") && name.toLowerCase() !== "readme.md").sort();
  } catch {
    return "";
  }
  const text = names
    .map((name) => {
      try {
        return fs.readFileSync(path.join(dir, name), "utf8").replace(/<!--[\s\S]*?-->/g, "").trim();
      } catch {
        return "";
      }
    })
    .filter(Boolean)
    .join("\n\n");
  return text.length > MAX_LAWS_CHARS ? text.slice(0, MAX_LAWS_CHARS) : text;
}

export interface ReviewAnswer {
  doc: string | null;
  /** Part keys of `doc` the file contains; never empty when doc is set. */
  parts: string[];
  verdict: "accepted" | "rejected";
  reasons: string[];
  summary: string;
  applicant: Applicant | null;
}

export class ReviewParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewParseError";
  }
}

/** Reads Claude's JSON verdict. Unknown document keys become null; anything malformed throws ReviewParseError. */
export function parseReview(raw: string, template: Template): ReviewAnswer {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) throw new ReviewParseError("the answer has no JSON object");
  let data: unknown;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new ReviewParseError("the answer is not valid JSON");
  }
  if (!isRecord(data)) throw new ReviewParseError("the answer is not a JSON object");
  if (data.verdict !== "accepted" && data.verdict !== "rejected") throw new ReviewParseError("verdict is missing");
  // Claude sometimes names a part ("egrpo") where the document ("ustav_egrpo") is asked for.
  const named = typeof data.doc === "string" ? data.doc : "";
  const found =
    template.documents.find((d) => d.key === named) ??
    template.documents.find((d) => d.parts.some((part) => part.key === named)) ??
    null;
  const doc = found?.key ?? null;
  const partKeys = new Set(found?.parts.map((part) => part.key) ?? []);
  let parts = Array.isArray(data.parts)
    ? [...new Set(data.parts.filter((p): p is string => typeof p === "string" && partKeys.has(p)))]
    : [];
  if (found && parts.length === 0) parts = partKeys.has(named) ? [named] : [...partKeys];
  const reasons = Array.isArray(data.reasons)
    ? data.reasons.filter((r): r is string => typeof r === "string" && r.trim() !== "").map((r) => r.trim()).slice(0, 5)
    : [];
  let applicant: Applicant | null = null;
  if (doc === "anketa" && isRecord(data.applicant)) {
    const { company, direction, na_items: naItems } = data.applicant;
    applicant = {
      company: typeof company === "string" ? company.trim() : "",
      direction: typeof direction === "string" ? direction.trim() : "",
      naItems: Array.isArray(naItems) ? naItems.filter((n): n is number => Number.isInteger(n) && n >= 1 && n <= 10) : [],
    };
  }
  // A file that is none of the listed documents can never be accepted.
  const verdict = doc === null ? "rejected" : data.verdict;
  return {
    doc,
    parts,
    verdict,
    reasons,
    summary: typeof data.summary === "string" ? data.summary.trim() : "",
    applicant,
  };
}

export interface ReviewGenerator {
  generate(system: string, user: string): Promise<string>;
  /** Like generate, but Claude runs in `dir` and may read the files there. */
  review?(system: string, user: string, dir: string): Promise<string>;
}

/** Where a review summary goes; kept in the inbox so a review can resume after a restart or a usage limit. */
export interface ReviewChat {
  target: { kind: "business"; connectionId: string } | { kind: "direct" };
  chatId: number;
  chatName: string;
  language: Language | null;
  threadId?: number;
}

export interface InboxFile {
  /** File name inside the inbox folder. */
  stored: string;
  /** Name the client gave the file. */
  name: string;
  messageId: number;
  ts: number;
  /** Telegram file_id, so the file can be passed on without uploading it again (any size). */
  fileId?: string;
  /** Checks that failed for reasons unrelated to the file (CLI error, unreadable answer). */
  attempts: number;
}

interface InboxData {
  chat: ReviewChat | null;
  files: InboxFile[];
}

function toChat(value: unknown): ReviewChat | null {
  if (!isRecord(value) || typeof value.chatId !== "number" || !isRecord(value.target)) return null;
  const target = value.target;
  const lang = value.language;
  const chat: ReviewChat = {
    target:
      target.kind === "business" && typeof target.connectionId === "string"
        ? { kind: "business", connectionId: target.connectionId }
        : { kind: "direct" },
    chatId: value.chatId,
    chatName: typeof value.chatName === "string" ? value.chatName : String(value.chatId),
    language: lang === "uz" || lang === "ru" || lang === "en" ? lang : null,
  };
  if (typeof value.threadId === "number") chat.threadId = value.threadId;
  return chat;
}

function toInbox(value: unknown): InboxData | null {
  if (!isRecord(value)) return null;
  const files = Array.isArray(value.files)
    ? value.files.flatMap((f): InboxFile[] => {
        if (!isRecord(f) || typeof f.stored !== "string" || typeof f.name !== "string") return [];
        const entry: InboxFile = {
          stored: f.stored,
          name: f.name,
          messageId: typeof f.messageId === "number" ? f.messageId : 0,
          ts: typeof f.ts === "number" ? f.ts : 0,
          attempts: typeof f.attempts === "number" ? f.attempts : 0,
        };
        if (typeof f.fileId === "string") entry.fileId = f.fileId;
        return [entry];
      })
    : [];
  return { chat: toChat(value.chat), files };
}

export type FileVerdict =
  | { kind: "accepted"; file: InboxFile; doc: TemplateDoc; parts: TemplatePart[]; summary: string; applicant: Applicant | null }
  | { kind: "rejected"; file: InboxFile; doc: TemplateDoc | null; parts: TemplatePart[]; reasons: string[]; summary: string }
  | { kind: "unchecked"; file: InboxFile; reason: string };

/**
 * Files a client sent that wait for review, in data/clients/<id>/inbox/. They survive restarts, and a batch that
 * stops at a usage limit resumes from here.
 */
export class Inbox {
  constructor(private readonly folders: ClientFolders) {}

  dir(userId: number): string {
    return path.join(this.folders.dir(userId), "inbox");
  }

  #file(userId: number): JsonFile<InboxData> {
    return new JsonFile(path.join(this.dir(userId), "inbox.json"), () => ({ chat: null, files: [] }), toInbox);
  }

  read(userId: number): InboxData {
    return this.#file(userId).read();
  }

  /** Moves a downloaded file into the inbox and remembers where to answer. */
  add(chat: ReviewChat, source: string, name: string, messageId: number, ts: number, fileId?: string): InboxFile {
    ensurePrivateDir(this.folders.root);
    ensurePrivateDir(this.folders.dir(chat.chatId));
    const dir = this.dir(chat.chatId);
    ensurePrivateDir(dir);
    const ext = path.extname(name).toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 10);
    const stored = `${crypto.randomBytes(8).toString("hex")}${ext}`;
    fs.renameSync(source, path.join(dir, stored));
    const entry: InboxFile = { stored, name, messageId, ts, attempts: 0, ...(fileId ? { fileId } : {}) };
    const data = this.read(chat.chatId);
    data.chat = chat;
    data.files.push(entry);
    this.#file(chat.chatId).write(data);
    return entry;
  }

  path(userId: number, file: InboxFile): string {
    return path.join(this.dir(userId), file.stored);
  }

  /** Removes one reviewed file from the inbox. */
  remove(userId: number, file: InboxFile): void {
    fs.rmSync(this.path(userId, file), { force: true });
    const data = this.read(userId);
    data.files = data.files.filter((f) => f.stored !== file.stored);
    this.#file(userId).write(data);
  }

  /** Keeps a file whose check failed for another reason for a later attempt. Returns the attempts so far. */
  retryLater(userId: number, file: InboxFile): number {
    const data = this.read(userId);
    const entry = data.files.find((f) => f.stored === file.stored);
    if (!entry) return file.attempts + 1;
    entry.attempts += 1;
    this.#file(userId).write(data);
    return entry.attempts;
  }

  /** Clients (user IDs) with files still waiting. */
  pending(): number[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.folders.root);
    } catch {
      return [];
    }
    return names
      .filter((name) => /^\d+$/.test(name))
      .map(Number)
      .filter((id) => this.read(id).files.length > 0);
  }
}

/**
 * Checks one inbox file against the template. Claude errors (usage limit, timeout...) are thrown so the caller
 * can stop the batch; anything that only concerns this file becomes "unchecked".
 */
export async function reviewFile(opts: {
  generator: ReviewGenerator;
  companyName: string;
  template: Template;
  laws: string;
  folders: ClientFolders;
  inbox: Inbox;
  userId: number;
  file: InboxFile;
  language: Language;
  workdir: string;
  now: Date;
}): Promise<FileVerdict> {
  const { generator, template, folders, inbox, userId, file, language } = opts;
  const source = inbox.path(userId, file);
  const kind = fileKind(file.name);
  if (kind === "unsupported") {
    return { kind: "rejected", file, doc: null, parts: [], reasons: [UNSUPPORTED_REASON[language]], summary: "" };
  }

  let text: string | null;
  try {
    text = await extractText(source, kind);
  } catch (err) {
    return {
      kind: "rejected",
      file,
      doc: null,
      parts: [],
      reasons: [UNREADABLE_REASON[language]],
      summary: err instanceof Error ? err.message : "",
    };
  }

  const status = folders.status(userId);
  const accepted = Object.values(status.docs).flatMap((record) =>
    Object.entries(record.parts)
      .filter(([, part]) => part.state === "accepted")
      .map(([key]) => key),
  );
  const system = buildReviewSystemPrompt(opts.companyName, template, opts.laws, opts.now);

  let raw: string;
  if (text !== null) {
    raw = await generator.generate(
      system,
      buildReviewUserPrompt({ name: file.name, text, workName: null }, { company: status.applicant?.company ?? "", accepted }, language),
    );
  } else {
    if (!generator.review) return { kind: "unchecked", file, reason: "this generator cannot open files" };
    // Claude gets a fresh folder holding only this file, under an ASCII name.
    ensurePrivateDir(opts.workdir);
    const dir = path.join(opts.workdir, `review-${crypto.randomBytes(8).toString("hex")}`);
    ensurePrivateDir(dir);
    const workName = `document${path.extname(file.stored)}`;
    try {
      fs.copyFileSync(source, path.join(dir, workName));
      raw = await generator.review(
        system,
        buildReviewUserPrompt({ name: file.name, text: null, workName }, { company: status.applicant?.company ?? "", accepted }, language),
        dir,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  let answer: ReviewAnswer;
  try {
    answer = parseReview(raw, template);
  } catch (err) {
    return { kind: "unchecked", file, reason: err instanceof Error ? err.message : String(err) };
  }
  const doc = answer.doc === null ? null : (template.documents.find((d) => d.key === answer.doc) ?? null);
  const parts = doc ? doc.parts.filter((part) => answer.parts.includes(part.key)) : [];
  if (doc && answer.verdict === "accepted") {
    return { kind: "accepted", file, doc, parts, summary: answer.summary, applicant: answer.applicant };
  }
  const reasons = answer.reasons.length > 0 ? answer.reasons : doc === null ? [NOT_LISTED_REASON[language]] : [];
  return { kind: "rejected", file, doc, parts, reasons, summary: answer.summary };
}

const UNSUPPORTED_REASON: Record<Language, string> = {
  uz: "bu formatdagi faylni tekshirib bo'lmaydi: PDF, DOCX, XLSX yoki JPG/PNG yuboring",
  ru: "файл в этом формате нельзя проверить: отправьте PDF, DOCX, XLSX или JPG/PNG",
  en: "files in this format cannot be checked: please send PDF, DOCX, XLSX or JPG/PNG",
};

const UNREADABLE_REASON: Record<Language, string> = {
  uz: "fayl ochilmadi (buzilgan yoki parol bilan himoyalangan bo'lishi mumkin)",
  ru: "файл не открывается (возможно, повреждён или защищён паролем)",
  en: "the file could not be opened (it may be damaged or password-protected)",
};

const NOT_LISTED_REASON: Record<Language, string> = {
  uz: "bu hujjat talab qilinadigan hujjatlar ro'yxatida yo'q",
  ru: "этого документа нет в списке требуемых",
  en: "this document is not on the list of required documents",
};
