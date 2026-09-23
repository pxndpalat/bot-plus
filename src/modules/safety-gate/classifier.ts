import type { SafetyCategory, SafetyFactMetadata, SafetyReason } from "./types.ts";

export interface DeterministicFinding {
  readonly reason: SafetyReason;
  readonly category: SafetyCategory;
}

// These checks run before the model. In particular, secret-looking text never
// becomes part of a model prompt.
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:password|passwd|passcode|secret|api[ _-]?key|access[ _-]?token|private[ _-]?key|authorization[ _-]?header)\b/i,
  /\b(?:bearer|jwt|sk-[a-z0-9_-]{8,}|gh[pousr]_[a-z0-9_-]{8,}|xox[baprs]-[a-z0-9-]{8,})\b/i,
  /(?:รหัสผ่าน|รหัสลับ|คีย์ลับ|โทเค็น|ความลับ)/iu,
];

const LOCATION_PATTERNS: readonly RegExp[] = [
  /\b(?:real[- ]?time|live)\s+location\b/i,
  /\b(?:gps|latitude|longitude|coordinates?)\b/i,
  /(?:พิกัด|ตำแหน่งแบบเรียลไทม์|โลเคชันตอนนี้)/iu,
  /\b(?:i['’]?m|i am|currently)\s+(?:at|near|in)\b/i,
];

const INJECTION_PATTERNS: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget)\s+(?:all\s+)?(?:previous|prior|above|system)\s+(?:instructions?|rules?|policy)\b/i,
  /\b(?:override|disable|bypass|remove)\s+(?:the\s+)?(?:safety|policy|guardrails?|restrictions?)\b/i,
  /\b(?:reveal|show|print|leak)\s+(?:the\s+)?(?:system|hidden|developer)\s+(?:prompt|instructions?)\b/i,
  /\b(?:you are now|act as)\s+(?:an?\s+)?(?:unrestricted|uncensored|jailbroken)\b/i,
  /(?:ข้าม|ยกเลิก|ปิด|หลีกเลี่ยง).{0,20}(?:กฎ|นโยบาย|ความปลอดภัย|ข้อห้าม)/iu,
];

const OVERRIDE_PATTERNS: readonly RegExp[] = [
  /\b(?:policy|safety|moderation)\s*(?:override|exception|off)\b/i,
  /\b(?:admin|developer|system)\s+(?:override|mode)\b/i,
  /(?:ฉันเป็นแอดมิน|โหมดผู้ดูแล|ยกเว้นนโยบาย)/iu,
];

const CATEGORY_HINTS: readonly [SafetyCategory, RegExp][] = [
  ["health", /\b(?:health|medical|medicine|diagnos(?:e|is)|disease|illness|อาการ|สุขภาพ|โรค|ยา)\b/iu],
  ["injury", /\b(?:injur(?:y|ies)|wound|bleed(?:ing)?|trauma|บาดเจ็บ|แผล|เลือดออก)\b/iu],
  ["religion", /\b(?:religion|religious|god|faith|พระเจ้า|ศาสนา|ศรัทธา)\b/iu],
  ["politics", /\b(?:politic(?:s|al)|election|party|รัฐบาล|การเมือง|เลือกตั้ง)\b/iu],
  ["sexuality", /\b(?:sex(?:ual)?|sexuality|orientation|เพศวิถี|เรื่องเพศ)\b/iu],
  ["finance", /\b(?:bank|banking|finance|financial|salary|เงินเดือน|การเงิน|บัญชีธนาคาร)\b/iu],
  ["illegal_activity", /\b(?:illegal|crime|criminal|stolen|drugs?|อาชญากรรม|ผิดกฎหมาย|ยาเสพติด)\b/iu],
  ["violent_attack", /\b(?:attack|assault|kill|murder|weapon|ทำร้าย|โจมตี|ฆ่า|อาวุธ)\b/iu],
];

function firstMatch(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export function deterministicFinding(text: string): DeterministicFinding | undefined {
  if (firstMatch(text, SECRET_PATTERNS)) return { reason: "secret_detected", category: "secret" };
  if (firstMatch(text, LOCATION_PATTERNS)) return { reason: "real_time_location_detected", category: "real_time_location" };
  if (firstMatch(text, INJECTION_PATTERNS)) return { reason: "prompt_injection_detected", category: "prompt_injection" };
  if (firstMatch(text, OVERRIDE_PATTERNS)) return { reason: "policy_override_detected", category: "policy_override" };
  return undefined;
}

export function categoryHint(text: string): SafetyCategory | undefined {
  return CATEGORY_HINTS.find(([, pattern]) => pattern.test(text))?.[0];
}

export function riskyFactFinding(facts: readonly SafetyFactMetadata[]): DeterministicFinding | undefined {
  for (const fact of facts) {
    if (fact.visibility === "private" || fact.visibility === "risky" || fact.risky === true) {
      const category = CATEGORY_HINTS.some(([candidate]) => candidate === fact.category)
        ? fact.category as SafetyCategory
        : "none";
      return { reason: "risky_fact", category };
    }
    if (typeof fact.category === "string" && CATEGORY_HINTS.some(([candidate]) => candidate === fact.category)) {
      return { reason: "risky_fact", category: fact.category as SafetyCategory };
    }
  }
  return undefined;
}

/** Replace values only for diagnostics; normal flow returns before this is used. */
export function redactSensitiveText(text: string): string {
  return text
    .replace(/((?:password|passwd|passcode|secret|api[ _-]?key|access[ _-]?token|private[ _-]?key)\s*[:=]\s*)\S+/gi, "$1[REDACTED]")
    .replace(/\b(?:sk-[a-z0-9_-]{8,}|gh[pousr]_[a-z0-9_-]{8,}|xox[baprs]-[a-z0-9-]{8,})\b/gi, "[REDACTED]");
}
