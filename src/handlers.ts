import { Composer, type Context, InputFile } from "grammy";
import type { ReplyKeyboardMarkup } from "grammy/types";
import type { Settings } from "./config.js";
import { type Assistant, describe, FOLDER_CALLBACK_PREFIX } from "./service.js";

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

/** How the owner makes the admin group where every person gets a folder (topic). */
export const SETUP_GUIDE = [
  "📁 Har bir mijoz uchun alohida jild (admin guruhi):",
  "1. Telegram'da yangi guruh yarating (faqat siz va xodimlaringiz).",
  "2. Guruh sozlamalari → Topics ni yoqing.",
  "3. Botni guruhga qo'shing va admin qiling, «Manage topics» huquqi bilan.",
  "4. Guruhda /setup yuboring.",
  "Shundan keyin har bir mijozga jild ochiladi, oldingi yozishmalar ham o'sha jildga ko'chiriladi. " +
    "Mijozga javob berish uchun uning jildiga yozing. Mijozlarning o'zida jild ko'rinmaydi.",
].join("\n");

export function buildComposer(assistant: Assistant, settings: Settings): Composer<Context> {
  const composer = new Composer<Context>();

  composer.on("business_connection", (ctx) => {
    assistant.onBusinessConnection(ctx.update.business_connection);
  });

  composer.on("business_message", async (ctx) => {
    await assistant.onBusinessMessage(ctx.api, ctx.update.business_message);
  });

  // The admin group: a supergroup with topics where every person gets a folder. Other groups are ignored.
  const groups = composer.on("message").filter((ctx) => ctx.chat.type === "supergroup");

  groups.command("setup", async (ctx) => {
    if (ctx.from?.id !== settings.ownerId) return;
    const thread = ctx.message.message_thread_id;
    const reply = (text: string) => ctx.reply(text, thread !== undefined ? { message_thread_id: thread } : {});
    if (!ctx.chat.is_forum) {
      await reply(
        "⚠️ Bu guruhda Topics yoqilmagan. Guruh sozlamalari → Topics ni yoqing, keyin /setup ni qayta yuboring.",
      );
      return;
    }
    const me = await ctx.getChatMember(ctx.me.id);
    if (me.status !== "administrator" || !me.can_manage_topics) {
      await reply(
        "⚠️ Botni shu guruhga admin qiling va unga «Manage topics» (mavzularni boshqarish) huquqini bering, " +
          "keyin /setup ni qayta yuboring.",
      );
      return;
    }
    await reply("⏳ Mijozlar uchun jildlar ochilmoqda va oldingi yozishmalar ko'chirilmoqda...");
    const count = await assistant.setupAdminGroup(ctx.api, ctx.chat.id);
    await reply(
      `✅ Tayyor: ${count} ta mijoz jildi ochildi. Endi har bir mijozning xabarlari va bot javoblari o'z jildiga ` +
        "tushadi. Mijozga javob berish uchun uning jildiga yozing.",
    );
  });

  groups.filter(
    (ctx) => ctx.chat.id === assistant.topics.groupId,
    async (ctx) => {
      // The bot's own messages never arrive; other bots, service messages and commands are not replies.
      if (ctx.from?.is_bot || describe(ctx.message) === null || ctx.message.text?.startsWith("/")) return;
      const result = await assistant.onTopicMessage(ctx.api, ctx.message);
      const thread = { message_thread_id: ctx.message.message_thread_id };
      if (result === "sent") {
        await ctx.react("👍").catch(() => undefined);
      } else if (result === "failed") {
        await ctx.reply("⚠️ Xabarni mijozga yuborib bo'lmadi (u botni bloklagan bo'lishi mumkin).", thread);
      } else if (result === "unsupported") {
        await ctx.reply("⚠️ Business akkaunt orqali yozgan mijozga bu yerdan faqat matn yuborish mumkin.", thread);
      }
    },
  );

  // Direct messages to the bot itself.
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

  owner.command("setup", async (ctx) => {
    await ownerReply(ctx, SETUP_GUIDE);
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

  // A 📁 button under the users list: show the whole conversation with that person.
  composer.callbackQuery(new RegExp(`^${FOLDER_CALLBACK_PREFIX}(\\d+)$`), async (ctx) => {
    await ctx.answerCallbackQuery();
    if (ctx.from.id !== settings.ownerId) return;
    const folder = assistant.userFolder(Number(ctx.match[1]));
    if (folder.kind === "file") {
      await ctx.api.sendDocument(settings.ownerId, new InputFile(Buffer.from(folder.content, "utf8"), folder.fileName), {
        caption: folder.caption,
        reply_markup: OWNER_KEYBOARD,
      });
      return;
    }
    for (const text of folder.messages) {
      await ctx.api.sendMessage(settings.ownerId, text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: OWNER_KEYBOARD,
      });
    }
  });

  // Any other message from the owner: a reply to a copied chat is delivered to that person.
  owner.on("message", async (ctx) => {
    // Service messages (e.g. "topic created") are not something the owner wrote: no answer, no duplicate hints.
    if (describe(ctx.message) === null) return;
    const result = await assistant.onOwnerReply(ctx.api, ctx.message);
    if (result === "sent") {
      await ownerReply(ctx, "✅ Javobingiz yuborildi.");
    } else if (result === "failed") {
      await ownerReply(ctx, "⚠️ Javobni yuborib bo'lmadi (foydalanuvchi botni bloklagan bo'lishi mumkin).");
    } else {
      await ownerReply(
        ctx,
        "Murojaatchiga javob yozish uchun bot yuborgan xabarga Reply qiling. " +
          `Mijozlar ro'yxati uchun «${USERS_BUTTON}» tugmasini bosing. ` +
          "Botni sinab ko'rish uchun unga boshqa akkauntdan yozing.",
      );
    }
  });

  // Everyone else: the bot answers from company.md and sends the owner a copy.
  // Other people's commands (/pause, /status ...) are ignored silently.
  direct.on("message", async (ctx) => {
    if (ctx.message.text?.startsWith("/")) return;
    await assistant.onDirectMessage(ctx.api, ctx.message);
  });

  return composer;
}
