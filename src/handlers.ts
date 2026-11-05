import { Composer, type Context, InputFile } from "grammy";
import type { ReplyKeyboardMarkup } from "grammy/types";
import type { Settings } from "./config.js";
import {
  type Assistant,
  CHAT_TXT_CALLBACK_PREFIX,
  DELETE_CALLBACK_PREFIX,
  DELETE_CANCEL_CALLBACK,
  DELETE_CONFIRM_CALLBACK_PREFIX,
  deleteConfirmKeyboard,
  describe,
  FILES_CALLBACK_PREFIX,
  FOLDER_CALLBACK_PREFIX,
  folderKeyboard,
  MISSING_CALLBACK_PREFIX,
  MISSING_DONE_CALLBACK,
  REPLY_CALLBACK_PREFIX,
  REPLY_DONE_CALLBACK,
  REPLY_DONE_KEYBOARD,
} from "./service.js";

export const ALLOWED_UPDATES = ["message", "callback_query", "business_connection", "business_message"] as const;

/** Text of the admins' keyboard button; pressing it lists everyone who wrote to the bot. */
export const USERS_BUTTON = "users";

/** Persistent keyboard shown to admins only. */
export const OWNER_KEYBOARD: ReplyKeyboardMarkup = {
  keyboard: [[{ text: USERS_BUTTON }]],
  resize_keyboard: true,
  is_persistent: true,
};

/** /start text for people who write to the bot. The AI is not called and no company.md facts are shown. */
export function welcomeText(companyName: string): string {
  return (
    `Assalomu alaykum! Bu «${companyName}» korxonasining rasmiy raqamli yordamchisi. ` +
    `Savolingizni shu yerga yozing yoki 14 ta hujjatingizni shu chatga yuboring — har bir hujjatni alohida ` +
    `fayl qilib. Bot nechta fayl kelganini ko'rsatib boradi; hammasi kelgach, paket ko'rib chiqish uchun qabul qilinadi.\n\n` +
    `«📊 Hujjatlar holati» — nechta fayl qabul qilingani va kerakli hujjatlar ro'yxati.\n` +
    `«❌ Menda yo'q hujjatlar» — sizda bo'lmagan hujjatlarni belgilash (ular so'ralmaydi).\n` +
    `«📄 Anketa shabloni» — ekspress-anketa (NDA bilan).\n\n` +
    `Bu sun'iy intellektga asoslangan avtomatik yordamchi ekanini inobatga oling.`
  );
}

