/*
 * The daily report: everything that happened in the last 24 hours in one text file for the admin.
 * Built from data the bot already keeps (conversations, received files); nothing goes to Claude.
 */

export const REPORT_WINDOW_SECONDS = 86400;

export interface ReportMessage {
  ts: number;
  who: string;
  text: string;
}

export interface ReportFile {
  ts: number;
  name: string;
}

export interface ReportClient {
  title: string;
  id: number;
  isNew: boolean;
  messages: ReportMessage[];
  files: ReportFile[];
  /** Files received in all, and how many are needed (after «Menda yo'q»), as "5/14"; null when none yet. */
  progress: string | null;
  packageSent: boolean;
}

export interface DailyReport {
  /** False when nothing happened: then no file is sent, only a short message. */
  hasChanges: boolean;
  text: string;
}

/** `2026-11-03` in Tashkent time. */
export function tashkentDate(epochSeconds: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tashkent",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(epochSeconds * 1000));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Hour of the day (0-23) in Tashkent. */
export function tashkentHour(epochSeconds: number): number {
  const hour = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tashkent", hour: "2-digit", hour12: false })
    .formatToParts(new Date(epochSeconds * 1000))
    .find((p) => p.type === "hour")?.value;
  return Number(hour) % 24;
}

function clock(epochSeconds: number): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Asia/Tashkent",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(epochSeconds * 1000));
}

/** Builds the report for the clients that were active between `since` and `now`. */
export function buildDailyReport(clients: readonly ReportClient[], since: number, now: number, company: string): DailyReport {
  const active = clients.filter((c) => c.isNew || c.messages.length > 0 || c.files.length > 0 || c.packageSent);
  const header = `${company} — kunlik hisobot\nDavr: ${clock(since)} — ${clock(now)} (Toshkent vaqti)`;
  if (active.length === 0) {
    return { hasChanges: false, text: `${header}\n\nOxirgi 24 soatda hech qanday o'zgarish yo'q.\n` };
  }

  const newClients = active.filter((c) => c.isNew).length;
  const messages = active.reduce((n, c) => n + c.messages.filter((m) => m.who !== company).length, 0);
  const files = active.reduce((n, c) => n + c.files.length, 0);
  const packages = active.filter((c) => c.packageSent);
  const lines = [
    header,
    "",
    "UMUMIY",
    `• Faol mijozlar: ${active.length} (yangi: ${newClients})`,
    `• Mijozlardan kelgan xabarlar: ${messages}`,
    `• Qabul qilingan fayllar: ${files}`,
    `• To'liq paketlar adminga yuborilgan: ${packages.length}${packages.length ? ` (${packages.map((c) => c.title).join(", ")})` : ""}`,
  ];
  for (const client of active) {
    lines.push("", "=".repeat(60), `${client.title} · ID ${client.id}${client.isNew ? " · YANGI" : ""}`);
    if (client.progress) lines.push(`Hujjatlar: ${client.progress}${client.packageSent ? " · paket yuborilgan" : ""}`);
    if (client.files.length > 0) {
      lines.push("", "Fayllar:", ...client.files.map((f) => `  ${clock(f.ts)}  ${f.name}`));
    }
    if (client.messages.length > 0) {
      lines.push("", "Yozishma:");
      for (const m of client.messages) lines.push(`  [${clock(m.ts)}] ${m.who}: ${m.text.replace(/\r?\n/g, "\n      ")}`);
    }
  }
  return { hasChanges: true, text: `${lines.join("\n")}\n` };
}
