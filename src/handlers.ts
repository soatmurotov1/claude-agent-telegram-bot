import { Composer, type Context } from "grammy";
import type { Settings } from "./config.js";
import type { Assistant } from "./service.js";

export const ALLOWED_UPDATES = ["message", "business_connection", "business_message"] as const;

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
    if (ctx.from.id === settings.ownerId) await ctx.reply(assistant.startText());
    else await ctx.reply(welcomeText(settings.companyName));
  });

  const owner = direct.filter((ctx) => ctx.from.id === settings.ownerId);

  owner.command("pause", async (ctx) => {
    assistant.pause();
    await ctx.reply("⏸ Bot pauzada: murojaatlarga javob tayyorlanmaydi. Qayta yoqish uchun /resume yuboring.");
  });

  owner.command("resume", async (ctx) => {
    assistant.resume();
    await ctx.reply(`▶️ Bot yana ishlayapti (rejim: ${assistant.modeText()}). Pauza va limit holati tozalandi.`);
  });

  owner.command("status", async (ctx) => {
    await ctx.reply(assistant.statusText());
  });

  // Any other message from the owner: a reply to a copied chat is delivered to that person.
  owner.on("message", async (ctx) => {
    const result = await assistant.onOwnerReply(ctx.api, ctx.message);
    if (result === "sent") {
      await ctx.reply("✅ Javobingiz yuborildi.");
    } else if (result === "failed") {
      await ctx.reply("⚠️ Javobni yuborib bo'lmadi (foydalanuvchi botni bloklagan bo'lishi mumkin).");
    } else {
      await ctx.reply(
        "Murojaatchiga javob yozish uchun bot yuborgan xabarga Reply qiling. " +
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
