import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClientFolders, safeFileName, statusText } from "../src/clientFolder.js";
import { decodeFileId, encodeFileId, FileIdError } from "../src/largeFiles.js";
import { splitTemplate } from "../src/prompts.js";
import { quickRequest } from "../src/service.js";
import { blankFor, loadTemplate } from "../src/templates.js";
import { CLIENT_ID, CONNECTION_ID, cleanupHarnesses, makeHarness, OWNER_ID, PROJECT_DIR } from "./harness.js";

const TEMPLATES = path.join(PROJECT_DIR, "templates");
const template = loadTemplate(TEMPLATES);

afterEach(cleanupHarnesses);

const pdf = (name: string) => ({ name, data: Buffer.from(`%PDF fake ${name}`) });
/** "f01.pdf" … "f14.pdf". */
const names = (from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => `f${String(from + i).padStart(2, "0")}.pdf`);

describe("template", () => {
  it("lists the 14 documents a package consists of; the questionnaire with the NDA is offered but not counted", () => {
    expect(template.documents.map((d) => d.key)).toEqual([
      "ustav",
      "egrpo",
      "ruxsatnoma",
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
    ]);
    const required = template.documents.filter((d) => d.required);
    expect(required).toHaveLength(14);
    expect(required.at(-1)?.key).toBe("yer");
    expect(required[2]?.title.uz).toBe("Yer qa'ridan foydalanish uchun elektron ruxsatnoma / litsenziya");
    expect(template.documents.at(-1)?.title.uz).toContain("NDA");
    expect(template.documents.at(-1)?.required).toBe(false);
  });

  it("gives Uzbek speakers the Uzbek form and Russian and English speakers the Russian one", () => {
    expect(path.basename(blankFor(template, "uz") ?? "")).toBe("uz.docx");
    expect(path.basename(blankFor(template, null) ?? "")).toBe("uz.docx");
    expect(path.basename(blankFor(template, "ru") ?? "")).toBe("ru.docx");
    expect(path.basename(blankFor(template, "en") ?? "")).toBe("ru.docx");
  });
});

describe("status and client folder", () => {
  it("shows how many files arrived and lists the documents as a reminder", () => {
    const titles = template.documents.filter((d) => d.required).map((d) => d.title.uz);
    const text = statusText(5, 14, titles, "uz");
    expect(text).toContain("Qabul qilingan fayllar: 5/14");
    expect(text).toContain("Yana 9 ta fayl yuboring.");
    expect(text).toContain("1. Korxona ustavi");
    expect(text).toContain("14. Yer ajratmasi to'g'risidagi qarorlar");
    expect(text).not.toContain("NDA");
    expect(statusText(0, 14, [], "ru")).toContain("Получено файлов: 0/14");
    const marked = statusText(3, 12, titles, "uz", { missing: new Set([9, 12]), hint: true });
    expect(marked).toContain("Qabul qilingan fayllar: 3/12");
    expect(marked).toContain("«Menda yo'q» deb belgilangan: 2 ta hujjat");
    expect(marked).toContain("10. ❌ Ekologik paket: ZEP — yo'q");
    expect(marked).toContain("«❌ Menda yo'q hujjatlar» tugmasini bosing");
    const done = statusText(15, 14, titles, "uz");
    expect(done).toContain("Qabul qilingan fayllar: 14/14");
    expect(done).toContain("Barcha fayllar qabul qilindi va mutaxassisimizga yuborildi.");
    expect(done).not.toContain("Kerakli hujjatlar");
  });

  it("saves and counts files, and marks the package sent once", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "folders-"));
    try {
      const folders = new ClientFolders(path.join(dir, "clients"), () => 1_800_000_000);
      const source = path.join(dir, "upload");
      fs.writeFileSync(source, "x");
      expect(folders.receive(7, source, "Ustav.pdf", "file-1")).toBe(1);
      // The same name in the same second does not overwrite the first file.
      expect(folders.receive(7, source, "Ustav.pdf")).toBe(2);
      const files = folders.receivedFiles(7);
      expect(files.map((f) => [f.number, f.name, f.fileId])).toEqual([
        [1, "Ustav.pdf", "file-1"],
        [2, "Ustav.pdf", undefined],
      ]);
      expect(new Set(files.map((f) => f.file)).size).toBe(2);
      expect(folders.markPackageSent(7)).toBe(true);
      expect(folders.markPackageSent(7)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts the files of the earlier checked layout, a file of several documents once", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "folders-"));
    try {
      const folders = new ClientFolders(dir, () => 1);
      const client = folders.dir(9);
      for (const doc of ["ustav", "egrpo", "zvos"]) fs.mkdirSync(path.join(client, "accepted", doc), { recursive: true });
      fs.writeFileSync(path.join(client, "accepted", "ustav", "20261101-100000_ustav-egrpo.pdf"), "a");
      fs.writeFileSync(path.join(client, "accepted", "egrpo", "20261101-100000_ustav-egrpo.pdf"), "a");
      fs.writeFileSync(path.join(client, "accepted", "zvos", "20261101-100100_zvos.pdf"), "b");
      const record = (file: string) => ({ files: [file], fileIds: { [file]: "file-9" }, parts: {} });
      fs.writeFileSync(
        path.join(client, "status.json"),
        JSON.stringify({
          docs: {
            ustav: record("20261101-100000_ustav-egrpo.pdf"),
            egrpo: record("20261101-100000_ustav-egrpo.pdf"),
            zvos: record("20261101-100100_zvos.pdf"),
          },
          completedAt: 5,
        }),
      );
      expect(folders.receivedFiles(9).map((f) => f.name)).toEqual(["ustav-egrpo.pdf", "zvos.pdf"]);
      expect(folders.status(9).packageSentAt).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps Cyrillic in saved file names and drops path parts", () => {
    expect(safeFileName("../../Устав 2026.pdf")).toBe("Устав 2026.pdf");
    expect(safeFileName("a<b>:c|d?.docx")).toBe("a_b_c_d_.docx");
  });
});

