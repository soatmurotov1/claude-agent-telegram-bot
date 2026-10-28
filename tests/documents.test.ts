import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeError, ClaudeLimitError } from "../src/claudeCli.js";
import { type ClientStatus, progress, progressText, safeFileName } from "../src/clientFolder.js";
import { docxText, fileKind, parseReview, xlsxText } from "../src/documentReview.js";
import { decodeFileId, encodeFileId, FileIdError } from "../src/largeFiles.js";
import { splitTemplate } from "../src/prompts.js";
import { quickRequest } from "../src/service.js";
import { blankFor, loadTemplate } from "../src/templates.js";
import { CLIENT_ID, CONNECTION_ID, cleanupHarnesses, makeHarness, OWNER_ID, PROJECT_DIR, verdict } from "./harness.js";

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

describe("template", () => {
  it("asks for the 5 documents of step 3, with the questionnaire as an optional extra", () => {
    expect(template.documents.filter((d) => d.required).map((d) => d.key)).toEqual([
      "ustav_egrpo",
      "ruxsatnoma_kelishuv",
      "loyiha_5gr",
      "ekologik_paket",
      "epb_yer",
    ]);
    expect(template.documents.find((d) => d.key === "anketa")?.required).toBe(false);
    expect(template.documents.find((d) => d.key === "ustav_egrpo")?.parts.map((p) => p.key)).toEqual(["ustav", "egrpo"]);
    for (const doc of template.documents) {
      for (const part of doc.parts) expect(part.checks.length).toBeGreaterThan(0);
    }
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
  const status = (docs: ClientStatus["docs"], naItems: number[] = []): ClientStatus => ({
    template: template.id,
    applicant: { company: "Test MChJ", direction: "A", naItems },
    docs,
    completedAt: null,
  });

  it("counts the 5 documents: ready, wrong, partly sent and missing", () => {
    const p = progress(
      status({
        ustav_egrpo: { files: ["a"], fileIds: {}, parts: { ustav: part("accepted"), egrpo: part("accepted") } },
        ruxsatnoma_kelishuv: { files: ["b"], fileIds: {}, parts: { ruxsatnoma: part("accepted"), kelishuv: part("rejected", ["imzo yo'q"]) } },
        loyiha_5gr: { files: ["c"], fileIds: {}, parts: { loyiha: part("accepted") } },
        anketa: { files: ["d"], fileIds: {}, parts: { anketa: part("accepted") } },
      }),
      template,
    );
    expect(p).toMatchObject({ total: 5, accepted: 1, rejected: 1, missing: 3, readyPct: 20, errorPct: 20, missingPct: 60 });
    const text = progressText(p, "uz");
    expect(text).toContain("Tayyor: 20% (1/5) · Xato: 20% (1) · Yetishmaydi: 60% (3)");
    expect(text).toContain("✅ 1. Korxona ustavi va YeGRPO dan ko'chirma");
    expect(text).toContain("❌ 2. Yer qa'ridan foydalanish ruxsatnomasi (litsenziya) va litsenziya kelishuvi: Litsenziya kelishuvi (shartnoma): imzo yo'q");
    expect(text).toContain("🟡 3. Loyiha hujjatlari (UTER, TIA, tog' ajratmasi loyihasi) va 5-GR tasdig'i — yetishmaydi: 5-GR shakli topshirilganligi tasdig'i");
    expect(text).toContain("⬜ 4. Ekologik paket");
    expect(text).toContain("✅ To'ldirilgan anketa (NDA bilan) (ixtiyoriy)");
  });

  it("does not need parts of items marked NA", () => {
    const p = progress(
      status({ ustav_egrpo: { files: ["a"], fileIds: {}, parts: { ustav: part("accepted") } } }, [2, 7, 8, 9]),
      template,
    );
    // Item 2 drops the register extract from document 1; items 7, 8 and 9 drop documents 4 and 5.
    expect(p.total).toBe(3);
    expect(p.accepted).toBe(1);
    expect(p.items.find((i) => i.doc.key === "ustav_egrpo")?.state).toBe("accepted");
    expect(p.items.find((i) => i.doc.key === "ekologik_paket")?.state).toBe("na");
    expect(progressText(p, "ru")).toContain("➖ 5. Акты экспертизы промышленной безопасности (ЭПБ) по ОПО и решения на земельный отвод (не требуется)");
  });

  it("shows 0% for a new client", () => {
    const p = progress({ template: "", applicant: null, docs: {}, completedAt: null }, template);
    expect(p).toMatchObject({ total: 5, readyPct: 0, errorPct: 0, missingPct: 100 });
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
  it("reads the JSON even with text around it, with the parts the file holds", () => {
    const answer = parseReview(`Here: ${verdict("ustav_egrpo", true, { parts: ["egrpo"] })} done`, template);
    expect(answer).toMatchObject({ doc: "ustav_egrpo", parts: ["egrpo"], verdict: "accepted", reasons: [] });
  });

  it("takes all parts when none are named, and maps a part key to its document", () => {
    expect(parseReview(verdict("ustav_egrpo", true), template).parts).toEqual(["ustav", "egrpo"]);
    expect(parseReview(verdict("egrpo", true), template)).toMatchObject({ doc: "ustav_egrpo", parts: ["egrpo"] });
    expect(parseReview(verdict("ustav_egrpo", true, { parts: ["egrpo", "yer"] }), template).parts).toEqual(["egrpo"]);
  });

  it("never accepts a file that is none of the listed documents", () => {
    expect(parseReview(verdict("passport", true), template)).toMatchObject({ doc: null, parts: [], verdict: "rejected" });
  });

  it("keeps the applicant only for the questionnaire", () => {
    const applicant = { company: "Oltin Kon MChJ", direction: "B", na_items: [7, 99] };
    expect(parseReview(verdict("anketa", true, { applicant }), template).applicant).toEqual({
      company: "Oltin Kon MChJ",
      direction: "B",
      naItems: [7],
    });
    expect(parseReview(verdict("ustav_egrpo", true, { applicant }), template).applicant).toBeNull();
  });

  it("throws on answers without a verdict", () => {
    expect(() => parseReview("I cannot read this file", template)).toThrow();
    expect(() => parseReview('{"doc": "ustav_egrpo"}', template)).toThrow();
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
  it("sends the admin the whole package only once all 5 documents are accepted", async () => {
    const h = makeHarness();
    h.generator.fallback = answerByName({
      "1-ustav-egrpo.pdf": verdict("ustav_egrpo", true),
      "2-litsenziya.pdf": verdict("ruxsatnoma_kelishuv", true),
      "3-loyiha.pdf": verdict("loyiha_5gr", true),
      "4-eko.pdf": verdict("ekologik_paket", true),
      "5-epb-yer.pdf": verdict("epb_yer", true),
    });
    // Four documents first: the admin hears nothing yet.
    for (const name of ["1-ustav-egrpo.pdf", "2-litsenziya.pdf", "3-loyiha.pdf", "4-eko.pdf"]) {
      await h.send(h.directMessage(null, { file: pdf(name) }));
    }
    await h.flush();
    expect(String(h.api.sentTo(CLIENT_ID).at(-1)?.payload.text)).toContain("Tayyor: 80% (4/5)");
    expect(h.api.calls.filter((c) => Number(c.payload.chat_id) === OWNER_ID)).toHaveLength(0);
    h.api.clear();
    h.generator.calls.length = 0;

    await h.send(h.directMessage(null, { file: pdf("5-epb-yer.pdf") }));
    expect(h.assistant.outcomes.filter((o) => o === "review_queued")).toHaveLength(5);
    expect(h.generator.calls).toHaveLength(0);
    await h.flush();

    // The file was opened by Claude in a folder holding only that file, which is removed afterwards.
    expect(h.generator.calls).toHaveLength(1);
    const call = h.generator.calls[0];
    expect(call?.files).toEqual(["document.pdf"]);
    expect(fs.existsSync(call?.dir ?? "")).toBe(false);
    expect(call?.system).toContain('part "egrpo"');
    expect(call?.system).toContain("ZRU-987");

    const summary = String(h.api.sentTo(CLIENT_ID).at(-1)?.payload.text);
    expect(summary).toContain("Tayyor: 100% (5/5)");
    expect(summary).toContain("Barcha hujjatlar qabul qilindi va mutaxassisimizga yuborildi.");

    // Now the admin gets one message and the 5 files, sent by their Telegram file_id (no re-upload, any size).
    const toOwner = h.api.calls.filter((c) => Number(c.payload.chat_id) === OWNER_ID);
    expect(toOwner.map((c) => c.method)).toEqual(["sendMessage", ...new Array(5).fill("sendDocument")]);
    expect(String(toOwner[0]?.payload.text)).toContain("🎉 Yangi to'liq paket: Aziz @user2000");
    expect(String(toOwner[0]?.payload.text)).toContain("Barcha 5 ta hujjat topshirildi va talab darajasida (100%)");
    expect(String(toOwner[1]?.payload.caption)).toBe("✅ Korxona ustavi va YeGRPO dan ko'chirma\n👤 Aziz @user2000");
    for (const doc of toOwner.slice(1)) expect(doc.payload.document).toMatch(/^file-\d+$/);

    // The package is announced once; a newer accepted copy later is passed on as an update.
    h.api.clear();
    h.generator.push(verdict("ekologik_paket", true));
    await h.send(h.directMessage(null, { file: pdf("eko-yangi.pdf") }));
    await h.flush();
    const later = h.api.calls.filter((c) => Number(c.payload.chat_id) === OWNER_ID);
    expect(later.map((c) => c.method)).toEqual(["sendDocument"]);
    expect(String(later[0]?.payload.caption)).toContain("🔄 Yangilangan hujjat: Ekologik paket");
  });

  it("reviews many files as one batch and saves them by result", async () => {
    const h = makeHarness();
    const answers: Record<string, string> = {
      "anketa.docx": verdict("anketa", true, { applicant: { company: "Oltin Kon MChJ", direction: "B", na_items: [] } }),
      "Ustav.pdf": verdict("ustav_egrpo", true, { parts: ["ustav"] }),
      "egrpo.pdf": verdict("ustav_egrpo", false, { parts: ["egrpo"], reasons: ["ko'chirma 3 oydan eski"] }),
      "ruxsatnoma.jpg": verdict("ruxsatnoma_kelishuv", true, { parts: ["ruxsatnoma"] }),
      "kelishuv.pdf": verdict("ruxsatnoma_kelishuv", true, { parts: ["kelishuv"] }),
      "pasport.jpg": verdict(null, false),
      "loyiha1.pdf": verdict("loyiha_5gr", true, { parts: ["loyiha"] }),
      "loyiha2.pdf": verdict("loyiha_5gr", true, { parts: ["loyiha"] }),
      "eko.pdf": verdict("ekologik_paket", true),
      "epb.pdf": verdict("epb_yer", true, { parts: ["epb"] }),
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
    expect(summary).toContain("Korxona ustavi va YeGRPO dan ko'chirma (Korxona ustavi) — Ustav.pdf");
    expect(summary).toContain("Korxona ustavi va YeGRPO dan ko'chirma (YeGRPO dan ko'chirma) (egrpo.pdf): ko'chirma 3 oydan eski");
    expect(summary).toContain("pasport.jpg: bu hujjat talab qilinadigan hujjatlar ro'yxatida yo'q");
    expect(summary).toContain("old.doc: bu formatdagi faylni tekshirib bo'lmaydi");
    expect(summary).toMatch(/⏳[^\n]*qayta tekshiriladi:\n• yer\.pdf/);
    expect(summary).toContain("Tayyor: 40% (2/5) · Xato: 20% (1) · Yetishmaydi: 40% (2)");
    expect(summary).toContain("🟡 3. Loyiha hujjatlari");
    expect(summary).toContain("🟡 5. Sanoat xavfsizligi ekspertizasi (EPB) dalolatnomalari va yer ajratmasi to'g'risidagi qarorlar — yetishmaydi: Yer ajratmasi to'g'risidagi qaror");

    const dir = h.clientDir();
    expect(fs.readdirSync(path.join(dir, "accepted")).sort()).toEqual(
      ["anketa", "ekologik_paket", "epb_yer", "loyiha_5gr", "ruxsatnoma_kelishuv", "ustav_egrpo"].sort(),
    );
    expect(fs.readdirSync(path.join(dir, "accepted", "loyiha_5gr"))).toHaveLength(2);
    const rejected = fs.readdirSync(path.join(dir, "rejected"));
    expect(rejected.filter((f) => f !== "reasons.jsonl")).toHaveLength(3);
    expect(fs.readFileSync(path.join(dir, "rejected", "reasons.jsonl"), "utf8")).toContain("3 oydan eski");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8")).applicant.company).toBe("Oltin Kon MChJ");
    // yer.pdf waits in the inbox for another attempt.
    expect(h.assistant.inbox.read(CLIENT_ID).files.map((f) => [f.name, f.attempts])).toEqual([["yer.pdf", 1]]);

    // The package is not complete, so the admin is sent nothing at all.
    expect(h.api.calls.filter((c) => Number(c.payload.chat_id) === OWNER_ID)).toHaveLength(0);

    // Next round: yer.pdf is checked again, and the register extract sent again on its own completes document 1.
    h.api.clear();
    h.generator.fallback = answerByName({
      "yer.pdf": verdict("epb_yer", true, { parts: ["yer"] }),
      "egrpo-yangi.pdf": verdict("ustav_egrpo", true, { parts: ["egrpo"] }),
    });
    await h.send(h.directMessage(null, { file: pdf("egrpo-yangi.pdf") }));
    await h.flush();
    const second = String(h.api.sentTo(CLIENT_ID).at(-1)?.payload.text);
    expect(second).toContain("✅ 1. Korxona ustavi va YeGRPO dan ko'chirma");
    expect(second).toContain("✅ 5. Sanoat xavfsizligi");
    expect(second).toContain("Tayyor: 80% (4/5)");
    expect(h.api.calls.filter((c) => Number(c.payload.chat_id) === OWNER_ID)).toHaveLength(0);

    // The status request shows the same figures without calling Claude.
    h.api.clear();
    const calls = h.generator.calls.length;
    await h.send(h.directMessage("holat"));
    expect(h.generator.calls).toHaveLength(calls);
    expect(String(h.api.sentTo(CLIENT_ID)[0]?.payload.text)).toContain("Tayyor: 80% (4/5)");
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
    expect(h.api.calls.filter((c) => Number(c.payload.chat_id) === OWNER_ID)).toHaveLength(0);
  });

  it("keeps an accepted part when a wrong copy comes later", async () => {
    const h = makeHarness();
    h.generator.push(verdict("ustav_egrpo", true), verdict("ustav_egrpo", false, { reasons: ["muhr yo'q"] }));
    await h.send(h.directMessage(null, { file: pdf("ustav.pdf") }));
    await h.flush();
    await h.send(h.directMessage(null, { file: pdf("ustav2.pdf") }));
    await h.flush();
    expect(h.assistant.clientProgressText(CLIENT_ID, "uz")).toContain("✅ 1. Korxona ustavi va YeGRPO dan ko'chirma");
  });

  it("does not send summaries to the client in preview mode but still saves the files", async () => {
    const h = makeHarness({ AUTO_SEND: "false" });
    h.generator.push(verdict("ekologik_paket", true));
    await h.send(h.directMessage(null, { file: pdf("eko.pdf") }));
    await h.flush();
    expect(h.api.sentTo(CLIENT_ID)).toHaveLength(0);
    expect(h.previews.at(-1)?.reply).toContain("Ekologik paket (ZVOS/ZEP, PDV, limitlar) — eko.pdf");
    expect(fs.readdirSync(path.join(h.clientDir(), "accepted", "ekologik_paket"))).toHaveLength(1);
    expect(h.api.calls.filter((c) => Number(c.payload.chat_id) === OWNER_ID)).toHaveLength(0);
  });

  it("accepts files over 20 MB through the large-file download", async () => {
    const h = makeHarness();
    h.generator.push(verdict("loyiha_5gr", true));
    await h.send(h.directMessage(null, { file: { name: "TIA-katta.pdf", data: Buffer.from("%PDF big"), size: 85 * 1024 * 1024 } }));
    await h.send(h.directMessage(null, { file: { name: "kichik.pdf", data: Buffer.from("%PDF small") } }));
    await h.flush();
    expect(h.largeDownloads).toHaveLength(1);
    expect(h.generator.calls).toHaveLength(2);
    expect(String(h.api.sentTo(CLIENT_ID).at(-1)?.payload.text)).toContain("TIA-katta.pdf");
    expect(fs.readdirSync(path.join(h.clientDir(), "accepted", "loyiha_5gr"))).toHaveLength(1);
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
    h.generator.push(verdict("ustav_egrpo", true), new ClaudeLimitError("usage limit", h.clock.t + 3600, null));
    for (const name of ["a.pdf", "b.pdf", "c.pdf"]) await h.send(h.directMessage(null, { file: pdf(name) }));
    await h.flush();
    expect(h.generator.calls).toHaveLength(2);
    expect(h.assistant.inbox.read(CLIENT_ID).files.map((f) => f.name)).toEqual(["b.pdf", "c.pdf"]);
    expect(String(h.api.sentTo(CLIENT_ID).at(-1)?.payload.text)).toContain("Qolgan 2 ta fayl birozdan keyin");

    h.restart();
    h.clock.advance(3601);
    h.generator.push(verdict("loyiha_5gr", true), verdict("ruxsatnoma_kelishuv", true));
    await h.flush();
    expect(h.generator.calls).toHaveLength(4);
    expect(h.assistant.inbox.read(CLIENT_ID).files).toHaveLength(0);
    expect(h.assistant.clientProgressText(CLIENT_ID, "uz")).toContain("Tayyor: 60% (3/5)");
  });

  it("reviews files sent to the business account and answers through it", async () => {
    const h = makeHarness();
    h.setConnection();
    h.generator.push(verdict("ustav_egrpo", true));
    await h.send(h.businessMessage(null, pdf("ustav.pdf")));
    await h.flush();
    const summary = h.api.sentTo(CLIENT_ID).at(-1);
    expect(summary?.payload.business_connection_id).toBe(CONNECTION_ID);
    expect(String(summary?.payload.text)).toContain("Korxona ustavi va YeGRPO dan ko'chirma — ustav.pdf");
  });

  it("reviews photos too", async () => {
    const h = makeHarness();
    h.generator.push(verdict("ruxsatnoma_kelishuv", true, { parts: ["ruxsatnoma"] }));
    await h.send(h.directMessage(null, { photo: Buffer.from("jpeg") }));
    await h.flush();
    expect(h.generator.calls[0]?.files).toEqual(["document.jpg"]);
    expect(h.assistant.clientProgressText(CLIENT_ID, "uz")).toContain("🟡 2. Yer qa'ridan foydalanish ruxsatnomasi");
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
    h.generator.push("Anketani yuboraman, 5 ta hujjatni yuboring. [SEND_TEMPLATE]");
    await h.send(h.directMessage("Konimizga investor kerak"));
    const text = h.api.sentTo(CLIENT_ID).map((c) => String(c.payload.text));
    expect(text).toEqual(["Anketani yuboraman, 5 ta hujjatni yuboring."]);
    expect(h.api.sentTo(CLIENT_ID, "sendDocument")).toHaveLength(1);
    expect(h.generator.calls[0]?.system).toContain("[SEND_TEMPLATE]");
    expect(h.generator.calls[0]?.system).toContain("the 5 documents listed at its end");
  });

  it("sends the Russian form with the list of 5 documents on request, without Claude", async () => {
    const h = makeHarness();
    await h.send(h.directMessage("Анкета"));
    expect(h.generator.calls).toHaveLength(0);
    const caption = String(h.api.sentTo(CLIENT_ID, "sendDocument")[0]?.payload.caption);
    expect(caption).toContain("5 документов");
    expect(caption).toContain("5) акты ЭПБ и решения на земельный отвод");
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
    h.generator.push("Javob", verdict("ustav_egrpo", true));
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
    expect(String(last?.payload.text)).toContain("Tayyor: 20% (1/5)");
    const buttons = (last?.payload.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard
      .flat()
      .map((b) => b.callback_data);
    expect(buttons).toEqual([`reply:${CLIENT_ID}`, `chattxt:${CLIENT_ID}`, `files:${CLIENT_ID}`, `delete:${CLIENT_ID}`]);

    await h.send(h.callback(`chattxt:${CLIENT_ID}`));
    expect(h.api.sentTo(OWNER_ID, "sendDocument").at(-1)?.payload.caption).toContain("yozishma");
    await h.send(h.callback(`files:${CLIENT_ID}`));
    expect(String(h.api.sentTo(OWNER_ID, "sendDocument").at(-1)?.payload.caption)).toBe("✅ Korxona ustavi va YeGRPO dan ko'chirma");

    expect(h.assistant.usersListMessages()[0]?.text ?? "").toContain("📊 20%");
  });
});
