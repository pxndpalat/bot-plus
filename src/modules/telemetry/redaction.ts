export const REDACTED_VALUE = "[REDACTED]";
export const REDACTED_CONTENT = "[REDACTED_CONTENT]";

const SECRET_KEY_PATTERN = /(?:secret|password|passwd|credential|api[_-]?key|access[_-]?token|channel[_-]?token|authorization|cookie|set-cookie|private[_-]?key|refresh[_-]?token|id[_-]?token|(?:^|[_-])token(?:$|[_-]))/i;
const CONTENT_KEY_PATTERN = /^(?:content|text|raw|prompt|completion|input|output|body)$/i;

export interface RedactionOptions {
  readonly additionalKeys?: readonly string[];
  readonly additionalValues?: readonly string[];
  readonly redactContent?: boolean;
}

export interface Redactor {
  readonly redact: (value: unknown, options?: { readonly redactContent?: boolean }) => unknown;
  readonly redactText: (value: string) => string;
}

function escapedPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return "[UNSERIALIZABLE]";
}

export function createRedactor(options: RedactionOptions = {}): Redactor {
  const additionalKeys = new Set((options.additionalKeys ?? []).map((key) => key.toLowerCase()));
  const secretValues = (options.additionalValues ?? []).filter((value) => value.length > 0);
  const secretValuePattern = secretValues.length > 0
    ? new RegExp(secretValues.sort((left, right) => right.length - left.length).map(escapedPattern).join("|"), "g")
    : undefined;

  const redactText = (value: string): string => secretValuePattern
    ? value.replace(secretValuePattern, REDACTED_VALUE)
    : value;

  const redact = (value: unknown, nestedOptions: { readonly redactContent?: boolean } = {}): unknown => {
    const seen = new WeakSet<object>();
    const redactContent = nestedOptions.redactContent ?? options.redactContent ?? true;

    const visit = (current: unknown, key?: string): unknown => {
      if (key && (SECRET_KEY_PATTERN.test(key) || additionalKeys.has(key.toLowerCase()))) return REDACTED_VALUE;
      if (key && redactContent && CONTENT_KEY_PATTERN.test(key)) return REDACTED_CONTENT;
      if (typeof current === "string") return redactText(current);
      if (current === null || typeof current === "number" || typeof current === "boolean") return current;
      if (typeof current === "bigint") return `${current.toString()}n`;
      if (typeof current === "undefined") return undefined;
      if (typeof current === "function" || typeof current === "symbol") return `[${typeof current}]`;
      if (current instanceof Date) return Number.isNaN(current.getTime()) ? "[INVALID_DATE]" : current.toISOString();

      if (current instanceof Error) {
        if (seen.has(current)) return "[Circular]";
        seen.add(current);
        const errorRecord: Record<string, unknown> = {
          name: current.name,
          message: current.message,
          stack: current.stack,
        };
        const cause = (current as Error & { cause?: unknown }).cause;
        if (cause !== undefined) errorRecord.cause = cause;
        for (const property of Object.keys(current)) errorRecord[property] = (current as unknown as Record<string, unknown>)[property];
        return visit(errorRecord);
      }
      if (!isObject(current)) return safeString(current);
      if (seen.has(current)) return "[Circular]";
      seen.add(current);

      if (Array.isArray(current)) return current.map((item) => visit(item));

      const output: Record<string, unknown> = {};
      for (const [property, item] of Object.entries(current)) output[property] = visit(item, property);
      return output;
    };

    return visit(value);
  };

  return { redact, redactText };
}

export function redactValue(value: unknown, options?: RedactionOptions): unknown {
  return createRedactor(options).redact(value);
}
