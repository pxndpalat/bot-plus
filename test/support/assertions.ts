import { strict as assert } from "node:assert";

function printable(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ""}`;
  try {
    return (
      JSON.stringify(value, (_key, nested) => {
        if (nested instanceof Error)
          return { name: nested.name, message: nested.message, stack: nested.stack };
        return nested;
      }) ?? String(value)
    );
  } catch {
    return String(value);
  }
}

/** Fails if any configured secret appears anywhere in structured log output. */
export function assertNoSecrets(logs: unknown, secrets: readonly string[]): void {
  const output = printable(logs);
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    assert.equal(output.includes(secret), false, `structured logs exposed secret: ${secret}`);
  }
}

export const assertStructuredLogsRedacted = assertNoSecrets;

export interface SideEffectRecord {
  readonly key: string;
  readonly [field: string]: unknown;
}

/** Asserts the irreversible side-effect invariant: one effect per idempotency key. */
export function assertAtMostOnce<T>(
  records: readonly T[],
  keyOf: (record: T) => string = (record) => {
    if (typeof record === "object" && record !== null && "key" in record) {
      return String((record as { key: unknown }).key);
    }
    return String(record);
  },
): void {
  const seen = new Set<string>();
  for (const record of records) {
    const key = keyOf(record);
    assert.equal(seen.has(key), false, `side effect occurred more than once for key: ${key}`);
    seen.add(key);
  }
}

export function createAtMostOnceRecorder<T>(): {
  readonly records: readonly SideEffectRecord[];
  run(key: string, effect: () => T): T | undefined;
} {
  const records: SideEffectRecord[] = [];
  const claimed = new Set<string>();
  return {
    records,
    run: (key, effect) => {
      if (claimed.has(key)) return undefined;
      claimed.add(key);
      const value = effect();
      records.push({ key, value });
      return value;
    },
  };
}
