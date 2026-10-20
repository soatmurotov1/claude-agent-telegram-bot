import { Composer, type Context, InputFile } from "grammy";
import type { ReplyKeyboardMarkup } from "grammy/types";
import type { Settings } from "./config.js";
import {
  type Assistant,
  describe,
  FOLDER_CALLBACK_PREFIX,
  REPLY_CALLBACK_PREFIX,
  REPLY_DONE_CALLBACK,
  REPLY_DONE_KEYBOARD,
  REPLY_MODE_MINUTES,
  replyKeyboard,
} from "./service.js";

export const ALLOWED_UPDATES = ["message", "callback_query", "business_connection", "business_message"] as const;

/** Text of the owner's only keyboard button; pressing it lists everyone who wrote to the bot. */
export const USERS_BUTTON = "users";

/** Persistent keyboard shown to the owner only. */
export const OWNER_KEYBOARD: ReplyKeyboardMarkup = {
  keyboard: [[{ text: USERS_BUTTON }]],
  resize_keyboard: true,
  is_persistent: true,
};

/** /start text for people who write to the bot. Claude is not called and no company.md facts are shown. */
export function welcomeText(companyName: string): string {
  return (
    `Assalomu alaykum! Bu «${companyName}» korxonasining rasmiy yordamchi boti. ` +
    `Savolingizni shu yerga yozing: bot korxona ma'lumotlari asosida javob beradi, kerak bo'lsa mas'ul xodim ` +
    `ham javob beradi. Bu avtomatik yordamchi ekanini inobatga oling.`
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
    if (ctx.from.id === settings.ownerId) {
      await ctx.reply(assistant.startText(), { reply_markup: OWNER_KEYBOARD });
    } else {
      await ctx.reply(welcomeText(settings.companyName));
    }
  });

  const owner = direct.filter((ctx) => ctx.from.id === settings.ownerId);
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
    if (ctx.from.id !== settings.ownerId) return;
    const userId = Number(ctx.match[1]);
    const folder = assistant.userFolder(userId);
    if (folder.kind === "file") {
      await ctx.api.sendDocument(settings.ownerId, new InputFile(Buffer.from(folder.content, "utf8"), folder.fileName), {
        caption: folder.caption,
        reply_markup: replyKeyboard(userId),
      });
      return;
    }
    for (const [i, text] of folder.messages.entries()) {
      const last = i === folder.messages.length - 1;
      await ctx.api.sendMessage(settings.ownerId, text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: last ? replyKeyboard(userId) : OWNER_KEYBOARD,
      });
    }
  });

  // ✍️ Javob yozish: the owner's next messages go to that person.
  composer.callbackQuery(new RegExp(`^${REPLY_CALLBACK_PREFIX}(\\d+)$`), async (ctx) => {
    await ctx.answerCallbackQuery();
    if (ctx.from.id !== settings.ownerId) return;
    const name = assistant.startReply(Number(ctx.match[1]));
    await ctx.api.sendMessage(
      settings.ownerId,
      `✍️ ${name} uchun javobingizni yozing. Matn, rasm, fayl yoki ovozli xabar yuborishingiz mumkin — ` +
        `hammasi shu mijozga boradi. Tugatgach «✖️ Tugatish» ni bosing (${REPLY_MODE_MINUTES} daqiqadan keyin ` +
        "o'zi yopiladi).",
      { reply_markup: REPLY_DONE_KEYBOARD },
    );
  });

  const endReply = async (ctx: Context): Promise<void> => {
    const name = assistant.endReply();
    await ctx.api.sendMessage(
      settings.ownerId,
      name ? `✅ ${name} bilan javob rejimi yopildi. Endi bot unga yana o'zi javob beradi.` : "Javob rejimi ochiq emas.",
      { reply_markup: OWNER_KEYBOARD },
    );
  };
  composer.callbackQuery(REPLY_DONE_CALLBACK, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (ctx.from.id === settings.ownerId) await endReply(ctx);
  });
  owner.command("cancel", endReply);

  // Any other message from the owner: delivered to the person chosen with ✍️, otherwise a short hint.
  owner.on("message", async (ctx) => {
    // Service messages are not something the owner wrote: no answer, no duplicate hints.
    if (describe(ctx.message) === null) return;
    const { result, to } = await assistant.sendOwnerReply(ctx.api, ctx.message);
    if (result === "sent") {
      await ctx.reply(`✅ ${to} ga yuborildi.`, { reply_markup: REPLY_DONE_KEYBOARD });
    } else if (result === "failed") {
      await ownerReply(ctx, `⚠️ ${to} ga yuborib bo'lmadi (u botni bloklagan bo'lishi mumkin).`);
    } else if (result === "unsupported") {
      await ownerReply(ctx, `⚠️ ${to} Business akkaunt orqali yozgan: unga bu yerdan faqat matn yuborish mumkin.`);
    } else {
      await ownerReply(
        ctx,
        `Mijozga javob yozish uchun «${USERS_BUTTON}» ni bosing, mijozni tanlang va «✍️ Javob yozish» ni bosing. ` +
          "Botni sinab ko'rish uchun unga boshqa akkauntdan yozing.",
      );
    }
  });

  // Everyone else: the bot answers from company.md. The owner is not sent a copy.
  // Other people's commands (/pause, /status ...) are ignored silently.
  direct.on("message", async (ctx) => {
    if (ctx.message.text?.startsWith("/")) return;
    await assistant.onDirectMessage(ctx.api, ctx.message);
  });

  return composer;
}
