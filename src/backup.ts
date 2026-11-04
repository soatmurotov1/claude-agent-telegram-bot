/*
 * The daily backup: a zip of the data directory for the admin, sent next to the daily report.
 * If the Railway volume is ever lost, unpacking the latest zip into the data directory brings the bot back.
 *
 * Telegram bots can upload at most 50 MB, so the zip is built in two steps: everything small (state, users,
 * conversations, status.json, chat.txt) always goes in; client documents are added, newest first, while they fit in
 * the size budget. What did not fit is listed in FAYLLAR-RO'YXATI.txt. Complete document packages are also sent
 * to the admin as soon as they are ready, so the documents are the least critical part of the backup.
 */
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";

/** Telegram's limit for a file uploaded by a bot is 50 MB; the budget stays well below it. */
export const BACKUP_BUDGET_BYTES = 30 * 1024 * 1024;

/** Files that never go in: the MTProto login of the bot and temporary files. */
const SKIPPED_NAMES = new Set(["mtproto.session"]);

export interface BackupResult {
  buffer: Buffer;
  /** Files in the zip (not counting the list file). */
  included: number;
  /** Documents that did not fit the size budget. */
  skipped: number;
  /** Size of everything that was read, before compression. */
  rawBytes: number;
}

interface Entry {
  rel: string;
  abs: string;
  size: number;
  mtimeMs: number;
}

function walk(root: string, dir: string, out: Entry[]): void {
  let items: fs.Dirent[];
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const item of items) {
    const abs = path.join(dir, item.name);
    if (item.isDirectory()) {
      walk(root, abs, out);
    } else if (item.isFile() && !SKIPPED_NAMES.has(item.name)) {
      try {
        const stat = fs.statSync(abs);
        out.push({ rel: path.relative(root, abs).split(path.sep).join("/"), abs, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // a file that disappeared while walking is not part of the backup
      }
    }
  }
}

/** Client documents: everything below data/clients/<id>/ except the small text and JSON files. */
function isDocument(rel: string): boolean {
  if (!rel.startsWith("clients/")) return false;
  return !/\.(json|jsonl|txt)$/i.test(rel) || /\/(received|accepted|rejected|inbox)\//.test(rel);
}

/** Builds the backup zip of `dataDir`. Never throws for one unreadable file. */
export async function buildBackup(dataDir: string, budgetBytes = BACKUP_BUDGET_BYTES): Promise<BackupResult> {
  const entries: Entry[] = [];
  walk(dataDir, dataDir, entries);
  const core = entries.filter((e) => !isDocument(e.rel));
  const documents = entries.filter((e) => isDocument(e.rel)).sort((a, b) => b.mtimeMs - a.mtimeMs);

  const zip = new JSZip();
  let rawBytes = 0;
  let included = 0;
  for (const entry of core) {
    try {
      zip.file(entry.rel, fs.readFileSync(entry.abs), { date: new Date(entry.mtimeMs) });
      rawBytes += entry.size;
      included++;
    } catch {
      // unreadable: skipped
    }
  }

  const skipped: Entry[] = [];
  for (const entry of documents) {
    if (rawBytes + entry.size > budgetBytes) {
      skipped.push(entry);
      continue;
    }
    try {
      zip.file(entry.rel, fs.readFileSync(entry.abs), { date: new Date(entry.mtimeMs) });
      rawBytes += entry.size;
      included++;
    } catch {
      skipped.push(entry);
    }
  }

  if (skipped.length > 0) {
    const lines = [
      "Bu hujjatlar hajm chegarasi tufayli zaxira arxivga kirmadi (ular Railway volume'da turibdi):",
      "",
      ...skipped.map((e) => `${e.rel}  ${(e.size / 1024 / 1024).toFixed(1)} MB`),
    ];
    zip.file("FAYLLAR-RO'YXATI.txt", `${lines.join("\n")}\n`);
  }
  zip.file(
    "TIKLASH.txt",
    "Tiklash: bu arxivni ochib, ichidagi hamma narsani botning data papkasiga (Railway'da /app/data) joylang, so'ng botni qayta ishga tushiring.\n",
  );

  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  return { buffer, included, skipped: skipped.length, rawBytes };
}
