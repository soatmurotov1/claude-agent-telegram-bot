import fs from "node:fs";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";

/** What the Admin AI puts into a report file. */
export interface ReportSpec {
  title: string;
  subtitle?: string;
  sections: { heading: string; paragraphs?: string[]; bullets?: string[] }[];
  tables: { title: string; columns: string[]; rows: (string | number | null)[][] }[];
}

export type ReportFormat = "pdf" | "xlsx" | "csv";

/** Fonts with Uzbek Latin (oʻ, gʻ) and Cyrillic; the first one that exists is used. */
const FONT_CANDIDATES = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/TTF/DejaVuSans.ttf",
  "C:\\Windows\\Fonts\\arial.ttf",
  "/System/Library/Fonts/Supplemental/Arial.ttf",
];
const BOLD_CANDIDATES = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
  "C:\\Windows\\Fonts\\arialbd.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
];

function firstExisting(paths: string[]): string | null {
  return paths.find((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  }) ?? null;
}

export function safeFileName(title: string, format: ReportFormat, date = new Date()): string {
  const base = title
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "hisobot";
  return `${base}-${date.toISOString().slice(0, 10)}.${format}`;
}

export async function buildReport(spec: ReportSpec, format: ReportFormat, fontPath = ""): Promise<Buffer> {
  if (format === "csv") return buildCsv(spec);
  if (format === "xlsx") return buildXlsx(spec);
  return buildPdf(spec, fontPath);
}

function csvCell(value: string | number | null): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",;\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** CSV with a BOM so Excel opens Uzbek and Russian text correctly. Every table follows the previous one. */
export function buildCsv(spec: ReportSpec): Buffer {
  const lines: string[] = [];
  const tables = spec.tables.length > 0 ? spec.tables : [{ title: spec.title, columns: ["Bo'lim", "Matn"], rows: sectionRows(spec) }];
  for (const [i, table] of tables.entries()) {
    if (i > 0) lines.push("");
    if (tables.length > 1) lines.push(csvCell(table.title));
    lines.push(table.columns.map(csvCell).join(","));
    for (const row of table.rows) lines.push(row.map(csvCell).join(","));
  }
  return Buffer.from(`\uFEFF${lines.join("\r\n")}\r\n`, "utf8");
}

function sectionRows(spec: ReportSpec): (string | number | null)[][] {
  return spec.sections.flatMap((section) => [
    ...(section.paragraphs ?? []).map((p) => [section.heading, p]),
    ...(section.bullets ?? []).map((b) => [section.heading, b]),
  ]);
}

export async function buildXlsx(spec: ReportSpec): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "SANOATGEOKONTEXXIZMAT bot";
  workbook.created = new Date();
  const summary = workbook.addWorksheet("Xulosa");
  summary.columns = [{ width: 28 }, { width: 110 }];
  summary.addRow([spec.title]).font = { bold: true, size: 14 };
  if (spec.subtitle) summary.addRow([spec.subtitle]);
  summary.addRow([]);
  for (const section of spec.sections) {
    summary.addRow([section.heading]).font = { bold: true };
    for (const p of section.paragraphs ?? []) summary.addRow(["", p]).alignment = { wrapText: true, vertical: "top" };
    for (const b of section.bullets ?? []) summary.addRow(["", `• ${b}`]).alignment = { wrapText: true, vertical: "top" };
    summary.addRow([]);
  }
  const used = new Set<string>(["Xulosa"]);
  for (const table of spec.tables) {
    let name = table.title.replace(/[\\/*?:[\]]/g, " ").slice(0, 28).trim() || "Jadval";
    for (let n = 2; used.has(name); n++) name = `${name.slice(0, 25)} ${n}`;
    used.add(name);
    const sheet = workbook.addWorksheet(name);
    sheet.addRow(table.columns).font = { bold: true };
    for (const row of table.rows) sheet.addRow(row.map((v) => (v === null ? "" : v)));
    sheet.columns.forEach((column, i) => {
      const longest = Math.max(
        String(table.columns[i] ?? "").length,
        ...table.rows.slice(0, 200).map((row) => String(row[i] ?? "").length),
      );
      column.width = Math.min(Math.max(10, longest + 2), 70);
    });
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: Math.max(1, table.columns.length) } };
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export function buildPdf(spec: ReportSpec, fontPath = ""): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 48, info: { Title: spec.title, Author: "SANOATGEOKONTEXXIZMAT" } });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    const regular = fontPath && fs.existsSync(fontPath) ? fontPath : firstExisting(FONT_CANDIDATES);
    const bold = firstExisting(BOLD_CANDIDATES) ?? regular;
    // Without a TTF the built-in Helvetica cannot draw Cyrillic or oʻ/gʻ; the text is still readable in Latin.
    const font = (b: boolean): void => {
      const file = b ? bold : regular;
      if (file) doc.font(file);
      else doc.font(b ? "Helvetica-Bold" : "Helvetica");
    };
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    font(true);
    doc.fontSize(18).text(spec.title, { width });
    if (spec.subtitle) {
      font(false);
      doc.moveDown(0.3).fontSize(10).fillColor("#555555").text(spec.subtitle, { width }).fillColor("#000000");
    }
    doc.moveDown(0.8);
    for (const section of spec.sections) {
      font(true);
      doc.fontSize(13).text(section.heading, { width });
      doc.moveDown(0.3);
      font(false);
      doc.fontSize(10.5);
      for (const p of section.paragraphs ?? []) doc.text(p, { width, align: "left" }).moveDown(0.4);
      for (const b of section.bullets ?? []) doc.text(`•  ${b}`, { width, indent: 8 }).moveDown(0.15);
      doc.moveDown(0.6);
    }
    for (const table of spec.tables) drawTable(doc, table, width, font);
    doc.end();
  });
}

function drawTable(
  doc: PDFKit.PDFDocument,
  table: ReportSpec["tables"][number],
  width: number,
  font: (bold: boolean) => void,
): void {
  const columns = Math.max(1, table.columns.length);
  const left = doc.page.margins.left;
  const colWidth = width / columns;
  const fontSize = columns > 6 ? 7.5 : 9;
  const bottom = (): number => doc.page.height - doc.page.margins.bottom;
  const rowHeight = (cells: string[]): number =>
    Math.max(...cells.map((cell) => doc.heightOfString(cell, { width: colWidth - 6 }))) + 6;
  const drawRow = (cells: string[], bold: boolean): void => {
    font(bold);
    doc.fontSize(fontSize);
    const height = rowHeight(cells);
    if (doc.y + height > bottom()) doc.addPage();
    const y = doc.y;
    if (bold) doc.rect(left, y, width, height).fill("#eeeeee").fillColor("#000000");
    cells.forEach((cell, i) => {
      doc.text(cell, left + i * colWidth + 3, y + 3, { width: colWidth - 6 });
    });
    doc.moveTo(left, y + height).lineTo(left + width, y + height).strokeColor("#cccccc").lineWidth(0.5).stroke();
    doc.x = left;
    doc.y = y + height;
  };
  if (doc.y + 60 > bottom()) doc.addPage();
  font(true);
  doc.fontSize(12).text(table.title, left, doc.y, { width });
  doc.moveDown(0.3);
  drawRow(table.columns.map(String), true);
  for (const row of table.rows) drawRow(table.columns.map((_, i) => (row[i] === null || row[i] === undefined ? "" : String(row[i]))), false);
  doc.moveDown(1);
}
