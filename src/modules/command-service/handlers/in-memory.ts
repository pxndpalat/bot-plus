import type { CommandIdempotencyStore, CommandResult } from "./types.ts";

export interface InMemoryCommandIdempotencyStore extends CommandIdempotencyStore {
  readonly values: ReadonlyMap<string, CommandResult>;
}

export function createInMemoryCommandIdempotencyStore(): InMemoryCommandIdempotencyStore {
  const values = new Map<string, CommandResult>();
  return {
    values,
    async get(key) { return values.get(key); },
    async set(key, result) { values.set(key, result); },
  };
}
