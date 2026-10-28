import fs from "node:fs";
import bigInt from "big-integer";
import { Api, TelegramClient } from "telegram";
import { Logger, LogLevel } from "telegram/extensions/Logger.js";
import { StringSession } from "telegram/sessions/index.js";
import { writeFileAtomic } from "./store.js";

/**
 * The Bot API lets bots download files of at most 20 MB. Larger files are downloaded over MTProto (the protocol
 * Telegram's own apps use) with the same bot token, which allows up to 2 GB. This needs an api_id and api_hash
 * from my.telegram.org (TELEGRAM_API_ID, TELEGRAM_API_HASH).
 */
export const BOT_API_DOWNLOAD_LIMIT = 20 * 1024 * 1024;

const WEB_LOCATION_FLAG = 1 << 24;
const FILE_REFERENCE_FLAG = 1 << 25;
/** Bot API file types that are photos (they have no document id and are never larger than 20 MB anyway). */
const PHOTO_TYPES = new Set([0, 1, 2]);

export interface DocumentLocation {
  fileType: number;
  dcId: number;
  id: bigint;
  accessHash: bigint;
  fileReference: Buffer;
}

export class FileIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileIdError";
  }
}

/** Telegram's file_id compression: a zero byte followed by a count stands for that many zero bytes. */
function rleDecode(data: Buffer): Buffer {
  const out: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const byte = data[i] ?? 0;
    if (byte === 0) {
      out.push(...new Array<number>(data[i + 1] ?? 0).fill(0));
      i++;
    } else {
      out.push(byte);
    }
  }
  return Buffer.from(out);
}

export function rleEncode(data: Buffer): Buffer {
  const out: number[] = [];
  let zeros = 0;
  for (const byte of data) {
    if (byte === 0) {
      zeros++;
      if (zeros === 255) {
        out.push(0, zeros);
        zeros = 0;
      }
      continue;
    }
    if (zeros > 0) out.push(0, zeros);
    zeros = 0;
    out.push(byte);
  }
  if (zeros > 0) out.push(0, zeros);
  return Buffer.from(out);
}

/** Reads a TL "bytes" value: a 1-byte length (or 254 + 3-byte length), the data, padding to 4 bytes. */
function readTlBytes(buf: Buffer, offset: number): [Buffer, number] {
  let length = buf[offset] ?? 0;
  let start = offset + 1;
  if (length === 254) {
    length = buf.readUIntLE(offset + 1, 3);
    start = offset + 4;
  }
  const end = start + length;
  if (end > buf.length) throw new FileIdError("file_id is cut off");
  const padded = offset + Math.ceil((end - offset) / 4) * 4;
  return [buf.subarray(start, end), padded];
}

/** Decodes a Bot API file_id of a document (the layout Telegram's TDLib and Pyrogram use). */
export function decodeFileId(fileId: string): DocumentLocation {
  const data = rleDecode(Buffer.from(fileId, "base64url"));
  if (data.length < 20) throw new FileIdError("file_id is too short");
  const major = data[data.length - 1] ?? 0;
  const body = major < 4 ? data.subarray(0, -1) : data.subarray(0, -2);
  let fileType = body.readInt32LE(0);
  const dcId = body.readInt32LE(4);
  let offset = 8;
  if (fileType & WEB_LOCATION_FLAG) throw new FileIdError("file_id points to a web file");
  const hasReference = (fileType & FILE_REFERENCE_FLAG) !== 0;
  fileType &= ~(WEB_LOCATION_FLAG | FILE_REFERENCE_FLAG);
  if (PHOTO_TYPES.has(fileType)) throw new FileIdError("file_id is a photo, not a document");
  let fileReference: Buffer = Buffer.alloc(0);
  if (hasReference) [fileReference, offset] = readTlBytes(body, offset);
  if (offset + 16 > body.length) throw new FileIdError("file_id is cut off");
  return {
    fileType,
    dcId,
    id: body.readBigInt64LE(offset),
    accessHash: body.readBigInt64LE(offset + 8),
    fileReference: Buffer.from(fileReference),
  };
}

/** The inverse of decodeFileId, for tests. */
export function encodeFileId(location: DocumentLocation): string {
  const head = Buffer.alloc(8);
  head.writeInt32LE(location.fileType | (location.fileReference.length ? FILE_REFERENCE_FLAG : 0), 0);
  head.writeInt32LE(location.dcId, 4);
  const parts: Buffer[] = [head];
  if (location.fileReference.length) {
    const ref = location.fileReference;
    const prefix = ref.length < 254 ? Buffer.from([ref.length]) : Buffer.from([254, ref.length & 255, (ref.length >> 8) & 255, ref.length >> 16]);
    const used = prefix.length + ref.length;
    parts.push(prefix, ref, Buffer.alloc((4 - (used % 4)) % 4));
  }
  const ids = Buffer.alloc(16);
  ids.writeBigInt64LE(location.id, 0);
  ids.writeBigInt64LE(location.accessHash, 8);
  parts.push(ids, Buffer.from([30, 4]));
  return rleEncode(Buffer.concat(parts)).toString("base64url");
}

export interface MtprotoOptions {
  apiId: number;
  apiHash: string;
  botToken: string;
  /** Where the MTProto session (an auth key: keep it private) is kept between restarts. */
  sessionFile: string;
}

/**
 * Downloads documents over MTProto. It connects only for a download and disconnects right afterwards, so the bot
 * keeps receiving its updates through the Bot API as usual.
 */
export class MtprotoDownloader {
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: MtprotoOptions) {}

  async #withClient<T>(fn: (client: TelegramClient) => Promise<T>): Promise<T> {
    // One connection at a time: parallel logins with one bot token would only compete.
    const run = this.#queue.then(async () => {
      let saved = "";
      try {
        saved = fs.readFileSync(this.opts.sessionFile, "utf8").trim();
      } catch {
        // First start: log in with the bot token.
      }
      const session = new StringSession(saved);
      const client = new TelegramClient(session, this.opts.apiId, this.opts.apiHash, {
        connectionRetries: 3,
        autoReconnect: false,
        baseLogger: new Logger(LogLevel.ERROR),
      });
      try {
        await client.start({ botAuthToken: this.opts.botToken });
        const current = session.save();
        if (current && current !== saved) writeFileAtomic(this.opts.sessionFile, current);
        return await fn(client);
      } finally {
        await client.disconnect().catch(() => undefined);
        await client.destroy().catch(() => undefined);
      }
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** Logs in and returns the bot's @username, to check TELEGRAM_API_ID / TELEGRAM_API_HASH at startup. */
  check(): Promise<string> {
    return this.#withClient(async (client) => {
      const me = await client.getMe();
      return me.username ? `@${me.username}` : String(me.id);
    });
  }

  /** Downloads the document with this Bot API file_id to `target`. */
  async download(fileId: string, target: string, size?: number): Promise<void> {
    const location = decodeFileId(fileId);
    await this.#withClient(async (client) => {
      await client.downloadFile(
        new Api.InputDocumentFileLocation({
          id: bigInt(location.id.toString()),
          accessHash: bigInt(location.accessHash.toString()),
          fileReference: location.fileReference,
          thumbSize: "",
        }),
        {
          outputFile: target,
          dcId: location.dcId,
          partSizeKb: 512,
          ...(size !== undefined ? { fileSize: bigInt(size) } : {}),
        },
      );
    });
    if (!fs.existsSync(target)) throw new Error("the MTProto download produced no file");
  }
}
