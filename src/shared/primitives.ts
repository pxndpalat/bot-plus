import type { DomainId } from "./domain.ts";

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = Object.freeze({
  now: () => new Date()
});

export function fixedClock(initial: Date): Clock {
  const value = new Date(initial.getTime());
  if (Number.isNaN(value.getTime())) throw new TypeError("Clock date must be valid");
  return {
    now: () => new Date(value.getTime())
  };
}

export interface RandomSource {
  next(): number;
}

export const systemRandom: RandomSource = Object.freeze({
  next: () => Math.random()
});

export function fixedRandom(values: readonly number[]): RandomSource {
  if (values.length === 0 || values.some((value) => value < 0 || value >= 1 || !Number.isFinite(value))) {
    throw new TypeError("Random values must be in the interval [0, 1)");
  }
  let index = 0;
  return {
    next: () => {
      const value = values[index % values.length];
      index += 1;
      return value;
    }
  };
}

export function randomInt(minInclusive: number, maxExclusive: number, random: RandomSource = systemRandom): number {
  if (!Number.isInteger(minInclusive) || !Number.isInteger(maxExclusive) || maxExclusive <= minInclusive) {
    throw new RangeError("Invalid random integer range");
  }
  return minInclusive + Math.floor(random.next() * (maxExclusive - minInclusive));
}

export interface IdGenerator<T extends DomainId = DomainId> {
  next(): T;
}

export function uuidIdGenerator<T extends DomainId = DomainId>(): IdGenerator<T> {
  return {
    next: () => crypto.randomUUID() as T
  };
}

export function fixedIdGenerator<T extends DomainId>(values: readonly T[]): IdGenerator<T> {
  if (values.length === 0) throw new RangeError("At least one id is required");
  let index = 0;
  return {
    next: () => {
      const value = values[index % values.length];
      index += 1;
      return value;
    }
  };
}

export interface TransactionBoundary {
  run<T>(work: () => Promise<T> | T): Promise<T>;
}

export const noOpTransaction: TransactionBoundary = Object.freeze({
  run: async <T>(work: () => Promise<T> | T): Promise<T> => work()
});

export interface ResultOk<T> {
  readonly ok: true;
  readonly value: T;
}

export interface ResultErr<E> {
  readonly ok: false;
  readonly error: E;
}

export type Result<T, E = Error> = ResultOk<T> | ResultErr<E>;

export const ok = <T>(value: T): ResultOk<T> => ({ ok: true, value });
export const err = <E>(error: E): ResultErr<E> => ({ ok: false, error });

export const isOk = <T, E>(result: Result<T, E>): result is ResultOk<T> => result.ok;
export const isErr = <T, E>(result: Result<T, E>): result is ResultErr<E> => !result.ok;

export function mapResult<T, U, E>(result: Result<T, E>, map: (value: T) => U): Result<U, E> {
  return result.ok ? ok(map(result.value)) : result;
}

export function unwrapResult<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw result.error;
  return result.value;
}
