import fs from "node:fs";
import type { Language } from "../language.js";

/** One row of the price list. A null price means "kelishiladi" (agreed individually). */
export interface PriceItem {
  key: string;
  title: Record<Language, string>;
  unit: string | null;
  price: number | null;
  priceMin?: number;
  priceMax?: number;
  priceText?: string;
  days: number | null;
  daysText?: string;
}

export interface PriceGroup {
  key: "noruda" | "ruda";
  title: Record<Language, string>;
  items: PriceItem[];
}

export interface PriceList {
  title: string;
  validOn: string;
  currency: string;
  disclaimer: Record<Language, string>;
  groups: PriceGroup[];
}

/** Reads knowledge/prices.json. Returns null when the file is missing or broken (the bot then names no price). */
export function loadPriceList(file: string): PriceList | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as PriceList;
    if (!Array.isArray(parsed.groups) || !parsed.disclaimer?.uz) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** "15 000 000" */
export function formatSum(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function priceLine(item: PriceItem): string {
  const unit = item.unit ? ` (1 ${item.unit} uchun)` : "";
  let price: string;
  if (item.price !== null) price = `${formatSum(item.price)} so'm${unit}`;
  else if (item.priceMin !== undefined && item.priceMax !== undefined) {
    price = `${formatSum(item.priceMin)} – ${formatSum(item.priceMax)} so'm${unit}`;
  } else price = item.priceText ?? "kelishiladi";
  const days = item.days !== null ? `${item.days} kun` : (item.daysText ?? "ko'rsatilmagan");
  return `- ${item.title.uz} | narx: ${price} | muddat: ${days}`;
}

/** The price list as a block for the system prompt. */
export function priceListPrompt(list: PriceList | null): string {
  if (!list) {
    return "PRICE LIST: not available. Do not name any price or amount; give the contacts instead.";
  }
  const groups = list.groups.map((group) => `${group.title.uz}:\n${group.items.map(priceLine).join("\n")}`).join("\n\n");
  return `PRICE LIST (the only source of prices; valid on ${list.validOn}; ${list.title}):
${groups}

Disclaimer to add, in the customer's language, every time you name a price:
uz: ${list.disclaimer.uz}
ru: ${list.disclaimer.ru}
en: ${list.disclaimer.en}`;
}

/** Every amount (in so'm) that appears in the price list; any other amount in a reply is invented. */
export function allowedAmounts(list: PriceList | null): Set<number> {
  const amounts = new Set<number>();
  for (const group of list?.groups ?? []) {
    for (const item of group.items) {
      for (const value of [item.price, item.priceMin, item.priceMax]) if (typeof value === "number") amounts.add(value);
    }
  }
  return amounts;
}

/**
 * Money amounts written in a reply, in so'm: "15 000 000", "15000000", "15 mln", "8 млн", "1,5 million".
 * Small numbers (days, years, BHM multiples, phone fragments) are not amounts.
 */
export function amountsIn(text: string): number[] {
  const found: number[] = [];
  const withoutPhones = text.replace(/\+?998[\d\s()-]{7,}/g, " ");
  const millions = /(\d+(?:[.,]\d+)?)\s*(mln|million|млн|миллион)/giu;
  for (const match of withoutPhones.matchAll(millions)) {
    found.push(Math.round(Number(match[1]!.replace(",", ".")) * 1_000_000));
  }
  const rest = withoutPhones.replace(millions, " ");
  for (const match of rest.matchAll(/\d{1,3}(?:[   .,]\d{3})+|\d{6,}/g)) {
    const value = Number(match[0].replace(/[   .,]/g, ""));
    if (value >= 100_000) found.push(value);
  }
  return found;
}

/** Amounts in a reply that are not in the price list. */
export function inventedAmounts(text: string, list: PriceList | null): number[] {
  const allowed = allowedAmounts(list);
  return amountsIn(text).filter((value) => !allowed.has(value));
}
