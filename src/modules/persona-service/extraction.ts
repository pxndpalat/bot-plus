import { ValidationError, type FactVisibility } from "../../shared/index.ts";
import { OBSERVATION_SOURCE_STRENGTHS, PERSONA_CATEGORIES, type PersonaExtractionCandidate, type PersonaExtractionEnvelope } from "./types.ts";

const VISIBILITIES = ["public_safe", "private", "risky"] as const;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) throw new ValidationError(`Persona extraction ${field} must be a non-empty string`);
  return value.trim();
};
const optionalString = (value: unknown, field: string): string | undefined => value === undefined || value === null ? undefined : requiredString(value, field);
const finite01 = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new ValidationError(`Persona extraction ${field} must be between 0 and 1`);
  return value;
};
const dateValue = (value: unknown, field: string): Date | undefined => {
  if (value === undefined) return undefined;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(requiredString(value, field));
  if (Number.isNaN(date.getTime())) throw new ValidationError(`Persona extraction ${field} must be a valid date`);
  return date;
};

export const personaExtractionSchema = {
  type: "object", additionalProperties: false, required: ["observations"],
  properties: { observations: { type: "array", items: { type: "object", additionalProperties: false, required: ["category", "claim", "sourceStrength", "confidence", "visibility"], properties: {
    category: { type: "string", enum: PERSONA_CATEGORIES }, claim: { type: "string", minLength: 1 }, subjectMemberId: { type: "string" }, subjectCandidate: { type: "string" }, sourceStrength: { type: "string", enum: OBSERVATION_SOURCE_STRENGTHS }, sourceType: { type: "string", enum: OBSERVATION_SOURCE_STRENGTHS }, confidence: { type: "number", minimum: 0, maximum: 1 }, visibility: { type: "string", enum: VISIBILITIES }, observedAt: { type: "string" }, sourceMessageId: { type: "string" }, extractedByMemberId: { type: "string" }, metadata: { type: "object" },
  } } } },
} as const;

export function validatePersonaExtraction(input: unknown): PersonaExtractionEnvelope {
  const root = isRecord(input) ? input : { observations: input };
  if (!Array.isArray(root.observations)) throw new ValidationError("Persona extraction observations must be an array");
  const observations: PersonaExtractionCandidate[] = root.observations.map((raw, index) => {
    if (!isRecord(raw)) throw new ValidationError(`Persona extraction observation ${index} must be an object`);
    const category = requiredString(raw.category, `observations[${index}].category`);
    if (!(PERSONA_CATEGORIES as readonly string[]).includes(category)) throw new ValidationError(`Unknown persona category: ${category}`);
    const sourceStrength = requiredString(raw.sourceStrength ?? raw.sourceType, `observations[${index}].sourceStrength`);
    if (!(OBSERVATION_SOURCE_STRENGTHS as readonly string[]).includes(sourceStrength)) throw new ValidationError(`Unknown persona source strength: ${sourceStrength}`);
    const visibility = requiredString(raw.visibility, `observations[${index}].visibility`);
    if (!(VISIBILITIES as readonly string[]).includes(visibility)) throw new ValidationError(`Unknown persona visibility: ${visibility}`);
    const result: PersonaExtractionCandidate = {
      category: category as PersonaExtractionCandidate["category"], claim: requiredString(raw.claim, `observations[${index}].claim`),
      sourceStrength: sourceStrength as PersonaExtractionCandidate["sourceStrength"], confidence: finite01(raw.confidence, `observations[${index}].confidence`), visibility: visibility as FactVisibility,
      subjectMemberId: optionalString(raw.subjectMemberId, `observations[${index}].subjectMemberId`), subjectCandidate: optionalString(raw.subjectCandidate, `observations[${index}].subjectCandidate`), observedAt: dateValue(raw.observedAt, `observations[${index}].observedAt`), sourceMessageId: optionalString(raw.sourceMessageId, `observations[${index}].sourceMessageId`), extractedByMemberId: optionalString(raw.extractedByMemberId, `observations[${index}].extractedByMemberId`), metadata: isRecord(raw.metadata) ? raw.metadata : undefined,
    };
    return result;
  });
  return { observations };
}

export const parsePersonaExtraction = validatePersonaExtraction;
export const personaExtractionJsonSchema = personaExtractionSchema;

