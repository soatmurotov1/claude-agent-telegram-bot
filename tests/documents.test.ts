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

describe("template", () => {
  it("lists the questionnaire and the documents of its step 3", () => {
    expect(template.documents.map((d) => d.key)).toEqual([
      "anketa",
      "ustav",
      "egrpo",
      "ruxsatnoma",
      "litsenziya_kelishuvi",
      "loyiha_hujjatlari",
      "5gr_tasdiq",
      "ekologik_paket",
      "epb_dalolatnoma",
      "yer_ajratmasi",
    ]);
    for (const doc of template.documents) {
      expect(doc.checks.length).toBeGreaterThan(0);
      expect(doc.title.uz && doc.title.ru && doc.title.en).toBeTruthy();
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
  const status = (docs: ClientStatus["docs"], naItems: number[] = []): ClientStatus => ({
    template: template.id,
    applicant: { company: "Test MChJ", direction: "A", naItems },
    docs,
  });
  const record = (state: "accepted" | "rejected", reasons: string[] = []) => ({ state, files: ["f"], reasons, ts: 1 });

  it("counts ready, wrong and missing documents in percent", () => {
    const p = progress(
      status({
        anketa: record("accepted"),
        ustav: record("accepted"),
        egrpo: record("rejected", ["eski"]),
        ruxsatnoma: record("accepted"),
      }),
      template,
    );
    expect(p).toMatchObject({ total: 10, accepted: 3, rejected: 1, missing: 6, readyPct: 30, errorPct: 10, missingPct: 60 });
    const text = progressText(p, "uz");
    expect(text).toContain("Tayyor: 30% (3/10)");
    expect(text).toContain("Xato: 10% (1)");
    expect(text).toContain("❌ YeGRPO dan ko'chirma: eski");
    expect(text).toContain("✅ Korxona ustavi");
  });

  it("does not require documents of items marked NA", () => {
    const p = progress(status({ anketa: record("accepted") }, [7, 8]), template);
    expect(p.total).toBe(8);
    expect(p.items.filter((i) => i.state === "na").map((i) => i.doc.key)).toEqual(["ekologik_paket", "epb_dalolatnoma"]);
    expect(progressText(p, "ru")).toContain("➖ Экологический пакет (ЗВОС/ЗЭП, ПДВ, лимиты) (не требуется)");
  });

  it("shows 0% for a new client", () => {
    const p = progress({ template: "", applicant: null, docs: {} }, template);
    expect(p).toMatchObject({ total: 10, readyPct: 0, errorPct: 0, missingPct: 100 });
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
    zip.file("xl/sharedStrings.xml", '<sst><si><t>Компания</t></si><si><t>ООО Тест</t></si></sst>');
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
  it("reads the JSON even with text around it", () => {
    const answer = parseReview(`Here: ${verdict("ustav", true)} done`, template);
    expect(answer).toMatchObject({ doc: "ustav", verdict: "accepted", reasons: [] });
  });

  it("never accepts a file that is none of the listed documents", () => {
    expect(parseReview(verdict("passport", true), template)).toMatchObject({ doc: null, verdict: "rejected" });
  });

  it("keeps the applicant only for the questionnaire", () => {
    const applicant = { company: "Oltin Kon MChJ", direction: "B", na_items: [7, 99] };
    expect(parseReview(verdict("anketa", true, [], applicant), template).applicant).toEqual({
      company: "Oltin Kon MChJ",
      direction: "B",
      naItems: [7],
    });
    expect(parseReview(verdict("ustav", true, [], applicant), template).applicant).toBeNull();
  });

  it("throws on answers without a verdict", () => {
    expect(() => parseReview("I cannot read this file", template)).toThrow();
    expect(() => parseReview('{"doc": "ustav"}', template)).toThrow();
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
  it("reviews many files as one batch and saves them by result", async () => {
    const h = makeHarness();
    const names = [
      "anketa.docx",
      "Ustav.pdf",
      "egrpo.pdf",
      "ruxsatnoma.jpg",
      "kelishuv.pdf",
      "pasport.jpg",
      "loyiha1.pdf",
      "loyiha2.pdf",
      "5gr.pdf",
      "eko.pdf",
      "epb.pdf",
      "yer.pdf",
    ];
    const answers: Record<string, string> = {
      "anketa.docx": verdict("anketa", true, [], { company: "Oltin Kon MChJ", direction: "B", na_items: [] }),
      "Ustav.pdf": verdict("ustav", true),
      "egrpo.pdf": verdict("egrpo", false, ["ko'chirma 3 oydan eski"]),
      "ruxsatnoma.jpg": verdict("ruxsatnoma", true),
      "kelishuv.pdf": verdict("litsenziya_kelishuvi", false, ["imzo yo'q"]),
      "pasport.jpg": verdict(null, false),
      "loyiha1.pdf": verdict("loyiha_hujjatlari", true),
      "loyiha2.pdf": verdict("loyiha_hujjatlari", true),
      "5gr.pdf": verdict("5gr_tasdiq", true),
      "eko.pdf": verdict("ekologik_paket", true),
      "epb.pdf": verdict("epb_dalolatnoma", true),
      "yer.pdf": "not json at all",
    };
    h.generator.fallback = (_system, user) => {
      const name = /File name as sent by the client: (.+)/.exec(user)?.[1]?.trim() ?? "";
      return answers[name] ?? "??";
    };

    for (const name of names) {
      const data = name.endsWith(".docx") ? await filledQuestionnaire() : Buffer.from(`%PDF fake ${name}`);
      await h.send(h.directMessage(null, { file: { name, data } }));
    }
    expect(h.assistant.outcomes.filter((o) => o === "review_queued")).toHaveLength(12);
    expect(h.generator.calls).toHaveLength(0);
    await h.flush();

    // The docx text went into the prompt; PDFs and images were opened by Claude in a folder with only that file.
    expect(h.generator.calls).toHaveLength(12);
    const docxCall = h.generator.calls.find((c) => c.user.includes("anketa.docx"));
    expect(docxCall?.dir).toBeUndefined();
    expect(docxCall?.user).toContain("☒");
    for (const call of h.generator.calls.filter((c) => c.dir)) {
      expect(call.files).toHaveLength(1);
      expect(fs.existsSync(call.dir ?? "")).toBe(false);
    }
    expect(h.generator.calls[0]?.system).toContain('key "egrpo"');
    expect(h.generator.calls[0]?.system).toContain("ZRU-987");

    // One "checking" note and one summary to the client.
    const toClient = h.api.sentTo(CLIENT_ID).map((c) => String(c.payload.text));
    expect(toClient).toHaveLength(2);
    const summary = toClient[1] ?? "";
    expect(summary).toContain("12 ta faylingiz");
    expect(summary).toContain("✅ Qabul qilindi:");
    expect(summary).toContain("Korxona ustavi — Ustav.pdf");
    expect(summary).toContain("YeGRPO dan ko'chirma (egrpo.pdf): ko'chirma 3 oydan eski");
    expect(summary).toContain("pasport.jpg: bu hujjat talab qilinadigan hujjatlar ro'yxatida yo'q");
    expect(summary).toContain("⚠️");
    expect(summary).toContain("yer.pdf");
    expect(summary).toContain("Tayyor: 70% (7/10)");
    expect(summary).toContain("Xato: 20% (2)");

    const dir = h.clientDir();
    expect(fs.readdirSync(path.join(dir, "accepted")).sort()).toEqual(
      ["5gr_tasdiq", "anketa", "ekologik_paket", "epb_dalolatnoma", "loyiha_hujjatlari", "ruxsatnoma", "ustav"].sort(),
    );
    expect(fs.readdirSync(path.join(dir, "accepted", "loyiha_hujjatlari"))).toHaveLength(2);
    const rejected = fs.readdirSync(path.join(dir, "rejected"));
    expect(rejected.filter((f) => f !== "reasons.jsonl")).toHaveLength(4);
    expect(fs.readFileSync(path.join(dir, "rejected", "reasons.jsonl"), "utf8")).toContain("imzo yo'q");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8")).applicant.company).toBe("Oltin Kon MChJ");
    expect(fs.readdirSync(path.join(dir, "inbox")).filter((f) => f !== "inbox.json")).toHaveLength(0);

    // The owner gets a short note with the folder buttons, and the file that could not be checked.
    const note = h.api.sentTo(OWNER_ID).map((c) => String(c.payload.text)).find((t) => t.includes("ta fayl tekshirildi"));
    expect(note).toContain("12 ta fayl tekshirildi — ✅ 8, ❌ 3, ⚠️ 1 ta tekshirib bo'lmadi. Tayyor: 70%.");
    const docs = h.api.sentTo(OWNER_ID, "sendDocument");
    expect(docs).toHaveLength(1);
    expect(String(docs[0]?.payload.caption)).toContain("Tekshirib bo'lmadi");

    // The status request shows the same figures without calling Claude.
    h.api.clear();
    await h.send(h.directMessage("holat"));
    expect(h.generator.calls).toHaveLength(12);
    expect(String(h.api.sentTo(CLIENT_ID)[0]?.payload.text)).toContain("Tayyor: 70% (7/10)");
  });

  it("keeps an accepted document when a wrong copy comes later", async () => {
    const h = makeHarness();
    h.generator.push(verdict("ustav", true), verdict("ustav", false, ["muhr yo'q"]));
    await h.send(h.directMessage(null, { file: { name: "ustav.docx", data: await filledQuestionnaire() } }));
    await h.flush();
    await h.send(h.directMessage(null, { file: { name: "ustav2.docx", data: await filledQuestionnaire() } }));
    await h.flush();
    expect(h.assistant.clientProgressText(CLIENT_ID, "uz")).toContain("✅ Korxona ustavi");
  });

  it("does not send summaries in preview mode but still saves the files", async () => {
    const h = makeHarness({ AUTO_SEND: "false" });
    h.generator.push(verdict("egrpo", true));
    await h.send(h.directMessage(null, { file: { name: "egrpo.pdf", data: Buffer.from("%PDF") } }));
    await h.flush();
    expect(h.api.sentTo(CLIENT_ID)).toHaveLength(0);
    expect(h.previews.at(-1)?.reply).toContain("YeGRPO dan ko'chirma — egrpo.pdf");
    expect(fs.readdirSync(path.join(h.clientDir(), "accepted", "egrpo"))).toHaveLength(1);
    const note = String(h.api.sentTo(OWNER_ID).at(-1)?.payload.text);
    expect(note).toContain("Mijozga yuborilmadi");
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
    h.generator.push(verdict("ustav", true), new ClaudeLimitError("usage limit", h.clock.t + 3600, null));
    for (const name of ["a.pdf", "b.pdf", "c.pdf"]) {
      await h.send(h.directMessage(null, { file: { name, data: Buffer.from("%PDF") } }));
    }
    await h.flush();
    expect(h.generator.calls).toHaveLength(2);
    expect(h.assistant.inbox.read(CLIENT_ID).files.map((f) => f.name)).toEqual(["b.pdf", "c.pdf"]);
    expect(String(h.api.sentTo(CLIENT_ID).at(-1)?.payload.text)).toContain("Qolgan 2 ta fayl birozdan keyin");

    h.restart();
    h.clock.advance(3601);
    h.generator.push(verdict("egrpo", true), verdict("ruxsatnoma", true));
    await h.flush();
    expect(h.generator.calls).toHaveLength(4);
    expect(h.assistant.inbox.read(CLIENT_ID).files).toHaveLength(0);
    expect(h.assistant.clientProgressText(CLIENT_ID, "uz")).toContain("Tayyor: 30% (3/10)");
  });

  it("reviews files sent to the business account and answers through it", async () => {
    const h = makeHarness();
    h.setConnection();
    h.generator.push(verdict("ustav", true));
    await h.send(h.businessMessage(null, { name: "ustav.pdf", data: Buffer.from("%PDF") }));
    await h.flush();
    const summary = h.api.sentTo(CLIENT_ID).at(-1);
    expect(summary?.payload.business_connection_id).toBe(CONNECTION_ID);
    expect(String(summary?.payload.text)).toContain("Korxona ustavi — ustav.pdf");
  });

  it("reviews photos too", async () => {
    const h = makeHarness();
    h.generator.push(verdict("ruxsatnoma", true));
    await h.send(h.directMessage(null, { photo: Buffer.from("jpeg") }));
    await h.flush();
    expect(h.generator.calls[0]?.files).toEqual(["document.jpg"]);
    expect(h.assistant.clientProgressText(CLIENT_ID, "uz")).toContain("✅ Yer qa'ridan foydalanish ruxsatnomasi");
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
    h.generator.push("Anketani yuboraman, to'ldirib qaytaring. [SEND_TEMPLATE]");
    await h.send(h.directMessage("Konimizga investor kerak"));
    const text = h.api.sentTo(CLIENT_ID).map((c) => String(c.payload.text));
    expect(text).toEqual(["Anketani yuboraman, to'ldirib qaytaring."]);
    expect(h.api.sentTo(CLIENT_ID, "sendDocument")).toHaveLength(1);
    expect(h.generator.calls[0]?.system).toContain("[SEND_TEMPLATE]");
  });

  it("sends the Russian form on request without Claude", async () => {
    const h = makeHarness();
    await h.send(h.directMessage("Анкета"));
    expect(h.generator.calls).toHaveLength(0);
    const doc = h.api.sentTo(CLIENT_ID, "sendDocument")[0];
    expect(String(doc?.payload.caption)).toContain("Заполните анкету");
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
    h.generator.push("Javob", verdict("ustav", true));
    await h.send(h.directMessage("Salom"));
    await h.send(h.directMessage(null, { file: { name: "ustav.pdf", data: Buffer.from("%PDF") } }));
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
    const ask = h.api.sentTo(OWNER_ID).at(-1);
    expect(String(ask?.payload.text)).toContain("O'chirilsinmi?");
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
    expect(String(last?.payload.text)).toContain("Tayyor: 10% (1/10)");
    const buttons = (last?.payload.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard
      .flat()
      .map((b) => b.callback_data);
    expect(buttons).toEqual([`reply:${CLIENT_ID}`, `chattxt:${CLIENT_ID}`, `files:${CLIENT_ID}`, `delete:${CLIENT_ID}`]);

    await h.send(h.callback(`chattxt:${CLIENT_ID}`));
    expect(h.api.sentTo(OWNER_ID, "sendDocument").at(-1)?.payload.caption).toContain("yozishma");
    await h.send(h.callback(`files:${CLIENT_ID}`));
    expect(String(h.api.sentTo(OWNER_ID, "sendDocument").at(-1)?.payload.caption)).toBe("✅ ustav");

    const list = h.assistant.usersListMessages()[0]?.text ?? "";
    expect(list).toContain("📊 10%");
  });
});
