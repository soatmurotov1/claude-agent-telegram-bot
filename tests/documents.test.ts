import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeError, ClaudeLimitError } from "../src/claudeCli.js";
import { ClientFolders, type ClientStatus, progress, progressText, safeFileName } from "../src/clientFolder.js";
import { docxText, fileKind, parseReview, xlsxText } from "../src/documentReview.js";
import { decodeFileId, encodeFileId, FileIdError } from "../src/largeFiles.js";
import { splitTemplate } from "../src/prompts.js";
import { quickRequest } from "../src/service.js";
import { blankFor, loadTemplate } from "../src/templates.js";
import { CLIENT_ID, CONNECTION_ID, cleanupHarnesses, makeHarness, OWNER_ID, PROJECT_DIR, verdict, verdicts } from "./harness.js";

const TEMPLATES = path.join(PROJECT_DIR, "templates");
const template = loadTemplate(TEMPLATES);
const blankUz = fs.readFileSync(path.join(TEMPLATES, "investment-checklist", "uz.docx"));

afterEach(cleanupHarnesses);

/** A copy of the Uzbek questionnaire with the first checkbox ticked and one run highlighted. */
async function filledQuestionnaire(): Promise<Buffer> {
  const zip = await JSZip.loadAsync(blankUz);
  let xml = (await zip.file("word/document.xml")?.async("string")) ?? "";
  xml = xml.replace("<w:t>☐</w:t>", "<w:t>☒</w:t>");
  xml = xml.replace(/<w:r><w:rPr>/, '<w:r><w:rPr><w:highlight w:val="yellow"/>');
  zip.file("word/document.xml", xml);
  return zip.generateAsync({ type: "nodebuffer" });
}

/** The answer the fake Claude gives for a file, by the file name in the prompt. */
function answerByName(answers: Record<string, string>) {
  return (_system: string, user: string): string => {
    const name = /File name as sent by the client: (.+)/.exec(user)?.[1]?.trim() ?? "";
    return answers[name] ?? "??";
  };
}

const pdf = (name: string) => ({ name, data: Buffer.from(`%PDF fake ${name}`) });

/** The 16 documents, in the order the client is asked for them. */
const KEYS = [
  "ustav",
  "egrpo",
  "ruxsatnoma",
  "litsenziya",
  "kelishuv",
  "uter",
  "tia",
  "tog_ajratmasi",
  "forma_5gr",
  "zvos",
  "zep",
  "pdv",
  "limitlar",
  "epb",
  "yer",
  "anketa",
];

describe("template", () => {
  it("asks for 16 required documents, the signed questionnaire with the NDA included", () => {
    expect(template.documents.map((d) => d.key)).toEqual(KEYS);
    expect(template.documents.every((d) => d.required)).toBe(true);
    for (const doc of template.documents) {
      expect(doc.parts.map((p) => p.key)).toEqual([doc.key]);
      // No exemptions: every document is needed whatever the questionnaire marks as NA.
      expect(doc.parts[0]?.naItems).toEqual([]);
      for (const part of doc.parts) expect(part.checks.length).toBeGreaterThan(0);
    }
    expect(template.documents.at(-1)?.title.uz).toContain("NDA");
  });

  it("gives Uzbek speakers the Uzbek form and Russian and English speakers the Russian one", () => {
    expect(path.basename(blankFor(template, "uz") ?? "")).toBe("uz.docx");
    expect(path.basename(blankFor(template, null) ?? "")).toBe("uz.docx");
    expect(path.basename(blankFor(template, "ru") ?? "")).toBe("ru.docx");
    expect(path.basename(blankFor(template, "en") ?? "")).toBe("ru.docx");
  });
});