describe("quick requests", () => {
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
    expect(quickRequest("❌ Menda yo'q hujjatlar")).toBe("missing");
    expect(quickRequest("Menda yo‘q hujjatlar")).toBe("missing");
    expect(quickRequest("anketani qanday to'ldiraman")).toBeNull();
    expect(quickRequest("menda yo'q")).toBeNull();
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

describe("file batches", () => {
  const toOwner = (h: ReturnType<typeof makeHarness>) => h.api.calls.filter((c) => Number(c.payload.chat_id) === OWNER_ID);
  const media = (call: { payload: Record<string, unknown> } | undefined) =>
    (call?.payload.media ?? []) as { type: string; media: unknown; caption?: string }[];

  it("sends the admin nothing until 14 files arrived, then one message and every file in albums", async () => {
    const h = makeHarness();
    // 13 files over half an hour: the admin hears nothing, and Claude never sees a file.
    for (const name of names(1, 13)) {
      await h.send(h.directMessage(null, { file: pdf(name) }));
      h.clock.advance(120);
    }
    await h.flush();
    expect(h.generator.calls).toHaveLength(0);
    const before = String(h.api.sentTo(CLIENT_ID).at(-1)?.payload.text);
    expect(before).toContain("📥 13 ta fayl qabul qilindi:\n• f01.pdf");
    expect(before).toContain("Qabul qilingan fayllar: 13/14");
    expect(before).toContain("Yana 1 ta fayl yuboring.");
    expect(toOwner(h)).toHaveLength(0);
    h.api.clear();

    await h.send(h.directMessage(null, { file: pdf("f14.pdf") }));
    await h.flush();
    expect(h.generator.calls).toHaveLength(0);
    const summary = String(h.api.sentTo(CLIENT_ID).at(-1)?.payload.text);
    expect(summary).toContain("Qabul qilingan fayllar: 14/14");
    expect(summary).toContain("Barcha fayllar qabul qilindi va mutaxassisimizga yuborildi.");

    // One message, then the 14 files in two albums (10 + 4), by file_id (no re-upload, any size).
    const sent = toOwner(h);
    expect(sent.map((c) => c.method)).toEqual(["sendMessage", "sendMediaGroup", "sendMediaGroup"]);
    expect(String(sent[0]?.payload.text)).toContain("🎉 Yangi to'liq paket: Aziz @user2000");
    expect(String(sent[0]?.payload.text)).toContain("Mijoz 14 ta fayl yubordi");
    expect(String(sent[0]?.payload.text)).not.toContain("yo'q hujjatlar");
    const first = media(sent[1]);
    const second = media(sent[2]);
    expect(first).toHaveLength(10);
    expect(second).toHaveLength(4);
    for (const item of [...first, ...second]) {
      expect(item.type).toBe("document");
      expect(item.media).toMatch(/^file-\d+$/);
    }
    expect(first[0]?.caption).toBe("📄 1/14 — f01.pdf\n👤 Aziz @user2000");
    expect(second.at(-1)?.caption).toBe("📄 14/14 — f14.pdf\n👤 Aziz @user2000");
    expect(fs.readdirSync(path.join(h.clientDir(), "received"))).toHaveLength(14);

    // The package is announced once; a file that comes later is passed on as an extra.
    h.api.clear();
    await h.send(h.directMessage(null, { file: pdf("qoshimcha.pdf") }));
    await h.flush();
    const later = toOwner(h);
    expect(later.map((c) => c.method)).toEqual(["sendDocument"]);
    expect(String(later[0]?.payload.caption)).toBe("🔄 Qo'shimcha fayl (15-fayl): qoshimcha.pdf\n👤 Aziz @user2000");
  });

  it("sends every file when more than 14 arrive at once", async () => {
    const h = makeHarness();
    for (const name of names(1, 20)) await h.send(h.directMessage(null, { file: pdf(name) }));
    await h.flush();
    expect(String(h.api.sentTo(CLIENT_ID).at(-1)?.payload.text)).toContain("📥 20 ta fayl qabul qilindi");
    const sent = toOwner(h);
    expect(sent.map((c) => c.method)).toEqual(["sendMessage", "sendMediaGroup", "sendMediaGroup"]);
    expect(String(sent[0]?.payload.text)).toContain("Mijoz 20 ta fayl yubordi (kerak: 14 ta)");
    expect(media(sent[2]).at(-1)?.caption).toBe("📄 20/14 — f20.pdf\n👤 Aziz @user2000");
  });

  it("sends the files one by one when an album cannot be sent", async () => {
    const h = makeHarness();
    h.api.failMediaGroup = true;
    for (const name of names(1, 14)) await h.send(h.directMessage(null, { file: pdf(name) }));
    await h.flush();
    expect(toOwner(h).map((c) => c.method)).toEqual([
      "sendMessage",
      "sendMediaGroup",
      ...new Array(10).fill("sendDocument"),
      "sendMediaGroup",
      ...new Array(4).fill("sendDocument"),
    ]);
  });

  it("takes any format, photos included", async () => {
    const h = makeHarness();
    await h.send(h.directMessage(null, { file: { name: "eski.doc", data: Buffer.from("x") } }));
    await h.send(h.directMessage(null, { file: { name: "arxiv.zip", data: Buffer.from("x") } }));
    await h.send(h.directMessage(null, { photo: Buffer.from("jpeg") }));
    await h.flush();
    expect(h.generator.calls).toHaveLength(0);
    expect(h.assistant.clientProgressText(CLIENT_ID, "uz")).toContain("Qabul qilingan fayllar: 3/14");
  });

  it("does not send summaries to the client in preview mode but still saves the files", async () => {
    const h = makeHarness({ AUTO_SEND: "false" });
    await h.send(h.directMessage(null, { file: pdf("eko.pdf") }));
    await h.flush();
    expect(h.api.sentTo(CLIENT_ID)).toHaveLength(0);
    expect(h.previews.at(-1)?.reply).toContain("📥 1 ta fayl qabul qilindi:\n• eko.pdf");
    expect(fs.readdirSync(path.join(h.clientDir(), "received"))).toHaveLength(1);
    expect(toOwner(h)).toHaveLength(0);
  });

  it("accepts files over 20 MB through the large-file download", async () => {
    const h = makeHarness();
    await h.send(h.directMessage(null, { file: { name: "TIA-katta.pdf", data: Buffer.from("%PDF big"), size: 85 * 1024 * 1024 } }));
    await h.send(h.directMessage(null, { file: { name: "kichik.pdf", data: Buffer.from("%PDF small") } }));
    await h.flush();
    expect(h.largeDownloads).toHaveLength(1);
    expect(String(h.api.sentTo(CLIENT_ID).at(-1)?.payload.text)).toContain("TIA-katta.pdf");
    expect(fs.readdirSync(path.join(h.clientDir(), "received"))).toHaveLength(2);
  });

  it("refuses large files when the large-file download is not set up, and files over MAX_FILE_MB", async () => {
    const off = makeHarness({}, { largeFiles: false });
    await off.send(off.directMessage(null, { file: { name: "katta.pdf", data: Buffer.from("x"), size: 25 * 1024 * 1024 } }));
    await off.flush();
    expect(String(off.api.sentTo(CLIENT_ID).at(-1)?.payload.text)).toContain(
      "katta.pdf: 20 MB dan katta fayllarni qabul qilish hali sozlanmagan",
    );

    const capped = makeHarness({ MAX_FILE_MB: "30" });
    await capped.send(capped.directMessage(null, { file: { name: "juda-katta.pdf", data: Buffer.from("x"), size: 40 * 1024 * 1024 } }));
    await capped.flush();
    expect(capped.largeDownloads).toHaveLength(0);
    expect(String(capped.api.sentTo(CLIENT_ID).at(-1)?.payload.text)).toContain("juda-katta.pdf: fayl 30 MB dan katta");
    // A refused file is not counted.
    expect(capped.assistant.clientProgressText(CLIENT_ID, "uz")).toContain("Qabul qilingan fayllar: 0/14");
  });

  it("keeps files waiting in the inbox across a restart", async () => {
    const h = makeHarness();
    for (const name of ["a.pdf", "b.pdf"]) await h.send(h.directMessage(null, { file: pdf(name) }));
    expect(h.assistant.inbox.read(CLIENT_ID).files.map((f) => f.name)).toEqual(["a.pdf", "b.pdf"]);
    h.restart();
    await h.flush();
    expect(h.assistant.inbox.read(CLIENT_ID).files).toHaveLength(0);
    expect(h.assistant.clientProgressText(CLIENT_ID, "uz")).toContain("Qabul qilingan fayllar: 2/14");
  });

  it("counts files sent to the business account and answers through it", async () => {
    const h = makeHarness();
    h.setConnection();
    await h.send(h.businessMessage(null, pdf("ustav.pdf")));
    await h.flush();
    const summary = h.api.sentTo(CLIENT_ID).at(-1);
    expect(summary?.payload.business_connection_id).toBe(CONNECTION_ID);
    expect(String(summary?.payload.text)).toContain("📥 1 ta fayl qabul qilindi:\n• ustav.pdf");
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
    h.generator.push("Anketani yuboraman, 14 ta hujjatni yuboring. [SEND_TEMPLATE]");
    await h.send(h.directMessage("Konimizga investor kerak"));
    const text = h.api.sentTo(CLIENT_ID).map((c) => String(c.payload.text));
    expect(text).toEqual(["Anketani yuboraman, 14 ta hujjatni yuboring."]);
    expect(h.api.sentTo(CLIENT_ID, "sendDocument")).toHaveLength(1);
    expect(h.generator.calls[0]?.system).toContain("[SEND_TEMPLATE]");
    expect(h.generator.calls[0]?.system).toContain("the 14 documents");
    expect(h.generator.calls[0]?.system).toContain("Menda yo'q hujjatlar");
    expect(h.generator.calls[0]?.system).toContain("The bot does not check the files");
  });

  it("sends the Russian form with the list of 14 documents on request, without Claude", async () => {
    const h = makeHarness();
    await h.send(h.directMessage("Анкета"));
    expect(h.generator.calls).toHaveLength(0);
    const caption = String(h.api.sentTo(CLIENT_ID, "sendDocument")[0]?.payload.caption);
    expect(caption).toContain("14 документов");
    expect(caption).toContain("14) решения на земельный отвод");
    expect(caption).not.toContain("NDA");
  });

  it("shows clients the status and questionnaire buttons on /start", async () => {
    const h = makeHarness();
    await h.send(h.directMessage("/start"));
    const markup = h.api.sentTo(CLIENT_ID)[0]?.payload.reply_markup as { keyboard: { text: string }[][] };
    expect(markup.keyboard.flat().map((b) => b.text)).toEqual([
      "📊 Hujjatlar holati",
      "📄 Anketa shabloni",
      "❌ Menda yo'q hujjatlar",
    ]);
  });
});

describe("deleting a chat", () => {
  async function clientWithHistory() {
    const h = makeHarness();
    h.generator.push("Javob");
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

  it("shows the owner the folder with the file count and the buttons", async () => {
    const h = await clientWithHistory();
    await h.send(h.callback(`folder:${CLIENT_ID}`));
    const last = h.api.sentTo(OWNER_ID).at(-1);
    expect(String(last?.payload.text)).toContain("Qabul qilingan fayllar: 1/14");
    const buttons = (last?.payload.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard
      .flat()
      .map((b) => b.callback_data);
    expect(buttons).toEqual([`reply:${CLIENT_ID}`, `chattxt:${CLIENT_ID}`, `files:${CLIENT_ID}`, `delete:${CLIENT_ID}`]);

    await h.send(h.callback(`chattxt:${CLIENT_ID}`));
    expect(h.api.sentTo(OWNER_ID, "sendDocument").at(-1)?.payload.caption).toContain("yozishma");
    await h.send(h.callback(`files:${CLIENT_ID}`));
    expect(String(h.api.sentTo(OWNER_ID, "sendDocument").at(-1)?.payload.caption)).toBe("📄 1/14 — ustav.pdf");

    expect(h.assistant.usersListMessages()[0]?.text ?? "").toContain("📊 1/14");
  });
});

describe("documents the client does not have", () => {
  type Markup = { inline_keyboard: { text: string; callback_data: string }[][] };
  const toOwner = (h: ReturnType<typeof makeHarness>) => h.api.calls.filter((c) => Number(c.payload.chat_id) === OWNER_ID);
  const lastMenu = (h: ReturnType<typeof makeHarness>) =>
    h.api.byMethod("editMessageReplyMarkup").at(-1)?.payload.reply_markup as Markup | undefined;

  it("shows a menu of the 14 documents and marks or unmarks one per press", async () => {
    const h = makeHarness();
    await h.send(h.directMessage("❌ Menda yo'q hujjatlar"));
    expect(h.generator.calls).toHaveLength(0);
    const menu = h.api.sentTo(CLIENT_ID).at(-1);
    expect(String(menu?.payload.text)).toContain("Qaysi hujjatlar sizda yo'q?");
    const rows = (menu?.payload.reply_markup as Markup).inline_keyboard;
    expect(rows).toHaveLength(15);
    expect(rows[0]?.[0]).toEqual({ text: "⬜ 1. Korxona ustavi", callback_data: "miss:ustav" });
    expect(rows.at(-1)?.[0]).toEqual({ text: "✅ Tayyor", callback_data: "miss-done" });

    await h.send(h.callback("miss:zep", CLIENT_ID));
    await h.send(h.callback("miss:epb", CLIENT_ID));
    expect(lastMenu(h)?.inline_keyboard[9]?.[0]?.text).toBe("❌ 10. Ekologik paket: ZEP");
    expect(h.assistant.folders.status(CLIENT_ID).missing).toEqual(["zep", "epb"]);
    await h.send(h.callback("miss:zep", CLIENT_ID));
    expect(lastMenu(h)?.inline_keyboard[9]?.[0]?.text).toBe("⬜ 10. Ekologik paket: ZEP");
    expect(h.assistant.folders.status(CLIENT_ID).missing).toEqual(["epb"]);
    // Unknown documents, and presses by the owner, change nothing.
    await h.send(h.callback("miss:litsenziya", CLIENT_ID));
    await h.send(h.callback("miss:ustav"));
    expect(h.assistant.folders.status(CLIENT_ID).missing).toEqual(["epb"]);

    h.api.clear();
    await h.send(h.callback("miss-done", CLIENT_ID));
    const status = String(h.api.sentTo(CLIENT_ID).at(-1)?.payload.text);
    expect(status).toContain("Qabul qilingan fayllar: 0/13");
    expect(status).toContain("13. ❌ OPO bo'yicha sanoat xavfsizligi ekspertizasi (EPB) dalolatnomalari — yo'q");
    expect(fs.readFileSync(path.join(h.clientDir(), "chat.txt"), "utf8")).toContain(
      "[button] Menda yo'q hujjatlar: 13. OPO bo'yicha",
    );
    expect(toOwner(h)).toHaveLength(0);
    expect(h.assistant.usersListMessages()[0]?.text ?? "").toContain("📊 0/13");
  });

  it("sends the package once the files cover every document the client has, with the missing ones listed", async () => {
    const h = makeHarness();
    await h.send(h.callback("miss:zep", CLIENT_ID));
    await h.send(h.callback("miss:pdv", CLIENT_ID));
    await h.send(h.callback("miss-done", CLIENT_ID));
    for (const name of names(1, 12)) await h.send(h.directMessage(null, { file: pdf(name) }));
    await h.flush();
    expect(String(h.api.sentTo(CLIENT_ID).at(-1)?.payload.text)).toContain("Qabul qilingan fayllar: 12/12");
    const sent = toOwner(h);
    expect(sent.map((c) => c.method)).toEqual(["sendMessage", "sendMediaGroup", "sendMediaGroup"]);
    const text = String(sent[0]?.payload.text);
    expect(text).toContain("Mijoz 12 ta fayl yubordi (kerak: 12 ta)");
    expect(text).toContain("❌ Mijozda yo'q hujjatlar (2 ta):\n• 10. Ekologik paket: ZEP\n• 11. Ekologik paket: PDV");
    expect(((sent[2]?.payload.media ?? []) as { caption?: string }[]).at(-1)?.caption).toBe(
      "📄 12/12 — f12.pdf\n👤 Aziz @user2000",
    );
  });

  it("sends the package when the client marks the last documents after sending the files", async () => {
    const h = makeHarness();
    for (const name of names(1, 13)) await h.send(h.directMessage(null, { file: pdf(name) }));
    await h.flush();
    expect(toOwner(h)).toHaveLength(0);
    // Marking alone does not send it: only «✅ Tayyor» does.
    await h.send(h.callback("miss:tia", CLIENT_ID));
    expect(toOwner(h)).toHaveLength(0);
    await h.send(h.callback("miss-done", CLIENT_ID));
    const sent = toOwner(h);
    expect(sent.map((c) => c.method)).toEqual(["sendMessage", "sendMediaGroup", "sendMediaGroup"]);
    expect(String(sent[0]?.payload.text)).toContain("• 6. TIA (texnik-iqtisodiy asoslash)");
    // A second «Tayyor» does not send the package again.
    h.api.clear();
    await h.send(h.callback("miss-done", CLIENT_ID));
    expect(toOwner(h)).toHaveLength(0);
  });

  it("leaves the request to Claude in a business chat, where the menu cannot be shown", async () => {
    const h = makeHarness();
    h.setConnection();
    h.generator.push("Qaysi hujjat yo'qligini yozing.");
    await h.send(h.businessMessage("Menda yo'q hujjatlar"));
    expect(h.generator.calls).toHaveLength(1);
  });
});

describe("daily report", () => {
  const toOwner = (h: ReturnType<typeof makeHarness>) => h.api.calls.filter((c) => Number(c.payload.chat_id) === OWNER_ID);

  it("sends a short message when nothing happened in the last 24 hours", async () => {
    const h = makeHarness();
    await h.assistant.sendDailyReport(h.bot.api);
    const sent = toOwner(h);
    expect(sent.map((c) => c.method)).toEqual(["sendMessage"]);
    expect(String(sent[0]?.payload.text)).toContain("hech qanday o'zgarish yo'q");
  });

  it("sends one text file with the messages and files of the day", async () => {
    const h = makeHarness();
    h.generator.push("Assalomu alaykum!");
    await h.send(h.directMessage("Salom, litsenziya kerak"));
    await h.send(h.directMessage(null, { file: pdf("ustav.pdf") }));
    await h.flush();
    h.api.clear();
    await h.assistant.sendDailyReport(h.bot.api);
    const sent = toOwner(h);
    expect(sent.map((c) => c.method)).toEqual(["sendDocument"]);
    expect(String(sent[0]?.payload.caption)).toContain("Kunlik hisobot");
    expect(String(sent[0]?.payload.caption)).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("reports nothing again once the activity is older than 24 hours", async () => {
    const h = makeHarness();
    await h.send(h.directMessage(null, { file: pdf("ustav.pdf") }));
    await h.flush();
    h.clock.advance(25 * 3600);
    h.api.clear();
    await h.assistant.sendDailyReport(h.bot.api);
    expect(toOwner(h).map((c) => c.method)).toEqual(["sendMessage"]);
  });

  it("sends the report once a day, not again after a restart", async () => {
    const h = makeHarness({ DAILY_REPORT_HOUR: "0" });
    const timer = h.assistant.startDailyReport(h.bot.api);
    await new Promise((r) => setTimeout(r, 20));
    expect(toOwner(h)).toHaveLength(1);
    h.restart();
    const again = h.assistant.startDailyReport(h.bot.api);
    await new Promise((r) => setTimeout(r, 20));
    clearInterval(timer);
    clearInterval(again);
    expect(toOwner(h)).toHaveLength(1);
  });
});
