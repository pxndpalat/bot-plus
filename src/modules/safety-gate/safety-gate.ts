import { AiClientError, type AiClient, type JsonSchema } from "../ai-client/index.ts";
import {
  DEFAULT_NEUTRAL_RESPONSE,
  type SafetyCategory,
  type SafetyClassification,
  type SafetyFactMetadata,
  type SafetyGateInput,
  type SafetyGateOptions,
  type SafetyGateResult,
  type SafetyPath,
  type SafetyReason,
  type SafetyStatus,
} from "./types.ts";
import { categoryHint, deterministicFinding, redactSensitiveText, riskyFactFinding } from "./classifier.ts";

const CATEGORIES: readonly SafetyCategory[] = [
  "health", "injury", "religion", "politics", "sexuality", "finance", "illegal_activity",
  "secret", "real_time_location", "violent_attack", "prompt_injection", "policy_override", "none",
];

const CLASSIFICATION_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["allowed", "blocked", "uncertain"] },
    category: { type: "string", enum: CATEGORIES },
    reason: { type: "string", minLength: 1, maxLength: 200 },
  },
  required: ["status", "category", "reason"],
  additionalProperties: false,
};

function isClassification(value: unknown): value is SafetyClassification {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (candidate.status === "allowed" || candidate.status === "blocked" || candidate.status === "uncertain")
    && typeof candidate.category === "string" && CATEGORIES.includes(candidate.category as SafetyCategory)
    && typeof candidate.reason === "string" && candidate.reason.length > 0;
}

function normalizePath(input: SafetyGateInput): SafetyPath {
  const path = input.path ?? input.mode ?? input.decisionType ?? "ambient";
  return path === "direct" ? "direct" : "ambient";
}

function result(
  status: SafetyStatus,
  reason: SafetyReason,
  path: SafetyPath,
  category?: SafetyCategory,
  modelReason?: string,
  neutralResponse = DEFAULT_NEUTRAL_RESPONSE,
): SafetyGateResult {
  const response = status === "allowed" ? undefined : path === "direct" ? neutralResponse : undefined;
  return {
    status,
    safety: status,
    decision: status,
    reason,
    reasonCode: reason,
    machineReason: reason,
    ...(category ? { category } : {}),
    ...(modelReason ? { modelReason } : {}),
    path,
    ...(response ? { response, reply: response, neutralResponse } : {}),
  };
}

function allowedResult(path: SafetyPath, draft: string): SafetyGateResult {
  return {
    status: "allowed",
    safety: "allowed",
    decision: "allowed",
    reason: "allowed",
    reasonCode: "allowed",
    machineReason: "allowed",
    category: "none",
    path,
    response: draft,
    reply: draft,
  };
}

export class SafetyGate {
  readonly #aiClient: AiClient | undefined;
  readonly #neutralResponse: string;
  readonly #taskName: string;

  constructor(options: SafetyGateOptions | AiClient = {}) {
    const client = "structured" in options ? options : options.aiClient ?? options.classifier;
    this.#aiClient = client;
    this.#neutralResponse = ("structured" in options ? undefined : options.neutralResponse)?.trim() || DEFAULT_NEUTRAL_RESPONSE;
    this.#taskName = ("structured" in options ? undefined : options.taskName)?.trim() || "safety_classification";
  }

  async evaluate(input: SafetyGateInput): Promise<SafetyGateResult> {
    const path = normalizePath(input);
    if (typeof input.draft !== "string" || input.draft.trim().length === 0) {
      return result("uncertain", "invalid_input", path, undefined, undefined, this.#neutralResponse);
    }
    const source = `${input.draft}\n${input.userText ?? ""}`;
    const finding = deterministicFinding(source);
    if (finding) return result("blocked", finding.reason, path, finding.category, undefined, this.#neutralResponse);

    const facts: readonly SafetyFactMetadata[] = input.facts ?? input.factMetadata ?? [];
    const riskyFact = riskyFactFinding(facts);
    if (riskyFact) return result("blocked", riskyFact.reason, path, riskyFact.category, undefined, this.#neutralResponse);

    const hint = categoryHint(input.draft);
    if (!this.#aiClient) return result("uncertain", "model_failure", path, hint, undefined, this.#neutralResponse);

    // Only non-content metadata goes to the model. Drafts containing a
    // deterministic secret have already returned above; this extra redaction
    // protects against an overlooked token-shaped value.
    const prompt = {
      candidate: redactSensitiveText(input.draft),
      factMetadata: facts.map((fact) => ({
        ...(fact.id && /^[a-zA-Z0-9._:-]{1,128}$/.test(fact.id) ? { id: fact.id } : {}),
        ...(fact.visibility ? { visibility: fact.visibility } : {}),
        ...(fact.category && CATEGORIES.includes(fact.category as SafetyCategory) ? { category: fact.category } : {}),
      })),
      tone: input.tone === "สุภาพ" || input.tone === "ปกติ" || input.tone === "แซวแรง" ? input.tone : "normal",
    };
    try {
      const classification = await this.#aiClient.structured<SafetyClassification>({
        task: this.#taskName,
        prompt,
        schema: CLASSIFICATION_SCHEMA,
        validate: (value: unknown) => {
          if (!isClassification(value)) throw new TypeError("Invalid safety classification");
          return value;
        },
      });
      const model = classification.value;
      // A prohibited-category hint is a hard floor: model output cannot turn
      // prohibited content into allowed content.
      if (model.status === "allowed" && (model.category !== "none" || hint)) {
        return result("blocked", "prohibited_category", path, model.category !== "none" ? model.category : hint, model.reason, this.#neutralResponse);
      }
      if (model.status === "blocked") return result("blocked", "model_blocked", path, model.category, model.reason, this.#neutralResponse);
      if (model.status === "uncertain") return result("uncertain", "model_uncertain", path, model.category, model.reason, this.#neutralResponse);
      return allowedResult(path, input.draft);
    } catch (error) {
      const modelFailure = error instanceof AiClientError || error instanceof Error;
      return result("uncertain", "model_failure", path, hint, modelFailure ? error instanceof Error ? error.message : undefined : undefined, this.#neutralResponse);
    }
  }

  /** Alias for callers that use a noun-oriented port name. */
  readonly check = (input: SafetyGateInput): Promise<SafetyGateResult> => this.evaluate(input);
  readonly assess = (input: SafetyGateInput): Promise<SafetyGateResult> => this.evaluate(input);
}

export function createSafetyGate(options: SafetyGateOptions | AiClient = {}): SafetyGate {
  return new SafetyGate(options);
}

export async function evaluateSafety(input: SafetyGateInput, options: SafetyGateOptions | AiClient = {}): Promise<SafetyGateResult> {
  return new SafetyGate(options).evaluate(input);
}

export { CLASSIFICATION_SCHEMA };
