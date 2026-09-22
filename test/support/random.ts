export interface FakeRandom {
  next(): number;
  integer(minInclusive: number, maxInclusive: number): number;
  pick<T>(values: readonly T[]): T;
  calls(): number;
}

export interface FakeRandomOptions {
  readonly values?: readonly number[];
  readonly repeatLast?: boolean;
}

/** A deterministic replacement for Math.random, useful for delay decisions. */
export function createFakeRandom(options: FakeRandomOptions = {}): FakeRandom {
  const values = options.values ?? [0];
  if (values.length === 0) throw new Error("Fake random needs at least one value");
  if (values.some((value) => !Number.isFinite(value) || value < 0 || value >= 1)) {
    throw new Error("Fake random values must be in the range [0, 1)");
  }
  const repeatLast = options.repeatLast ?? true;
  let index = 0;

  const next = (): number => {
    if (index >= values.length && !repeatLast) {
      throw new Error("Fake random sequence exhausted");
    }
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return value;
  };

  return {
    next,
    integer: (minInclusive, maxInclusive) => {
      if (
        !Number.isInteger(minInclusive) ||
        !Number.isInteger(maxInclusive) ||
        minInclusive > maxInclusive
      ) {
        throw new Error("Fake random integer bounds are invalid");
      }
      return minInclusive + Math.floor(next() * (maxInclusive - minInclusive + 1));
    },
    pick: <T>(items: readonly T[]): T => {
      if (items.length === 0) throw new Error("Cannot pick from an empty collection");
      return items[Math.floor(next() * items.length)];
    },
    calls: () => index,
  };
}

export interface FakeIdGenerator {
  next(namespace?: string): string;
  calls(): number;
}

export function createFakeIdGenerator(prefix = "test"): FakeIdGenerator {
  let sequence = 0;
  return {
    next: (namespace = prefix) => {
      sequence += 1;
      return `${namespace}-${String(sequence).padStart(4, "0")}`;
    },
    calls: () => sequence,
  };
}
