import { Composer, type Context } from "grammy";
import type { Settings } from "./config.js";
import type { Assistant } from "./service.js";

export const ALLOWED_UPDATES = ["message", "business_connection", "business_message"] as const;

export function strangerStartText(companyName: string): string {
  return (
    `Assalomu alaykum! Bu «${companyName}» korxonasining xizmat boti. Bu yerda murojaatlar qabul qilinmaydi. ` +
    `Murojaat uchun korxonaning rasmiy Telegram akkauntiga yoki rasmiy aloqa kanallariga yozing.`
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

  // Direct messages to the bot itself (not business chats).
  const direct = composer.on("message").filter((ctx) => ctx.chat.type === "private");

  direct.command("start", async (ctx) => {
    if (ctx.from.id === settings.ownerId) await ctx.reply(assistant.startText());
    else await ctx.reply(strangerStartText(settings.companyName));
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

  // Anything else sent directly to the bot is ignored silently.
  return composer;
}
