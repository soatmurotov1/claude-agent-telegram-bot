/**
 * Decision Tree Engine (TZ 15.2-15.3) for customer messages.
 *
 *   1 New request -> 2 Gauge effort (complexity) -> 3 Underspecified? (context completeness, missing info)
 *   -> 4 request type -> 5 workflow -> 6 review & self-check (validation.ts) -> 7 result + memory (orchestrator.ts)
 *
 * The AI fills in the analysis (understanding the message is its job); the code only maps the analysis to a
 * workflow and the permissions it needs. If the analysis fails, a neutral default is used so one error never stops
 * the tree.
 */

export const CUSTOMER_REQUEST_TYPES = [
  "greeting",
  "thanks_or_ack",
  "info_question",
  "service_interest",
  "price_request",
  "document_question",
  "document_submission",
  "status_request",
  "complaint",
  "emergency",
  "official_request",
  "partnership",
  "off_topic",
  "unclear",
] as const;
export type CustomerRequestType = (typeof CUSTOMER_REQUEST_TYPES)[number];

export const COMPLEXITY = ["simple", "medium", "complex"] as const;
export type Complexity = (typeof COMPLEXITY)[number];

export const COMPLETENESS = ["complete", "partial", "insufficient"] as const;
export type Completeness = (typeof COMPLETENESS)[number];

export const STAGES = [
  "new",
  "interested",
  "price_asked",
  "documents_in_progress",
  "documents_sent",
  "negotiation",
  "rejected",
  "closed",
] as const;
export type Stage = (typeof STAGES)[number];

export type Workflow =
  | "skip_or_short"
  | "short_answer"
  | "answer_from_knowledge"
  | "sales_answer"
  | "price_answer"
  | "document_guidance"
  | "status"
  | "escalate"
  | "clarify"
  | "polite_redirect";

export type ConfidenceLevel = "high" | "medium" | "low";

export interface ExtractedFacts {
  company_name?: string;
  stir?: string;
  phone?: string;
  email?: string;
  activity?: string;
  location?: string;
  mineral_type?: "ruda" | "noruda";
  mineral?: string;
  license_number?: string;
  license_expiry?: string;
  preferences?: string;
  decisions?: string;
  next_contact_date?: string;
}

export interface Analysis {
  requestType: CustomerRequestType;
  complexity: Complexity;
  contextCompleteness: Completeness;
  /** 0..1, how sure the AI is that it can answer correctly from the known facts. */
  confidence: number;
  missingInfo: string[];
  /** The answer needs older parts of the conversation (investigation workflow). */
  needsHistorySearch: boolean;
  searchQuery: string;
  /** The same question was already answered earlier in this conversation. */
  alreadyAnswered: boolean;
  facts: ExtractedFacts;
  services: string[];
  stage: Stage | null;
  objection: string | null;
  topic: string;
  /** True when the analysis came from the AI (false: the default after a failure). */
  fromAi: boolean;
}

export function defaultAnalysis(): Analysis {
  return {
    requestType: "unclear",
    complexity: "medium",
    contextCompleteness: "partial",
    confidence: 0.5,
    missingInfo: [],
    needsHistorySearch: false,
    searchQuery: "",
    alreadyAnswered: false,
    facts: {},
    services: [],
    stage: null,
    objection: null,
    topic: "",
    fromAi: false,
  };
}

export function confidenceLevel(score: number): ConfidenceLevel {
  if (score >= 0.75) return "high";
  if (score >= 0.45) return "medium";
  return "low";
}