describe("progress", () => {
  const part = (state: "accepted" | "rejected", reasons: string[] = []) => ({ state, reasons, ts: 1 });
  const doc = (key: string, state: "accepted" | "rejected", reasons: string[] = []) => ({
    files: [`${key}.pdf`],
    fileIds: {},
    parts: { [key]: part(state, reasons) },
  });
  const status = (docs: ClientStatus["docs"], naItems: number[] = []): ClientStatus => ({
    template: template.id,
    applicant: { company: "Test MChJ", direction: "A", naItems },
    docs,
    completedAt: null,
    completedFor: "",
  });

  it("counts the 16 documents: ready, wrong and missing", () => {
    const p = progress(
      status({ ustav: doc("ustav", "accepted"), egrpo: doc("egrpo", "rejected", ["3 oydan eski"]), anketa: doc("anketa", "accepted") }),
      template,
    );
    expect(p).toMatchObject({ total: 16, accepted: 2, rejected: 1, missing: 13, readyPct: 13, errorPct: 6, missingPct: 81 });
    const text = progressText(p, "uz");
    expect(text).toContain("Tayyor: 13% (2/16) · Xato: 6% (1) · Yetishmaydi: 81% (13)");
    expect(text).toContain("✅ 1. Korxona ustavi");
    expect(text).toContain("❌ 2. YeGRPO dan ko'chirma: 3 oydan eski");
    expect(text).toContain("⬜ 3. Yer qa'ridan foydalanish uchun elektron ruxsatnoma");
    expect(text).toContain("⬜ 13. Ekologik paket: limitlar");
    expect(text).toContain("✅ 16. Maxfiylik kelishuvi (NDA) — imzolangan anketa");
  });

  it("needs every document even when the questionnaire marks items NA", () => {
    const p = progress(status({ ustav: doc("ustav", "accepted") }, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), template);
    expect(p.total).toBe(16);
    expect(p.items.some((i) => i.state === "na")).toBe(false);
  });

  it("shows 0% for a new client", () => {
    const p = progress({ template: "", applicant: null, docs: {}, completedAt: null, completedFor: "" }, template);
    expect(p).toMatchObject({ total: 16, readyPct: 0, errorPct: 0, missingPct: 100 });
  });

  it("announces a package once per list of required documents", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "folders-"));
    try {
      const folders = new ClientFolders(dir, () => 1000);
      expect(folders.markComplete(7, KEYS)).toBe(true);
      expect(folders.markComplete(7, [...KEYS].reverse())).toBe(false);
      // A package completed under the old list of 5 documents is announced again for the 16.
      expect(folders.markComplete(8, ["ustav_egrpo", "epb_yer"])).toBe(true);
      expect(folders.markComplete(8, KEYS)).toBe(true);
      expect(folders.markComplete(8, KEYS)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("file text", () => {
  it("keeps checkbox states, highlights and table cells of the questionnaire", async () => {
    const blank = await docxText(blankUz);
    expect(blank).toContain("ЭКСПРЕСС-АНКЕТАСИ");
    expect(blank).toContain("☐  А йўналиши");
    expect(blank).not.toContain("☒");
    const filled = await docxText(await filledQuestionnaire());
    expect(filled).toContain("☒  А йўналиши");
    expect(filled).toContain("⟦");
  });

  it("reads Excel cells, shared strings included", async () => {
    const zip = new JSZip();
    zip.file("xl/sharedStrings.xml", "<sst><si><t>Компания</t></si><si><t>ООО Тест</t></si></sst>");
    zip.file(
      "xl/worksheets/sheet1.xml",
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1"><v>42</v></c></row></sheetData></worksheet>',
    );
    expect(await xlsxText(await zip.generateAsync({ type: "nodebuffer" }))).toContain("Компания | ООО Тест | 42");
  });

  it("decides how each format is checked", () => {
    expect(fileKind("Ustav.DOCX")).toBe("docx");
    expect(fileKind("scan.pdf")).toBe("pdf");
    expect(fileKind("photo.jpeg")).toBe("image");
    expect(fileKind("old.doc")).toBe("unsupported");
    expect(fileKind("archive.zip")).toBe("unsupported");
  });

  it("keeps Cyrillic in saved file names and drops path parts", () => {
    expect(safeFileName("../../Устав 2026.pdf")).toBe("Устав 2026.pdf");
    expect(safeFileName("a<b>:c|d?.docx")).toBe("a_b_c_d_.docx");
  });
});

describe("review answer", () => {
  it("reads the JSON even with text around it, with every document the file holds", () => {
    const raw = verdicts([
      { doc: "ustav", accepted: true },
      { doc: "egrpo", accepted: false, reasons: ["ko'chirma 3 oydan eski"] },
    ]);
    const answer = parseReview(`Here: ${raw} done`, template);
    expect(answer.items).toEqual([
      { doc: "ustav", parts: ["ustav"], verdict: "accepted", reasons: [] },
      { doc: "egrpo", parts: ["egrpo"], verdict: "rejected", reasons: ["ko'chirma 3 oydan eski"] },
    ]);
    expect(answer.reasons).toEqual([]);
  });

  it("drops unknown documents and merges a document named twice", () => {
    const answer = parseReview(
      verdicts([
        { doc: "passport", accepted: true, reasons: ["bu pasport"] },
        { doc: "zvos", accepted: false, reasons: ["imzo yo'q"] },
        { doc: "zvos", accepted: true },
      ]),
      template,
    );
    expect(answer.items).toEqual([{ doc: "zvos", parts: ["zvos"], verdict: "accepted", reasons: [] }]);
    expect(answer.reasons).toEqual(["bu pasport"]);
  });

  it("still reads the older one-document answer", () => {
    expect(parseReview(verdict("ustav", true), template).items).toEqual([
      { doc: "ustav", parts: ["ustav"], verdict: "accepted", reasons: [] },
    ]);
    expect(parseReview(verdict(null, false, { reasons: ["pasport"] }), template)).toMatchObject({ items: [], reasons: ["pasport"] });
    // A file that is none of the listed documents can never be accepted.
    expect(parseReview(verdict("passport", true), template).items).toEqual([]);
  });

  it("keeps the applicant only for an accepted questionnaire", () => {
    const applicant = { company: "Oltin Kon MChJ", direction: "B", na_items: [7, 99] };
    expect(parseReview(verdicts([{ doc: "anketa", accepted: true }], { applicant }), template).applicant).toEqual({
      company: "Oltin Kon MChJ",
      direction: "B",
      naItems: [7],
    });
    expect(parseReview(verdicts([{ doc: "ustav", accepted: true }], { applicant }), template).applicant).toBeNull();
    expect(parseReview(verdicts([{ doc: "anketa", accepted: false }], { applicant }), template).applicant).toBeNull();
  });

  it("throws on answers without a verdict", () => {
    expect(() => parseReview("I cannot read this file", template)).toThrow();
    expect(() => parseReview('{"doc": "ustav"}', template)).toThrow();
    expect(() => parseReview('{"documents": [{"doc": "ustav"}]}', template)).toThrow();
  });

  it("strips the [SEND_TEMPLATE] marker", () => {
    expect(splitTemplate("Anketani yuboraman. [SEND_TEMPLATE]")).toEqual({ sendTemplate: true, text: "Anketani yuboraman." });
    expect(splitTemplate("Rahmat")).toEqual({ sendTemplate: false, text: "Rahmat" });
  });

  it("recognises status and questionnaire requests", () => {
    expect(quickRequest("📊 Hujjatlar holati")).toBe("status");
    expect(quickRequest("Статус")).toBe("status");
    expect(quickRequest("holat?")).toBe("status");
    expect(quickRequest("📄 Anketa shabloni")).toBe("template");
    expect(quickRequest("Анкета")).toBe("template");
    expect(quickRequest("anketani qanday to'ldiraman")).toBeNull();
  });
});

describe("Bot API file_id", () => {
  const location = {
    fileType: 5,
    dcId: 2,
    id: 5432109876543210123n,
    accessHash: -1234567890123456789n,
    fileReference: Buffer.from("01000000ff00000000aabbccddeeff00112233445566778899", "hex"),
  };

  it("decodes what it encodes, file reference included", () => {
    const id = encodeFileId(location);
    expect(decodeFileId(id)).toEqual(location);
    expect(decodeFileId(encodeFileId({ ...location, fileReference: Buffer.alloc(0) })).id).toBe(location.id);
  });

  it("has the layout of real document ids (type 5 with a file reference, then the DC)", () => {
    // Real Bot API document ids start with "BQAC": type 0x02000005, then dc_id.
    expect(encodeFileId(location).startsWith("BQAC")).toBe(true);
  });

  it("refuses photo ids, which never need the large-file path", () => {
    expect(() => decodeFileId(encodeFileId({ ...location, fileType: 2 }))).toThrow(FileIdError);
    expect(() => decodeFileId("AAAA")).toThrow(FileIdError);
  });
});

describe("document batches", () => {
  /** "<key>.pdf" holds that one document, accepted. */
  const single = (keys: string[]): Record<string, string> =>
    Object.fromEntries(keys.map((key) => [`${key}.pdf`, verdicts([{ doc: key, accepted: true }])]));
  const toOwner = (h: ReturnType<typeof makeHarness>) => h.api.calls.filter((c) => Number(c.payload.chat_id) === OWNER_ID);
  const media = (call: { payload: Record<string, unknown> } | undefined) =>
    (call?.payload.media ?? []) as { type: string; media: unknown; caption?: string }[];

  it("sends the admin one message and the whole package in albums only once all 16 documents are accepted", async () => {
    const h = makeHarness();
    h.generator.fallback = answerByName({
      "01-ustav-egrpo.pdf": verdicts([{ doc: "ustav", accepted: true }, { doc: "egrpo", accepted: true }]),
      ...single(KEYS.slice(2)),
    });
    // 14 files with 15 documents (the first holds two): the admin hears nothing yet, however long it takes.
    for (const name of ["01-ustav-egrpo.pdf", ...KEYS.slice(2, 15).map((key) => `${key}.pdf`)]) {
      await h.send(h.directMessage(null, { file: pdf(name) }));
      h.clock.advance(120);
    }
    await h.flush();
    expect(String(h.api.sentTo(CLIENT_ID).at(-1)?.payload.text)).toContain("Tayyor: 94% (15/16)");
    expect(toOwner(h)).toHaveLength(0);
    h.api.clear();
    h.generator.calls.length = 0;

    await h.send(h.directMessage(null, { file: pdf("anketa.pdf") }));
    await h.flush();

    // The file was opened by Claude in a folder holding only that file, which is removed afterwards.
    expect(h.generator.calls).toHaveLength(1);
    const call = h.generator.calls[0];
    expect(call?.files).toEqual(["document.pdf"]);
    expect(fs.existsSync(call?.dir ?? "")).toBe(false);
    expect(call?.system).toContain('document "zvos"');
    expect(call?.system).toContain('"documents": [');
    expect(call?.system).toContain("ZRU-987");

    const summary = String(h.api.sentTo(CLIENT_ID).at(-1)?.payload.text);
    expect(summary).toContain("Tayyor: 100% (16/16)");
    expect(summary).toContain("Barcha hujjatlar qabul qilindi va mutaxassisimizga yuborildi.");

    // Now the admin gets one message and the 15 files in two albums (10 + 5), by file_id (no re-upload, any size).
    const sent = toOwner(h);
    expect(sent.map((c) => c.method)).toEqual(["sendMessage", "sendMediaGroup", "sendMediaGroup"]);
    expect(String(sent[0]?.payload.text)).toContain("🎉 Yangi to'liq paket: Aziz @user2000");
    expect(String(sent[0]?.payload.text)).toContain("Barcha 16 ta hujjat topshirildi va talab darajasida (100%)");
    const first = media(sent[1]);
    const second = media(sent[2]);
    expect(first).toHaveLength(10);
    expect(second).toHaveLength(5);
    for (const item of [...first, ...second]) {
      expect(item.type).toBe("document");
      expect(item.media).toMatch(/^file-\d+$/);
    }
    // The combined file is sent once, captioned with both documents.
    expect(first[0]?.caption).toBe("✅ 1. Korxona ustavi\n✅ 2. YeGRPO dan ko'chirma\n👤 Aziz @user2000");
    expect(first[1]?.caption).toBe("✅ 3. Yer qa'ridan foydalanish uchun elektron ruxsatnoma\n👤 Aziz @user2000");
    expect(second.at(-1)?.caption).toBe("✅ 16. Maxfiylik kelishuvi (NDA) — imzolangan anketa\n👤 Aziz @user2000");

    // It is stored once and hard-linked into the second document's folder.
    const dir = h.clientDir();
    const [ustav] = fs.readdirSync(path.join(dir, "accepted", "ustav"));
    expect(fs.readdirSync(path.join(dir, "accepted", "egrpo"))).toEqual([ustav]);
    expect(fs.statSync(path.join(dir, "accepted", "egrpo", ustav ?? "")).ino).toBe(
      fs.statSync(path.join(dir, "accepted", "ustav", ustav ?? "")).ino,
    );

    // The package is announced once; a newer accepted copy later is passed on as an update.
    h.api.clear();
    h.generator.push(verdicts([{ doc: "zvos", accepted: true }]));
    await h.send(h.directMessage(null, { file: pdf("zvos-yangi.pdf") }));
    await h.flush();
    const later = toOwner(h);
    expect(later.map((c) => c.method)).toEqual(["sendDocument"]);
    expect(String(later[0]?.payload.caption)).toBe("🔄 Yangilangan hujjat:\n✅ 10. Ekologik paket: ZVOS\n👤 Aziz @user2000");
  });

  it("sends the files one by one when an album cannot be sent", async () => {
    const h = makeHarness();
    h.api.failMediaGroup = true;
    h.generator.fallback = answerByName(single(KEYS));
    for (const key of KEYS) await h.send(h.directMessage(null, { file: pdf(`${key}.pdf`) }));
    await h.flush();
    const sent = toOwner(h);
    expect(sent.map((c) => c.method)).toEqual([
      "sendMessage",
      "sendMediaGroup",
      ...new Array(10).fill("sendDocument"),
      "sendMediaGroup",
      ...new Array(6).fill("sendDocument"),
    ]);
    expect(String(sent.at(-1)?.payload.caption)).toBe("✅ 16. Maxfiylik kelishuvi (NDA) — imzolangan anketa\n👤 Aziz @user2000");
  });

  it("accepts the good documents of a combined file and asks again for the wrong one", async () => {
    const h = makeHarness();
    h.generator.push(
      verdicts([
        { doc: "ustav", accepted: true },
        { doc: "egrpo", accepted: false, reasons: ["ko'chirma 3 oydan eski"] },
      ]),
    );
    await h.send(h.directMessage(null, { file: pdf("ustav-egrpo.pdf") }));
    await h.flush();
    const summary = String(h.api.sentTo(CLIENT_ID).at(-1)?.payload.text);
    expect(summary).toContain("✅ Qabul qilindi:\n• Korxona ustavi — ustav-egrpo.pdf");
    expect(summary).toContain("❌ Qayta yuboring:\n• YeGRPO dan ko'chirma (ustav-egrpo.pdf): ko'chirma 3 oydan eski");
    expect(summary).toContain("Tayyor: 6% (1/16) · Xato: 6% (1) · Yetishmaydi: 88% (14)");
    const dir = h.clientDir();
    expect(fs.readdirSync(path.join(dir, "accepted"))).toEqual(["ustav"]);
    expect(fs.readFileSync(path.join(dir, "rejected", "reasons.jsonl"), "utf8")).toContain("3 oydan eski");
  });

  it("reviews many files as one batch and saves them by result", async () => {
    const h = makeHarness();
    const answers: Record<string, string> = {
      "anketa.docx": verdicts([{ doc: "anketa", accepted: true }], {
        applicant: { company: "Oltin Kon MChJ", direction: "B", na_items: [] },
      }),
      "Ustav.pdf": verdicts([{ doc: "ustav", accepted: true }]),
      "egrpo.pdf": verdicts([{ doc: "egrpo", accepted: false, reasons: ["ko'chirma 3 oydan eski"] }]),
      "ruxsatnoma.jpg": verdicts([{ doc: "ruxsatnoma", accepted: true }]),
      "kelishuv.pdf": verdicts([{ doc: "kelishuv", accepted: true }]),
      "pasport.jpg": verdict(null, false),
      "loyiha1.pdf": verdicts([{ doc: "uter", accepted: true }]),
      "loyiha2.pdf": verdicts([{ doc: "tia", accepted: true }]),
      "eko.pdf": verdicts([
        { doc: "zvos", accepted: true },
        { doc: "zep", accepted: true },
        { doc: "pdv", accepted: true },
      ]),
      "epb.pdf": verdicts([{ doc: "epb", accepted: true }]),
      "yer.pdf": "not json at all",
      "old.doc": "",
    };
    h.generator.fallback = answerByName(answers);
    for (const name of Object.keys(answers)) {
      const data = name.endsWith(".docx") ? await filledQuestionnaire() : Buffer.from(`%PDF fake ${name}`);
      await h.send(h.directMessage(null, { file: { name, data } }));
    }
    await h.flush();

    // .doc is rejected without Claude; the docx text went into the prompt.
    expect(h.generator.calls).toHaveLength(11);
    const docxCall = h.generator.calls.find((c) => c.user.includes("anketa.docx"));
    expect(docxCall?.dir).toBeUndefined();
    expect(docxCall?.user).toContain("☒");

    const toClient = h.api.sentTo(CLIENT_ID).map((c) => String(c.payload.text));
    expect(toClient).toHaveLength(2); // "checking ..." and the summary
    const summary = toClient[1] ?? "";
    expect(summary).toContain("12 ta faylingiz");
    expect(summary).toContain("• Korxona ustavi — Ustav.pdf");
    expect(summary).toContain("• Ekologik paket: ZVOS, Ekologik paket: ZEP, Ekologik paket: PDV — eko.pdf");
    expect(summary).toContain("YeGRPO dan ko'chirma (egrpo.pdf): ko'chirma 3 oydan eski");
    expect(summary).toContain("pasport.jpg: bu hujjat talab qilinadigan hujjatlar ro'yxatida yo'q");
    expect(summary).toContain("old.doc: bu formatdagi faylni tekshirib bo'lmaydi");
    expect(summary).toMatch(/⏳[^\n]*qayta tekshiriladi:\n• yer\.pdf/);
    expect(summary).toContain("Tayyor: 63% (10/16) · Xato: 6% (1) · Yetishmaydi: 31% (5)");
    expect(summary).toContain("⬜ 4. Yer qa'ridan foydalanish uchun elektron litsenziya");

    const dir = h.clientDir();
    expect(fs.readdirSync(path.join(dir, "accepted")).sort()).toEqual(
      ["anketa", "epb", "kelishuv", "pdv", "ruxsatnoma", "tia", "uter", "ustav", "zep", "zvos"].sort(),
    );
    const rejected = fs.readdirSync(path.join(dir, "rejected"));
    expect(rejected.filter((f) => f !== "reasons.jsonl")).toHaveLength(3);
    expect(fs.readFileSync(path.join(dir, "rejected", "reasons.jsonl"), "utf8")).toContain("3 oydan eski");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8")).applicant.company).toBe("Oltin Kon MChJ");
    // yer.pdf waits in the inbox for another attempt.
    expect(h.assistant.inbox.read(CLIENT_ID).files.map((f) => [f.name, f.attempts])).toEqual([["yer.pdf", 1]]);

    // The package is not complete, so the admin is sent nothing at all.
    expect(toOwner(h)).toHaveLength(0);

    // Next round: yer.pdf is checked again, and the register extract sent again fixes document 2.
    h.api.clear();
    h.generator.fallback = answerByName({
      "yer.pdf": verdicts([{ doc: "yer", accepted: true }]),
      "egrpo-yangi.pdf": verdicts([{ doc: "egrpo", accepted: true }]),
    });
    await h.send(h.directMessage(null, { file: pdf("egrpo-yangi.pdf") }));
    await h.flush();
    const second = String(h.api.sentTo(CLIENT_ID).at(-1)?.payload.text);
    expect(second).toContain("✅ 2. YeGRPO dan ko'chirma");
    expect(second).toContain("✅ 15. Yer ajratmasi to'g'risidagi qarorlar");
    expect(second).toContain("Tayyor: 75% (12/16)");
    expect(toOwner(h)).toHaveLength(0);

    // The status request shows the same figures without calling Claude.
    h.api.clear();
    const calls = h.generator.calls.length;
    await h.send(h.directMessage("holat"));
    expect(h.generator.calls).toHaveLength(calls);
    expect(String(h.api.sentTo(CLIENT_ID)[0]?.payload.text)).toContain("Tayyor: 75% (12/16)");
  });

  it("tries a file again when its check fails, and asks the client for another copy after the last attempt", async () => {
    const h = makeHarness();
    h.generator.fallback = () => {
      throw new ClaudeError("Claude did not answer within 120 s");
    };
    await h.send(h.directMessage(null, { file: pdf("skan.pdf") }));
    await h.flush();
    expect(String(h.api.sentTo(CLIENT_ID).at(-1)?.payload.text)).toContain("⏳");
    expect(h.assistant.inbox.read(CLIENT_ID).files[0]?.attempts).toBe(1);
    await h.flush();
    expect(h.assistant.inbox.read(CLIENT_ID).files[0]?.attempts).toBe(2);
    await h.flush();
    expect(h.generator.calls).toHaveLength(3);
    expect(h.assistant.inbox.read(CLIENT_ID).files).toHaveLength(0);
    const last = String(h.api.sentTo(CLIENT_ID).at(-1)?.payload.text);
    expect(last).toContain("skan.pdf: faylni avtomatik tekshirib bo'lmadi: uni PDF qilib yoki aniqroq skan qilib qayta yuboring");
    expect(toOwner(h)).toHaveLength(0);
  });

  it("keeps an accepted document when a wrong copy comes later", async () => {
    const h = makeHarness();
    h.generator.push(verdicts([{ doc: "ustav", accepted: true }]), verdicts([{ doc: "ustav", accepted: false, reasons: ["muhr yo'q"] }]));
    await h.send(h.directMessage(null, { file: pdf("ustav.pdf") }));
    await h.flush();
    await h.send(h.directMessage(null, { file: pdf("ustav2.pdf") }));
    await h.flush();
    expect(h.assistant.clientProgressText(CLIENT_ID, "uz")).toContain("✅ 1. Korxona ustavi");
  });

  it("does not send summaries to the client in preview mode but still saves the files", async () => {
    const h = makeHarness({ AUTO_SEND: "false" });
    h.generator.push(verdicts([{ doc: "zvos", accepted: true }]));
    await h.send(h.directMessage(null, { file: pdf("eko.pdf") }));
    await h.flush();
    expect(h.api.sentTo(CLIENT_ID)).toHaveLength(0);
    expect(h.previews.at(-1)?.reply).toContain("Ekologik paket: ZVOS — eko.pdf");
    expect(fs.readdirSync(path.join(h.clientDir(), "accepted", "zvos"))).toHaveLength(1);
    expect(toOwner(h)).toHaveLength(0);
  });

  it("accepts files over 20 MB through the large-file download", async () => {
    const h = makeHarness();
    h.generator.push(verdicts([{ doc: "tia", accepted: true }]));
    await h.send(h.directMessage(null, { file: { name: "TIA-katta.pdf", data: Buffer.from("%PDF big"), size: 85 * 1024 * 1024 } }));
    await h.send(h.directMessage(null, { file: { name: "kichik.pdf", data: Buffer.from("%PDF small") } }));
    await h.flush();
    expect(h.largeDownloads).toHaveLength(1);
    expect(h.generator.calls).toHaveLength(2);
    expect(String(h.api.sentTo(CLIENT_ID).at(-1)?.payload.text)).toContain("TIA-katta.pdf");
    expect(fs.readdirSync(path.join(h.clientDir(), "accepted", "tia"))).toHaveLength(1);
  });

  it("refuses large files when the large-file download is not set up, and files over MAX_FILE_MB", async () => {
    const off = makeHarness({}, { largeFiles: false });
    await off.send(off.directMessage(null, { file: { name: "katta.pdf", data: Buffer.from("x"), size: 25 * 1024 * 1024 } }));
    await off.flush();
    expect(off.generator.calls).toHaveLength(0);
    expect(String(off.api.sentTo(CLIENT_ID).at(-1)?.payload.text)).toContain(
      "katta.pdf: 20 MB dan katta fayllarni qabul qilish hali sozlanmagan",
    );

    const capped = makeHarness({ MAX_FILE_MB: "30" });
    await capped.send(capped.directMessage(null, { file: { name: "juda-katta.pdf", data: Buffer.from("x"), size: 40 * 1024 * 1024 } }));
    await capped.send(capped.directMessage(null, { file: { name: "eski.doc", data: Buffer.from("x") } }));
    await capped.flush();
    expect(capped.generator.calls).toHaveLength(0);
    expect(capped.largeDownloads).toHaveLength(0);
    const texts = capped.api.sentTo(CLIENT_ID).map((c) => String(c.payload.text));
    expect(texts.some((t) => t.includes("juda-katta.pdf: fayl 30 MB dan katta"))).toBe(true);
    expect(texts.some((t) => t.includes("eski.doc") && t.includes("PDF, DOCX, XLSX"))).toBe(true);
  });

  it("stops at the usage limit and keeps the rest in the inbox across a restart", async () => {
    const h = makeHarness();
    h.generator.push(verdicts([{ doc: "ustav", accepted: true }]), new ClaudeLimitError("usage limit", h.clock.t + 3600, null));
    for (const name of ["a.pdf", "b.pdf", "c.pdf"]) await h.send(h.directMessage(null, { file: pdf(name) }));
    await h.flush();
    expect(h.generator.calls).toHaveLength(2);
    expect(h.assistant.inbox.read(CLIENT_ID).files.map((f) => f.name)).toEqual(["b.pdf", "c.pdf"]);
    expect(String(h.api.sentTo(CLIENT_ID).at(-1)?.payload.text)).toContain("Qolgan 2 ta fayl birozdan keyin");

    h.restart();
    h.clock.advance(3601);
    h.generator.push(verdicts([{ doc: "tia", accepted: true }]), verdicts([{ doc: "ruxsatnoma", accepted: true }]));
    await h.flush();
    expect(h.generator.calls).toHaveLength(4);
    expect(h.assistant.inbox.read(CLIENT_ID).files).toHaveLength(0);
    expect(h.assistant.clientProgressText(CLIENT_ID, "uz")).toContain("Tayyor: 19% (3/16)");
  });

  it("reviews files sent to the business account and answers through it", async () => {
    const h = makeHarness();
    h.setConnection();
    h.generator.push(verdicts([{ doc: "ustav", accepted: true }]));
    await h.send(h.businessMessage(null, pdf("ustav.pdf")));
    await h.flush();
    const summary = h.api.sentTo(CLIENT_ID).at(-1);
    expect(summary?.payload.business_connection_id).toBe(CONNECTION_ID);
    expect(String(summary?.payload.text)).toContain("Korxona ustavi — ustav.pdf");
  });

  it("reviews photos too", async () => {
    const h = makeHarness();
    h.generator.push(verdicts([{ doc: "ruxsatnoma", accepted: true }]));
    await h.send(h.directMessage(null, { photo: Buffer.from("jpeg") }));
    await h.flush();
    expect(h.generator.calls[0]?.files).toEqual(["document.jpg"]);
    expect(h.assistant.clientProgressText(CLIENT_ID, "uz")).toContain("✅ 3. Yer qa'ridan foydalanish uchun elektron ruxsatnoma");
  });
});

describe("client folder and questionnaire", () => {
  it("writes every message of both sides to chat.txt", async () => {
    const h = makeHarness();
    h.generator.push("Assalomu alaykum! Qaysi xizmat kerak?");
    await h.send(h.directMessage("Salom, litsenziya kerak"));
    const chat = fs.readFileSync(path.join(h.clientDir(), "chat.txt"), "utf8");
    expect(chat).toMatch(/\] Aziz: Salom, litsenziya kerak\n/);
    expect(chat).toMatch(/\] Sanoatgeokontexxizmat: Assalomu alaykum! Qaysi xizmat kerak\?\n/);
  });

  it("sends the blank questionnaire when Claude asks for it, without the marker", async () => {
    const h = makeHarness();
    h.generator.push("Anketani yuboraman, 16 ta hujjatni yuboring. [SEND_TEMPLATE]");
    await h.send(h.directMessage("Konimizga investor kerak"));
    const text = h.api.sentTo(CLIENT_ID).map((c) => String(c.payload.text));
    expect(text).toEqual(["Anketani yuboraman, 16 ta hujjatni yuboring."]);
    expect(h.api.sentTo(CLIENT_ID, "sendDocument")).toHaveLength(1);
    expect(h.generator.calls[0]?.system).toContain("[SEND_TEMPLATE]");
    expect(h.generator.calls[0]?.system).toContain("all 16 documents");
  });

  it("sends the Russian form with the list of 16 documents on request, without Claude", async () => {
    const h = makeHarness();
    await h.send(h.directMessage("Анкета"));
    expect(h.generator.calls).toHaveLength(0);
    const caption = String(h.api.sentTo(CLIENT_ID, "sendDocument")[0]?.payload.caption);
    expect(caption).toContain("16 документов");
    expect(caption).toContain("15) решения на земельный отвод");
  });

  it("shows clients the status and questionnaire buttons on /start", async () => {
    const h = makeHarness();
    await h.send(h.directMessage("/start"));
    const markup = h.api.sentTo(CLIENT_ID)[0]?.payload.reply_markup as { keyboard: { text: string }[][] };
    expect(markup.keyboard.flat().map((b) => b.text)).toEqual(["📊 Hujjatlar holati", "📄 Anketa shabloni"]);
  });
});

describe("deleting a chat", () => {
  async function clientWithHistory() {
    const h = makeHarness();
    h.generator.push("Javob", verdicts([{ doc: "ustav", accepted: true }]));
    await h.send(h.directMessage("Salom"));
    await h.send(h.directMessage(null, { file: pdf("ustav.pdf") }));
    await h.flush();
    h.api.clear();
    return h;
  }

  it("is only possible for the owner and only after confirmation", async () => {
    const h = await clientWithHistory();
    await h.send(h.callback(`delete:${CLIENT_ID}`, CLIENT_ID));
    await h.send(h.callback(`delete-yes:${CLIENT_ID}`, CLIENT_ID));
    expect(fs.existsSync(h.clientDir())).toBe(true);

    await h.send(h.callback(`delete:${CLIENT_ID}`));
    expect(String(h.api.sentTo(OWNER_ID).at(-1)?.payload.text)).toContain("O'chirilsinmi?");
    expect(fs.existsSync(h.clientDir())).toBe(true);

    await h.send(h.callback("delete-no"));
    expect(fs.existsSync(h.clientDir())).toBe(true);
  });

  it("removes the history, the users entry and the whole folder", async () => {
    const h = await clientWithHistory();
    expect(h.assistant.users.list()).toHaveLength(1);
    await h.send(h.callback(`delete-yes:${CLIENT_ID}`));
    expect(fs.existsSync(h.clientDir())).toBe(false);
    expect(h.assistant.users.list()).toHaveLength(0);
    expect(h.assistant.transcripts.forChat(CLIENT_ID)).toHaveLength(0);
    expect(h.assistant.history.chatCount()).toBe(0);
    expect(String(h.api.sentTo(OWNER_ID).at(-1)?.payload.text)).toContain("o'chirildi");

    h.restart();
    expect(h.assistant.users.list()).toHaveLength(0);
    expect(h.assistant.transcripts.forChat(CLIENT_ID)).toHaveLength(0);
  });

  it("shows the owner the folder with progress and the new buttons", async () => {
    const h = await clientWithHistory();
    await h.send(h.callback(`folder:${CLIENT_ID}`));
    const last = h.api.sentTo(OWNER_ID).at(-1);
    expect(String(last?.payload.text)).toContain("Tayyor: 6% (1/16)");
    const buttons = (last?.payload.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard
      .flat()
      .map((b) => b.callback_data);
    expect(buttons).toEqual([`reply:${CLIENT_ID}`, `chattxt:${CLIENT_ID}`, `files:${CLIENT_ID}`, `delete:${CLIENT_ID}`]);

    await h.send(h.callback(`chattxt:${CLIENT_ID}`));
    expect(h.api.sentTo(OWNER_ID, "sendDocument").at(-1)?.payload.caption).toContain("yozishma");
    await h.send(h.callback(`files:${CLIENT_ID}`));
    expect(String(h.api.sentTo(OWNER_ID, "sendDocument").at(-1)?.payload.caption)).toBe("✅ 1. Korxona ustavi");

    expect(h.assistant.usersListMessages()[0]?.text ?? "").toContain("📊 6%");
  });
});
