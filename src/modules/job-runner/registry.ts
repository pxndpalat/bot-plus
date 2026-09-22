import type { JobHandler, JobHandlerRegistry } from "./types.ts";

export function createJobHandlerRegistry(initial: Readonly<Record<string, JobHandler>> = {}): JobHandlerRegistry {
  const handlers = new Map(Object.entries(initial));
  return {
    register(jobType, handler) {
      if (jobType.trim().length === 0) throw new TypeError("Job type must be non-empty");
      handlers.set(jobType, handler);
    },
    unregister: (jobType) => handlers.delete(jobType),
    get: (jobType) => handlers.get(jobType),
  };
}

export const createHandlerRegistry = createJobHandlerRegistry;