const STIR_RE = /^\d{9}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Turns the AI's JSON into a clean Analysis; unknown values fall back to the defaults. */
export function parseAnalysis(value: unknown): Analysis {
  const base = defaultAnalysis();
  if (typeof value !== "object" || value === null) return base;
  const v = value as Record<string, unknown>;
  const pick = <T extends string>(options: readonly T[], raw: unknown, fallback: T): T =>
    typeof raw === "string" && (options as readonly string[]).includes(raw) ? (raw as T) : fallback;
  const strings = (raw: unknown): string[] =>
    Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim().slice(0, 200)) : [];
  const text = (raw: unknown, max = 300): string => (typeof raw === "string" ? raw.trim().slice(0, max) : "");

  const facts: ExtractedFacts = {};
  const rawFacts = typeof v.facts === "object" && v.facts !== null ? (v.facts as Record<string, unknown>) : {};
  for (const key of [
    "company_name",
    "phone",
    "email",
    "activity",
    "location",
    "mineral",
    "license_number",
    "preferences",
    "decisions",
  ] as const) {
    const value = text(rawFacts[key], 200);
    if (value && !/^(null|unknown|noma'lum|-)$/i.test(value)) facts[key] = value;
  }
  const stir = text(rawFacts.stir).replace(/\s+/g, "");
  if (STIR_RE.test(stir)) facts.stir = stir;
  const mineralType = text(rawFacts.mineral_type).toLowerCase();
  if (mineralType === "ruda" || mineralType === "noruda") facts.mineral_type = mineralType;
  for (const key of ["license_expiry", "next_contact_date"] as const) {
    const value = text(rawFacts[key]);
    if (DATE_RE.test(value)) facts[key] = value;
  }

  const confidence = typeof v.confidence === "number" && Number.isFinite(v.confidence) ? Math.min(1, Math.max(0, v.confidence)) : base.confidence;
  return {
    requestType: pick(CUSTOMER_REQUEST_TYPES, v.request_type, base.requestType),
    complexity: pick(COMPLEXITY, v.complexity, base.complexity),
    contextCompleteness: pick(COMPLETENESS, v.context_completeness, base.contextCompleteness),
    confidence,
    missingInfo: strings(v.missing_info).slice(0, 5),
    needsHistorySearch: v.needs_history_search === true,
    searchQuery: text(v.search_query, 200),
    alreadyAnswered: v.already_answered === true,
    facts,
    services: strings(v.services).slice(0, 8),
    stage: typeof v.stage === "string" && (STAGES as readonly string[]).includes(v.stage) ? (v.stage as Stage) : null,
    objection: text(v.objection, 300) || null,
    topic: text(v.topic, 120),
    fromAi: true,
  };
}

const WORKFLOW_BY_TYPE: Record<CustomerRequestType, Workflow> = {
  greeting: "short_answer",
  thanks_or_ack: "skip_or_short",
  info_question: "answer_from_knowledge",
  service_interest: "sales_answer",
  partnership: "sales_answer",
  price_request: "price_answer",
  document_question: "document_guidance",
  document_submission: "document_guidance",
  status_request: "status",
  complaint: "escalate",
  emergency: "escalate",
  official_request: "escalate",
  off_topic: "polite_redirect",
  unclear: "clarify",
};

/** Step 4-5: the workflow for this analysis. */
export function selectWorkflow(analysis: Analysis): Workflow {
  const workflow = WORKFLOW_BY_TYPE[analysis.requestType];
  // Not enough facts to answer correctly: ask the one question that is really needed (never guess).
  if (
    analysis.contextCompleteness === "insufficient" &&
    analysis.missingInfo.length > 0 &&
    (workflow === "answer_from_knowledge" || workflow === "sales_answer")
  ) {
    return "clarify";
  }
  return workflow;
}

/** The steps the request went through, for ai_requests.workflow_path. */
export function workflowPath(analysis: Analysis, workflow: Workflow): string[] {
  const path = ["new_request", `gauge_effort:${analysis.complexity}`, `underspecified:${analysis.contextCompleteness}`];
  if (analysis.needsHistorySearch) path.push("investigation");
  path.push(workflow);
  return path;
}

/** What the workflow is allowed to do (rules decide permissions, not the AI). */
export function requiredPermissions(workflow: Workflow): string[] {
  const permissions = ["customer_reply"];
  if (workflow === "escalate") permissions.push("admin_notify");
  if (workflow === "price_answer") permissions.push("price_list_read", "admin_notify");
  return permissions;
}

/** Guidance for the reply model, per workflow (in English, the model's working language). */
export function workflowGuidance(analysis: Analysis, workflow: Workflow, knownMineralType: string | null): string {
  const lines: string[] = [];
  switch (workflow) {
    case "skip_or_short":
      lines.push("The person only thanks or acknowledges. If no reply is needed, write exactly [SKIP].");
      break;
    case "short_answer":
      lines.push("A greeting: answer briefly and ask how you can help (no lists).");
      break;
    case "answer_from_knowledge":
      lines.push("Answer the question from the company profile and the known facts.");
      break;
    case "sales_answer":
      lines.push("The person is interested in a service: say which service fits and move them to the next concrete step.");
      break;
    case "price_answer":
      lines.push(
        "PRICE QUESTION. Use only the PRICE LIST. Name the price and the number of days exactly as written there for the " +
          "service asked about (e.g. 'UTER: 8 000 000 so'm, 10 kun'). Never name any other amount, never round, never " +
          "invent a range or a deadline. Where the list says 'kelishiladi', say the price is agreed individually. Where " +
          "the list shows no deadline, say the deadline is agreed (do not guess). After the prices add the disclaimer " +
          "from the price list in the customer's language, then the contacts (phones, @sanoatgeokontex_xizmat, " +
          "sanoatgeokontexxizmat@gmail.com, https://sanoatgeokontexxizmat.uz/). Services that are not in the price list: " +
          "do not name a price at all; say it is calculated after the company is studied and give the contacts.",
      );
      if (!knownMineralType && !analysis.facts.mineral_type) {
        lines.push(
          "The mineral type is not known. Prices differ: 'noruda' (sand, gravel, stone, clay: fixed prices) and 'ruda' " +
            "(metal ores: everything agreed individually). Ask in one short question which mineral the company extracts " +
            "before naming amounts, unless the customer asked about one specific group.",
        );
      } else {
        lines.push(`Mineral type: ${analysis.facts.mineral_type ?? knownMineralType}. Use that group of the price list.`);
      }
      break;
    case "document_guidance":
      lines.push("A question about the 14 documents: follow rules 3 and 5.");
      break;
    case "status":
      lines.push('Tell them to write "holat" (or "статус") to see how many files were received.');
      break;
    case "escalate":
      lines.push("Rule 9 applies: start with [ESCALATE].");
      break;
    case "clarify":
      lines.push(
        `Information is missing (${analysis.missingInfo.join(", ") || "the person's need"}). Ask ONE precise question ` +
          "that gets it; do not guess and do not answer as if you knew.",
      );
      break;
    case "polite_redirect":
      lines.push("Off topic: say briefly what the company does and offer help with that.");
      break;
  }
  const level = confidenceLevel(analysis.confidence);
  if (level === "medium") {
    lines.push("Confidence is MEDIUM: give the likely answer carefully and say clearly what is not certain.");
  } else if (level === "low") {
    lines.push(
      "Confidence is LOW: do not present a guess as a fact. Ask for the missing information or say that you cannot " +
        "confirm this right now, and give what is known for sure.",
    );
  }
  if (analysis.alreadyAnswered) {
    lines.push(
      "This was already answered earlier in the conversation: do not repeat the earlier answer word for word; refer to " +
        "it briefly and add only what is new or what the person still needs.",
    );
  }
  return lines.join("\n");
}
