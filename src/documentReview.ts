import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ClientFolders } from "./clientFolder.js";
import type { Language } from "./language.js";
import { ensurePrivateDir, isRecord, JsonFile } from "./store.js";

/*
 * The inbox of client files. Files are no longer checked (by Claude or otherwise): they wait here for the batch
 * delay after the last one, are then moved to the client's received/ folder and counted.
 */

/** Where the batch summary goes; kept in the inbox so a batch can resume after a restart. */
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
        };
        if (typeof f.fileId === "string") entry.fileId = f.fileId;
        return [entry];
      })
    : [];
  return { chat: toChat(value.chat), files };
}

/**
 * Files a client sent that wait for the batch, in data/clients/<id>/inbox/. They survive restarts.
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
    const entry: InboxFile = { stored, name, messageId, ts, ...(fileId ? { fileId } : {}) };
    const data = this.read(chat.chatId);
    data.chat = chat;
    data.files.push(entry);
    this.#file(chat.chatId).write(data);
    return entry;
  }

  path(userId: number, file: InboxFile): string {
    return path.join(this.dir(userId), file.stored);
  }

  /** Removes one handled file from the inbox. */
  remove(userId: number, file: InboxFile): void {
    fs.rmSync(this.path(userId, file), { force: true });
    const data = this.read(userId);
    data.files = data.files.filter((f) => f.stored !== file.stored);
    this.#file(userId).write(data);
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
