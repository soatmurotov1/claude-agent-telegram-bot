import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeLimitError } from "../src/claudeCli.js";
import { type ClientStatus, progress, progressText, safeFileName } from "../src/clientFolder.js";
import { docxText, fileKind, parseReview, xlsxText } from "../src/documentReview.js";
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
        ustav_egrpo: { files: ["a"], parts: { ustav: part("accepted"), egrpo: part("accepted") } },
        ruxsatnoma_kelishuv: { files: ["b"], parts: { ruxsatnoma: part("accepted"), kelishuv: part("rejected", ["imzo yo'q"]) } },
        loyiha_5gr: { files: ["c"], parts: { loyiha: part("accepted") } },
        anketa: { files: ["d"], parts: { anketa: part("accepted") } },
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
      status({ ustav_egrpo: { files: ["a"], parts: { ustav: part("accepted") } } }, [2, 7, 8, 9]),
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

describe("document batches", () => {
  it("checks the 5 files, sends the ready ones to the admin and says when all are ready", async () => {
    const h = makeHarness();
    h.generator.fallback = answerByName({
      "1-ustav-egrpo.pdf": verdict("ustav_egrpo", true),
      "2-litsenziya.pdf": verdict("ruxsatnoma_kelishuv", true),
      "3-loyiha.pdf": verdict("loyiha_5gr", true),
      "4-eko.pdf": verdict("ekologik_paket", true),
      "5-epb-yer.pdf": verdict("epb_yer", true),
    });
    for (const name of ["1-ustav-egrpo.pdf", "2-litsenziya.pdf", "3-loyiha.pdf", "4-eko.pdf", "5-epb-yer.pdf"]) {
      await h.send(h.directMessage(null, { file: pdf(name) }));
    }
    expect(h.assistant.outcomes.filter((o) => o === "review_queued")).toHaveLength(5);
    expect(h.generator.calls).toHaveLength(0);
    await h.flush();

    // Each file was opened by Claude in a folder holding only that file, which is removed afterwards.
    expect(h.generator.calls).toHaveLength(5);
    for (const call of h.generator.calls) {
      expect(call.files).toEqual(["document.pdf"]);
      expect(fs.existsSync(call.dir ?? "")).toBe(false);
    }
    expect(h.generator.calls[0]?.system).toContain('part "egrpo"');
    expect(h.generator.calls[0]?.system).toContain("ZRU-987");

    const summary = String(h.api.sentTo(CLIENT_ID).at(-1)?.payload.text);
    expect(summary).toContain("5 ta faylingiz");
    expect(summary).toContain("Tayyor: 100% (5/5)");
    expect(summary).toContain("Barcha hujjatlar qabul qilindi va mutaxassisimizga yuborildi.");

    // The admin gets the note, the 5 ready files, then the completion message.
    const toOwner = h.api.calls.filter((c) => Number(c.payload.chat_id) === OWNER_ID);
    expect(toOwner.map((c) => c.method)).toEqual([
      "sendMessage",
      "sendDocument",
      "sendDocument",
      "sendDocument",
      "sendDocument",
      "sendDocument",
      "sendMessage",
    ]);
    expect(String(toOwner[0]?.payload.text)).toContain("5 ta fayl tekshirildi — ✅ 5, ❌ 0. Tayyor: 100% (5/5).");
    expect(String(toOwner[1]?.payload.caption)).toBe("✅ Korxona ustavi va YeGRPO dan ko'chirma (Korxona ustavi, YeGRPO dan ko'chirma)\n👤 Aziz @user2000");
    expect(String(toOwner[6]?.payload.text)).toContain("🎉 Aziz @user2000: barcha 5 ta hujjat tayyor (100%)");

    // The completion message is sent only once.
    h.api.clear();
    h.generator.push(verdict("anketa", true));
    await h.send(h.directMessage(null, { file: { name: "anketa.docx", data: await filledQuestionnaire() } }));
    await h.flush();
    expect(h.api.sentTo(OWNER_ID).some((c) => String(c.payload.text).includes("🎉"))).toBe(false);
    expect(h.api.sentTo(OWNER_ID, "sendDocument")).toHaveLength(1);
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
    expect(summary).toMatch(/⚠️[^\n]*\n• yer\.pdf/);
    expect(summary).toContain("Tayyor: 40% (2/5) · Xato: 20% (1) · Yetishmaydi: 40% (2)");
    expect(summary).toContain("🟡 3. Loyiha hujjatlari");
    expect(summary).toContain("🟡 5. Sanoat xavfsizligi ekspertizasi (EPB) dalolatnomalari va yer ajratmasi to'g'risidagi qarorlar — yetishmaydi: Yer ajratmasi to'g'risidagi qaror");

    const dir = h.clientDir();
    expect(fs.readdirSync(path.join(dir, "accepted")).sort()).toEqual(
      ["anketa", "ekologik_paket", "epb_yer", "loyiha_5gr", "ruxsatnoma_kelishuv", "ustav_egrpo"].sort(),
    );
    expect(fs.readdirSync(path.join(dir, "accepted", "loyiha_5gr"))).toHaveLength(2);
    const rejected = fs.readdirSync(path.join(dir, "rejected"));
    expect(rejected.filter((f) => f !== "reasons.jsonl")).toHaveLength(4);
    expect(fs.readFileSync(path.join(dir, "rejected", "reasons.jsonl"), "utf8")).toContain("3 oydan eski");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8")).applicant.company).toBe("Oltin Kon MChJ");
    expect(fs.readdirSync(path.join(dir, "inbox")).filter((f) => f !== "inbox.json")).toHaveLength(0);

    // The admin: the note, the 8 accepted files, then the file that could not be checked.
    const note = h.api.sentTo(OWNER_ID).map((c) => String(c.payload.text)).find((t) => t.includes("ta fayl tekshirildi"));
    expect(note).toContain("12 ta fayl tekshirildi — ✅ 8, ❌ 3, ⚠️ 1 ta tekshirib bo'lmadi. Tayyor: 40% (2/5).");
    const docs = h.api.sentTo(OWNER_ID, "sendDocument").map((c) => String(c.payload.caption));
    expect(docs).toHaveLength(9);
    expect(docs.filter((c) => c.startsWith("✅"))).toHaveLength(8);
    expect(docs.at(-1)).toContain("Tekshirib bo'lmadi");

    // The register extract sent again on its own completes document 1.
    h.api.clear();
    h.generator.fallback = answerByName({ "egrpo-yangi.pdf": verdict("ustav_egrpo", true, { parts: ["egrpo"] }) });
    await h.send(h.directMessage(null, { file: pdf("egrpo-yangi.pdf") }));
    await h.flush();
    expect(String(h.api.sentTo(CLIENT_ID).at(-1)?.payload.text)).toContain("✅ 1. Korxona ustavi va YeGRPO dan ko'chirma");

    // The status request shows the same figures without calling Claude.
    h.api.clear();
    const calls = h.generator.calls.length;
    await h.send(h.directMessage("holat"));
    expect(h.generator.calls).toHaveLength(calls);
    expect(String(h.api.sentTo(CLIENT_ID)[0]?.payload.text)).toContain("Tayyor: 60% (3/5)");
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

  it("does not send summaries to the client in preview mode but saves the files and sends them to the admin", async () => {
    const h = makeHarness({ AUTO_SEND: "false" });
    h.generator.push(verdict("ekologik_paket", true));
    await h.send(h.directMessage(null, { file: pdf("eko.pdf") }));
    await h.flush();
    expect(h.api.sentTo(CLIENT_ID)).toHaveLength(0);
    expect(h.previews.at(-1)?.reply).toContain("Ekologik paket (ZVOS/ZEP, PDV, limitlar) — eko.pdf");
    expect(fs.readdirSync(path.join(h.clientDir(), "accepted", "ekologik_paket"))).toHaveLength(1);
    expect(String(h.api.sentTo(OWNER_ID)[0]?.payload.text)).toContain("Mijozga yuborilmadi");
    expect(h.api.sentTo(OWNER_ID, "sendDocument")).toHaveLength(1);
  });

  it("rejects formats it cannot read and files over 20 MB without calling Claude", async () => {
    const h = makeHarness();
    await h.send(h.directMessage(null, { file: { name: "eski.doc", data: Buffer.from("x") } }));
    await h.send(h.directMessage(null, { file: { name: "katta.pdf", data: Buffer.from("x"), size: 25 * 1024 * 1024 } }));
    await h.flush();
    expect(h.generator.calls).toHaveLength(0);
    const texts = h.api.sentTo(CLIENT_ID).map((c) => String(c.payload.text));
    expect(texts.some((t) => t.includes("katta.pdf") && t.includes("20 MB"))).toBe(true);
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
