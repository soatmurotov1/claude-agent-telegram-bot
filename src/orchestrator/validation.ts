import { inventedAmounts, type PriceList } from "../knowledge/prices.js";

/**
 * Review & self-check (TZ 6-bosqich, 17.5, 19.1, 20): the reply is checked in code before it goes out. A failed check
 * makes the model write the reply once more with the reason; what still fails after that is cleaned up here.
 */

/** "A responsible employee will answer you" and the like (TZ 19.1): never said to a customer. */
export const BANNED_PATTERNS: RegExp[] = [
  /mas['’ʻ`]?ul\s+(xodim|shaxs|mutaxassis)/iu,
  /масъул\s+ходим/iu,
  /xodim(im|lar)?(imiz)?\s+(siz(ga|ning)?\s+)?(bilan\s+)?(bog['’ʻ`]?lan|javob\s+ber|aloqaga\s+chiq)/iu,
  /xodim(im)?(imiz)?(ga|lar(imiz)?ga)\s+(yubor|uzat|o['’ʻ`]?tkaz)/iu,
  /mutaxassis(imiz|larimiz)?\s+(keyinroq\s+|tez\s+orada\s+|siz\s?(ga|ning|\s)?)*(javob\s+ber|bog['’ʻ`]?lan|aloqaga\s+chiq)/iu,
  /mutaxassis(imiz|larimiz)?ga\s+(yubor|uzat|o['’ʻ`]?tkaz)/iu,
  /(сотрудник|специалист|менеджер)\w*\s+(вам\s+|с\s+вами\s+)?(ответ|свяж|перезвон)/iu,
  /(ответственн)\w*\s+(сотрудник|лиц|специалист)/iu,
  /(передал|переда[её]м|передан)\w*\s+(ваш\w*\s+)?(вопрос\w*\s+|обращени\w*\s+)?(сотрудник|специалист)/iu,
  /\b(an?\s+)?(employee|specialist|manager|staff member|colleague)s?\b[^.?!]{0,30}\b(will|shall)\s+(reply|answer|contact|get back)/iu,
  /\bforwarded\b[^.?!]{0,30}\b(employee|specialist|manager|team)\b/iu,
];

export function bannedPhrases(text: string): string[] {
  const found: string[] = [];
  for (const pattern of BANNED_PATTERNS) {
    const match = pattern.exec(text);
    if (match) found.push(match[0]);
  }
  return found;
}

/** Removes every sentence that contains a banned phrase (last resort after a second attempt). */
export function removeBannedSentences(text: string): string {
  const sentences = text.split(/(?<=[.!?])\s+/u);
  const kept = sentences.filter((sentence) => bannedPhrases(sentence).length === 0);
  return kept.join(" ").trim();
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[‘’ʼʻ`´]/g, "'")
    .split(/[^\p{L}\p{N}']+/u)
    .filter((w) => w.length > 2);
}

/** Jaccard similarity of the word sets of two texts (0..1). */
export function similarity(a: string, b: string): number {
  const wa = new Set(words(a));
  const wb = new Set(words(b));
  if (wa.size === 0 || wb.size === 0) return 0;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / (wa.size + wb.size - common);
}

export const REPEAT_THRESHOLD = 0.7;

/** The earlier bot reply this one repeats, or null. Short replies ("Ha.", greetings) are not checked. */
export function repeatedReply(reply: string, previous: readonly string[]): string | null {
  if (words(reply).length < 8) return null;
  for (const earlier of previous) if (similarity(reply, earlier) >= REPEAT_THRESHOLD) return earlier;
  return null;
}

export interface KnownFacts {
  companyName: string | null;
  stir: string | null;
  mineralType: string | null;
  location: string | null;
}

/** Facts the reply asks for although the customer already gave them (TZ 17.4). */
export function asksForKnownFacts(reply: string, known: KnownFacts): string[] {
  const asks: string[] = [];
  // Only sentences that ask: a question mark or a request verb.
  const asking = reply
    .split(/(?<=[.!?])\s+/u)
    .filter((s) => /\?|yuboring|yozing|ayting|ko'rsating|kiriting|укажите|напишите|отправьте|пришлите|сообщите|please (send|tell|write)/iu.test(s))
    .join(" ");
  if (!asking) return asks;
  if (known.stir && /\bSTIR\b|СТИР|\bИНН\b|\bINN\b|\bTIN\b/u.test(asking)) asks.push("stir");
  if (known.companyName && /korxona(ngiz)?\s+nomi|kompaniya(ngiz)?\s+nomi|название\s+(вашей\s+)?(компании|предприятия|организации)|company name/iu.test(asking)) {
    asks.push("company_name");
  }
  if (known.mineralType && /(qaysi|qanday)\s+(foydali\s+qazilma|xom[- ]ashyo)|ruda\s+yoki\s+noruda|какое\s+(полезное\s+ископаемое|сырь)|which mineral/iu.test(asking)) {
    asks.push("mineral_type");
  }
  return asks;
}

export interface ReviewInput {
  reply: string;
  previousReplies: readonly string[];
  known: KnownFacts;
  priceList: PriceList | null;
}

export interface ReviewResult {
  ok: boolean;
  problems: string[];
  /** Instructions for the second attempt. */
  feedback: string;
  banned: string[];
  invented: number[];
  repeated: string | null;
  askedKnown: string[];
}

export function reviewReply(input: ReviewInput): ReviewResult {
  const banned = bannedPhrases(input.reply);
  const invented = inventedAmounts(input.reply, input.priceList);
  const repeated = repeatedReply(input.reply, input.previousReplies);
  const askedKnown = asksForKnownFacts(input.reply, input.known);
  const problems: string[] = [];
  const feedback: string[] = [];
  if (banned.length > 0) {
    problems.push("banned_phrase");
    feedback.push(
      `It says that an employee/specialist will answer ("${banned[0]}"). This is forbidden: answer yourself with what is ` +
        "known, and if something cannot be confirmed, say so honestly and give the contacts.",
    );
  }
  if (invented.length > 0) {
    problems.push("invented_amount");
    feedback.push(
      `It names amounts that are not in the PRICE LIST (${invented.join(", ")}). Use only the exact amounts of the price ` +
        "list, or say the price is agreed individually.",
    );
  }
  if (repeated) {
    problems.push("repeated_reply");
    feedback.push("It repeats an earlier reply almost word for word. Do not repeat it: say only what is new or needed now.");
  }
  if (askedKnown.length > 0) {
    problems.push("asked_known_fact");
    feedback.push(
      `It asks for ${askedKnown.join(", ")}, which the customer already gave (see KNOWN FACTS). Use the known value and do not ask again.`,
    );
  }
  return {
    ok: problems.length === 0,
    problems,
    feedback: feedback.join("\n"),
    banned,
    invented,
    repeated,
    askedKnown,
  };
}
