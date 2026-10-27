import fs from "node:fs";
import path from "node:path";
import type { Language } from "./language.js";
import { isRecord } from "./store.js";

/** The template whose documents the bot asks every client for. */
export const DEFAULT_TEMPLATE_ID = "investment-checklist";

export type Titles = Record<Language, string>;

/**
 * One paper inside a required document, e.g. the charter inside "charter and register extract". A client may send
 * all parts in one file or each part as its own file.
 */
export interface TemplatePart {
  key: string;
  title: Titles;
  /** Acceptance criteria, for Claude. */
  checks: string[];
  /** Questionnaire items that, when all marked "not applicable", make this part optional. Empty = always needed. */
  naItems: number[];
}

export interface TemplateDoc {
  key: string;
  title: Titles;
  /** What the document is, for Claude. */
  description: string;
  parts: TemplatePart[];
  /** False for documents that are welcome but not counted in the percentages (the questionnaire itself). */
  required: boolean;
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

  // Document and part keys share one namespace, so a part key alone names its document.
  const keys = new Set<string>();
  const checkKey = (key: unknown, where: string): string => {
    if (typeof key !== "string" || !/^[a-z0-9_]+$/.test(key)) {
      throw new TemplateError(`${where}: key must use only a-z, 0-9 and _`);
    }
    return key;
  };
  const documents = raw.documents.map((value, i): TemplateDoc => {
    const where = `${file}: documents[${i}]`;
    if (!isRecord(value)) throw new TemplateError(`${where} must be an object`);
    const key = checkKey(value.key, where);
    if (keys.has(key)) throw new TemplateError(`${where}: duplicate key ${key}`);
    keys.add(key);
    if (!Array.isArray(value.parts) || value.parts.length === 0) throw new TemplateError(`${where}: "parts" is missing`);
    const parts = value.parts.map((part, j): TemplatePart => {
      const partWhere = `${where}.parts[${j}]`;
      if (!isRecord(part)) throw new TemplateError(`${partWhere} must be an object`);
      const partKey = checkKey(part.key, partWhere);
      if (keys.has(partKey) && partKey !== key) throw new TemplateError(`${partWhere}: duplicate key ${partKey}`);
      keys.add(partKey);
      const { checks, naItems } = part;
      return {
        key: partKey,
        title: titles(part.title, partWhere),
        checks: Array.isArray(checks) ? checks.filter((c): c is string => typeof c === "string") : [],
        naItems: Array.isArray(naItems) ? naItems.filter((n): n is number => Number.isInteger(n)) : [],
      };
    });
    return {
      key,
      title: titles(value.title, where),
      description: typeof value.description === "string" ? value.description : "",
      parts,
      required: value.required !== false,
    };
  });
  if (!documents.some((doc) => doc.required)) throw new TemplateError(`${file}: no required documents`);

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
