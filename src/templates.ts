import fs from "node:fs";
import path from "node:path";
import type { Language } from "./language.js";
import { isRecord } from "./store.js";

/** The template whose documents the bot asks every client for. */
export const DEFAULT_TEMPLATE_ID = "investment-checklist";

export type Titles = Record<Language, string>;

export interface TemplateDoc {
  key: string;
  title: Titles;
  /** What the document is, for Claude. */
  description: string;
  /** Acceptance criteria, for Claude. */
  checks: string[];
  /** Questionnaire items that, when marked "not applicable", make this document optional. Empty = always needed. */
  naItems: number[];
}

export interface Template {
  id: string;
  dir: string;
  title: Titles;
  /** Blank form file per language, as an absolute path. */
  blank: Partial<Record<Language, string>>;
  documents: TemplateDoc[];
}

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

function titles(value: unknown, where: string): Titles {
  if (!isRecord(value)) throw new TemplateError(`${where}: title must be an object with uz, ru and en`);
  const out: Partial<Titles> = {};
  for (const lang of ["uz", "ru", "en"] as const) {
    const text = value[lang];
    if (typeof text !== "string" || !text.trim()) throw new TemplateError(`${where}: title.${lang} is missing`);
    out[lang] = text.trim();
  }
  return out as Titles;
}

/** Reads templates/<id>/template.json fresh (like company.md), so a pushed change applies to the next file. */
export function loadTemplate(templatesDir: string, id = DEFAULT_TEMPLATE_ID): Template {
  const dir = path.join(templatesDir, id);
  const file = path.join(dir, "template.json");
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new TemplateError(`Cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(raw) || !Array.isArray(raw.documents)) throw new TemplateError(`${file}: "documents" is missing`);

  const blank: Partial<Record<Language, string>> = {};
  if (isRecord(raw.blank)) {
    for (const lang of ["uz", "ru", "en"] as const) {
      const name = raw.blank[lang];
      if (typeof name === "string" && name) blank[lang] = path.join(dir, path.basename(name));
    }
  }

  const keys = new Set<string>();
  const documents = raw.documents.map((value, i): TemplateDoc => {
    const where = `${file}: documents[${i}]`;
    if (!isRecord(value)) throw new TemplateError(`${where} must be an object`);
    const { key, description, checks, naItems } = value;
    if (typeof key !== "string" || !/^[a-z0-9_]+$/.test(key)) {
      throw new TemplateError(`${where}: key must use only a-z, 0-9 and _`);
    }
    if (keys.has(key)) throw new TemplateError(`${where}: duplicate key ${key}`);
    keys.add(key);
    return {
      key,
      title: titles(value.title, where),
      description: typeof description === "string" ? description : "",
      checks: Array.isArray(checks) ? checks.filter((c): c is string => typeof c === "string") : [],
      naItems: Array.isArray(naItems) ? naItems.filter((n): n is number => Number.isInteger(n)) : [],
    };
  });
  if (documents.length === 0) throw new TemplateError(`${file}: no documents`);

  return {
    id: typeof raw.id === "string" ? raw.id : id,
    dir,
    title: titles(raw.title, file),
    blank,
    documents,
  };
}

/** The blank form for a language; English speakers get the Russian one (there is no English form). */
export function blankFor(template: Template, language: Language | null): string | null {
  const order: Language[] = language === "ru" || language === "en" ? ["ru", "uz"] : ["uz", "ru"];
  for (const lang of order) {
    const file = template.blank[lang];
    if (file && fs.existsSync(file)) return file;
  }
  return null;
}