export function buildComposer(assistant: Assistant, settings: Settings): Composer<Context> {
  const composer = new Composer<Context>();

  composer.on("business_connection", (ctx) => {
    assistant.onBusinessConnection(ctx.update.business_connection);
  });

  composer.on("business_message", async (ctx) => {
    await assistant.onBusinessMessage(ctx.api, ctx.update.business_message);
  });

  // Direct messages to the bot itself. Groups and channels are ignored.
  const direct = composer.on("message").filter((ctx) => ctx.chat.type === "private");

  direct.command("start", async (ctx) => {
    if (assistant.isAdmin(ctx.from.id)) {
      await ctx.reply(assistant.startText(), { reply_markup: OWNER_KEYBOARD });
    } else {
      await ctx.reply(welcomeText(settings.companyName), { reply_markup: assistant.clientKeyboardFor(ctx.from.id) });
    }
  });

  const owner = direct.filter((ctx) => assistant.isAdmin(ctx.from.id));
  const ownerReply = (ctx: Context, text: string) => ctx.reply(text, { reply_markup: OWNER_KEYBOARD });

  owner.command("pause", async (ctx) => {
    assistant.pause();
    await ownerReply(ctx, "⏸ Bot pauzada: murojaatlarga javob tayyorlanmaydi. Qayta yoqish uchun /resume yuboring.");
  });

  owner.command("resume", async (ctx) => {
    assistant.resume();
    await ownerReply(ctx, `▶️ Bot yana ishlayapti (rejim: ${assistant.modeText()}). Pauza va limit holati tozalandi.`);
  });

  owner.command("status", async (ctx) => {
    await ownerReply(ctx, assistant.statusText());
  });

  const listUsers = async (ctx: Context): Promise<void> => {
    for (const page of assistant.usersListMessages()) {
      await ctx.reply(page.text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup:
          page.buttons.length > 0
            ? { inline_keyboard: page.buttons.map((button) => [{ text: button.text, callback_data: button.data }]) }
            : OWNER_KEYBOARD,
      });
    }
  };
  owner.command("users", listUsers);
  owner.filter((ctx) => ctx.message.text?.trim().toLowerCase() === USERS_BUTTON, listUsers);

  // A person's button under the users list: their whole conversation, with a ✍️ reply button at the end.
  composer.callbackQuery(new RegExp(`^${FOLDER_CALLBACK_PREFIX}(\\d+)$`), async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!assistant.isAdmin(ctx.from.id)) return;
    const userId = Number(ctx.match[1]);
    const folder = assistant.userFolder(userId);
    if (folder.kind === "file") {
      await ctx.api.sendDocument(ctx.from.id, new InputFile(Buffer.from(folder.content, "utf8"), folder.fileName), {
        caption: folder.caption,
        reply_markup: folderKeyboard(userId),
      });
      return;
    }
    for (const [i, text] of folder.messages.entries()) {
      const last = i === folder.messages.length - 1;
      await ctx.api.sendMessage(ctx.from.id, text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: last ? folderKeyboard(userId) : OWNER_KEYBOARD,
      });
    }
  });

  // 📄 chat.txt: the whole conversation with this client as a text file.
  composer.callbackQuery(new RegExp(`^${CHAT_TXT_CALLBACK_PREFIX}(\\d+)$`), async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!assistant.isAdmin(ctx.from.id)) return;
    const userId = Number(ctx.match[1]);
    const text = assistant.folders.chatText(userId);
    if (!text) {
      await ctx.api.sendMessage(ctx.from.id, "Bu mijozning chat.txt fayli hali yo'q.", { reply_markup: OWNER_KEYBOARD });
      return;
    }
    await ctx.api.sendDocument(ctx.from.id, new InputFile(Buffer.from(text, "utf8"), `chat-${userId}.txt`), {
      caption: `📄 ${assistant.personTitle(userId)} bilan yozishma`,
      reply_markup: folderKeyboard(userId),
    });
  });

  // 📎 Every file this client sent.
  composer.callbackQuery(new RegExp(`^${FILES_CALLBACK_PREFIX}(\\d+)$`), async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!assistant.isAdmin(ctx.from.id)) return;
    const userId = Number(ctx.match[1]);
    const sent = await assistant.sendAcceptedFilesToOwner(ctx.api, userId, ctx.from.id);
    if (sent === 0) {
      await ctx.api.sendMessage(ctx.from.id, "Bu mijozdan hali birorta fayl kelmagan.", {
        reply_markup: OWNER_KEYBOARD,
      });
    }
  });

  // 🗑 Chatni o'chirish: asks first, then deletes everything about this client.
  composer.callbackQuery(new RegExp(`^${DELETE_CALLBACK_PREFIX}(\\d+)$`), async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!assistant.isAdmin(ctx.from.id)) return;
    const userId = Number(ctx.match[1]);
    await ctx.api.sendMessage(
      ctx.from.id,
      `🗑 ${assistant.personTitle(userId)} bilan butun yozishma, chat.txt, qabul qilingan va rad etilgan fayllar ` +
        "hujjatlar statistikasi va bazadagi barcha ma'lumotlari butunlay o'chiriladi. Buni qaytarib bo'lmaydi. O'chirilsinmi?",
      { reply_markup: deleteConfirmKeyboard(userId) },
    );
  });

  composer.callbackQuery(new RegExp(`^${DELETE_CONFIRM_CALLBACK_PREFIX}(\\d+)$`), async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!assistant.isAdmin(ctx.from.id)) return;
    const name = assistant.deleteChat(Number(ctx.match[1]), ctx.from.id);
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
    await ctx.api.sendMessage(ctx.from.id, `✅ ${name} bilan chat va uning papkasi o'chirildi.`, {
      reply_markup: OWNER_KEYBOARD,
    });
  });

  composer.callbackQuery(DELETE_CANCEL_CALLBACK, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!assistant.isAdmin(ctx.from.id)) return;
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
    await ctx.api.sendMessage(ctx.from.id, "O'chirish bekor qilindi.", { reply_markup: OWNER_KEYBOARD });
  });

  // «❌ Menda yo'q»: a client marks (or unmarks) a document they do not have; the menu is updated in place.
  composer.callbackQuery(new RegExp(`^${MISSING_CALLBACK_PREFIX}([a-z0-9_]+)$`), async (ctx) => {
    if (assistant.isAdmin(ctx.from.id) || ctx.chat?.type !== "private") {
      await ctx.answerCallbackQuery();
      return;
    }
    const keyboard = assistant.toggleMissing(ctx.from.id, ctx.match[1] ?? "");
    await ctx.answerCallbackQuery();
    if (keyboard) await ctx.editMessageReplyMarkup({ reply_markup: keyboard }).catch(() => undefined);
  });

  composer.callbackQuery(MISSING_DONE_CALLBACK, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (assistant.isAdmin(ctx.from.id) || ctx.chat?.type !== "private") return;
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
    await assistant.finishMissing(ctx.api, ctx.from.id);
  });

  // ✍️ Javob yozish: this admin's next messages go to that person; the bot is silent for them until «✖️ Tugatish».
  composer.callbackQuery(new RegExp(`^${REPLY_CALLBACK_PREFIX}(\\d+)$`), async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!assistant.isAdmin(ctx.from.id)) return;
    const name = assistant.startReply(ctx.from.id, Number(ctx.match[1]));
    await ctx.api.sendMessage(
      ctx.from.id,
      `✍️ ${name} uchun javobingizni yozing. Matn, rasm, fayl yoki ovozli xabar yuborishingiz mumkin — ` +
        "hammasi shu mijozga boradi. Bot bu mijozga «✖️ Tugatish» ni bosmaguningizcha javob bermaydi.",
      { reply_markup: REPLY_DONE_KEYBOARD },
    );
  });

  const endReply = async (ctx: Context): Promise<void> => {
    const adminId = ctx.from?.id ?? 0;
    const name = assistant.endReply(adminId);
    await ctx.api.sendMessage(
      adminId,
      name ? `✅ ${name} bilan javob rejimi yopildi. Endi bot unga yana o'zi javob beradi.` : "Javob rejimi ochiq emas.",
      { reply_markup: OWNER_KEYBOARD },
    );
  };
  composer.callbackQuery(REPLY_DONE_CALLBACK, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (assistant.isAdmin(ctx.from.id)) await endReply(ctx);
  });
  owner.command("cancel", endReply);

  // A fresh topic for the Admin AI: earlier questions are not used as context any more.
  owner.command("new", async (ctx) => {
    if (assistant.db) {
      await assistant.db.addAdminMessage(ctx.from.id, "assistant", "[Yangi mavzu: oldingi savollar endi kontekst emas.]");
      await assistant.db.setAdminFocus(ctx.from.id, { last_list: null, current_customer: null });
    }
    await ownerReply(ctx, "🆕 Yangi mavzu. Savolingizni yozing.");
  });

  // Any other message from an admin: delivered to the person chosen with ✍️, otherwise answered by the Admin AI.
  owner.on("message", async (ctx) => {
    // Service messages are not something the admin wrote: no answer.
    if (describe(ctx.message) === null) return;
    if (assistant.replyTarget(ctx.from.id) !== null) {
      const { result, to } = await assistant.sendOwnerReply(ctx.api, ctx.message);
      if (result === "sent") {
        await ctx.reply(`✅ ${to} ga yuborildi.`, { reply_markup: REPLY_DONE_KEYBOARD });
      } else if (result === "failed") {
        await ownerReply(ctx, `⚠️ ${to} ga yuborib bo'lmadi (u botni bloklagan bo'lishi mumkin).`);
      } else if (result === "unsupported") {
        await ownerReply(ctx, `⚠️ ${to} Business akkaunt orqali yozgan: unga bu yerdan faqat matn yuborish mumkin.`);
      }
      return;
    }
    const text = ctx.message.text ?? ctx.message.caption;
    if (!text?.trim()) {
      await ownerReply(
        ctx,
        `Mijozga fayl yuborish uchun «${USERS_BUTTON}» ni bosing, mijozni tanlang va «✍️ Javob yozish» ni bosing. ` +
          "Admin AI'ga savolni matn bilan yozing.",
      );
      return;
    }
    await assistant.adminChat(ctx.api, ctx.from.id, text);
  });

  // Everyone else: the bot answers (AI orchestrator). The admins are not sent a copy.
  // Other people's commands (/pause, /status ...) are ignored silently.
  direct.on("message", async (ctx) => {
    if (ctx.message.text?.startsWith("/")) return;
    await assistant.onDirectMessage(ctx.api, ctx.message);
  });

  return composer;
}
