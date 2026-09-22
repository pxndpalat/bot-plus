export interface FakeClock {
  now(): Date;
  nowMs(): number;
  set(value: Date | number): void;
  advance(milliseconds: number): void;
  sleep(milliseconds: number): Promise<void>;
}

interface PendingSleep {
  readonly dueAt: number;
  readonly resolve: () => void;
}

/**
 * A manually advanced clock. No test using this clock needs to wait in real
 * time, and each instance owns its pending timers for parallel isolation.
 */
export function createFakeClock(initial: Date | number = Date.UTC(2026, 0, 1)): FakeClock {
  let currentMs = typeof initial === "number" ? initial : initial.getTime();
  const pending: PendingSleep[] = [];

  const settle = (): void => {
    const ready = pending.splice(
      0,
      pending.findIndex((item) => item.dueAt > currentMs) < 0
        ? pending.length
        : pending.findIndex((item) => item.dueAt > currentMs),
    );
    for (const item of ready) item.resolve();
  };

  return {
    now: () => new Date(currentMs),
    nowMs: () => currentMs,
    set: (value) => {
      const nextMs = typeof value === "number" ? value : value.getTime();
      if (!Number.isFinite(nextMs)) throw new Error("Fake clock value must be finite");
      currentMs = nextMs;
      settle();
    },
    advance: (milliseconds) => {
      if (!Number.isFinite(milliseconds) || milliseconds < 0) {
        throw new Error("Fake clock advance must be a non-negative finite number");
      }
      currentMs += milliseconds;
      settle();
    },
    sleep: (milliseconds) => {
      if (!Number.isFinite(milliseconds) || milliseconds < 0) {
        return Promise.reject(new Error("Fake clock sleep must be a non-negative finite number"));
      }
      if (milliseconds === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        pending.push({ dueAt: currentMs + milliseconds, resolve });
        pending.sort((left, right) => left.dueAt - right.dueAt);
      });
    },
  };
}
