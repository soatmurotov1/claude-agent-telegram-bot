export type Language = "uz" | "ru" | "en";

export const LANGUAGE_NAMES: Record<Language, string> = {
  uz: "Uzbek",
  ru: "Russian",
  en: "English",
};

const APOSTROPHES = "'ʻ’‘`ʼ";
const APOSTROPHE_RE = new RegExp(`[${APOSTROPHES}]`, "gu");
const LATIN_TOKEN_RE = new RegExp(`[\\p{Script=Latin}${APOSTROPHES}]+`, "gu");
const OG_RE = new RegExp(`[og][${APOSTROPHES}](\\p{L}+)`, "gu");

const UZ_CYRILLIC_LETTERS = /[ўқғҳ]/iu;
const UZ_CYRILLIC_WORDS = [
  "салом", "ассалому", "ассалом", "рахмат", "раҳмат", "яхши", "нима", "қалесан", "йўқ", "бугун",
  "эртага", "керак", "қаерда", "қачон", "ҳозир", "кейин", "мен", "сен", "сиз", "ҳужжат", "ариза",
  "мурожаат", "хизмат", "манзил", "илтимос",
];

const UZ_LATIN_WORDS = [
  "salom", "assalomu", "assalom", "rahmat", "yaxshi", "nima", "qayerda", "qachon", "bugun", "ertaga",
  "kerak", "xop", "hozir", "keyin", "men", "sen", "siz", "hujjat", "ariza", "murojaat", "xizmat",
  "narxi", "manzil", "iltimos", "qanday", "qancha", "kerakmi", "bormi", "yoq",
];

const UZ_SUFFIXES = [
  "misan", "misiz", "mizmi", "yapsan", "yapman", "yapti", "yapmiz", "asizmi", "ganman", "dingmi",
  "yapsizmi", "larmi",
];

/** Short words must match exactly; longer ones also match as a stem (hujjat -> hujjatlarni). */
function matchesWord(word: string, list: readonly string[]): boolean {
  return list.some((w) => word === w || (w.length >= 5 && word.startsWith(w)));
}

function countScript(text: string, re: RegExp): number {
  let n = 0;
  for (const ch of text) if (re.test(ch)) n++;
  return n;
}

/**
 * Best-effort guess of the language of a message. Only a hint for Claude.
 * Returns null when the text has no letters at all (emoji, digits).
 */
export function detectLanguage(text: string): Language | null {
  const cyrillic = countScript(text, /\p{Script=Cyrillic}/u);
  const latin = countScript(text, /\p{Script=Latin}/u);
  if (cyrillic === 0 && latin === 0) return null;

  if (cyrillic > latin) {
    if (UZ_CYRILLIC_LETTERS.test(text)) return "uz";
    const words = text.toLowerCase().match(/\p{Script=Cyrillic}+/gu) ?? [];
    return words.some((w) => matchesWord(w, UZ_CYRILLIC_WORDS)) ? "uz" : "ru";
  }

  const tokens = text.toLowerCase().match(LATIN_TOKEN_RE) ?? [];
  for (const token of tokens) {
    if (token === "o'clock" || token.replace(APOSTROPHE_RE, "") === "oclock") continue;
    for (const m of token.matchAll(OG_RE)) {
      // "dog's" is an English possessive, not the Uzbek letter g'.
      if (m[1] !== "s") return "uz";
    }
  }
  const words = tokens.map((t) => t.replace(APOSTROPHE_RE, "")).filter(Boolean);
  if (words.some((w) => matchesWord(w, UZ_LATIN_WORDS))) return "uz";
  if (words.some((w) => UZ_SUFFIXES.some((s) => w.length > s.length && w.endsWith(s)))) return "uz";
  return "en";
}
