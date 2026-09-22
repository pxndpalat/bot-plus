import type {
  ClaimedJob,
  JobHandlerRegistry,
  JobHandlerResult,
  JobLifecycle,
  JobRunner,
  JobRunnerOptions,
  JobTelemetryEvent,
  StopResult,
} from "./types.ts";
import { createJobHandlerRegistry } from "./registry.ts";

export class RetryableJobError extends Error {
  readonly retryable = true;
  readonly delayMs?: number;

  constructor(message = "Retryable job failure", delayMs?: number) {
    super(message);
    this.name = "RetryableJobError";
    this.delayMs = delayMs;
  }
}

function nowOf(options: JobRunnerOptions): Date {
  const value = options.now ? options.now() : new Date();
  return new Date(value.getTime());
}

async function emit(options: JobRunnerOptions, event: JobTelemetryEvent): Promise<void> {
  const sink = options.telemetry;
  if (!sink) return;
  if (sink.emit) await sink.emit(event);
  else if (sink.record) await sink.record(event);
}

function telemetryEvent(
  event: JobTelemetryEvent["event"],
  job: ClaimedJob | { id: string; jobType?: string; attempts?: number },
  now: Date,
  metadata?: Readonly<Record<string, unknown>>,
): JobTelemetryEvent {
  return {
    event,
    occurredAt: now.toISOString(),
    jobId: job.id,
    ...(job.jobType ? { jobType: job.jobType } : {}),
    ...(job.attempts === undefined ? {} : { attempts: job.attempts }),
    ...(metadata ? { metadata } : {}),
  };
}

function resultOf(value: JobHandlerResult | void): { outcome: JobLifecycle; delayMs?: number; reason?: string } {
  if (value === undefined || value === "done") return { outcome: "done" };
  if (typeof value === "string") return { outcome: value };
  return value;
}

export function createJobRunner(options: JobRunnerOptions): JobRunner {
  const handlers: JobHandlerRegistry = options.handlers ?? createJobHandlerRegistry();
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const batchSize = options.batchSize ?? 10;
  const lockTimeoutMs = options.lockTimeoutMs ?? 30_000;
  const maxAttempts = options.maxAttempts ?? 3;
  const defaultRetryDelayMs = options.retryDelayMs ?? 1_000;
  let timer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  let stopping = false;
  const inFlight = new Set<Promise<void>>();
  let currentPoll: Promise<number> | undefined;

  const execute = async (job: ClaimedJob): Promise<void> => {
    const handler = handlers.get(job.jobType);
    if (!handler) {
      await options.store.markFailed(job.id, options.workerId, "no_handler");
      await emit(options, telemetryEvent("job_failed", job, nowOf(options), { reason: "no_handler" }));
      return;
    }

    try {
      const outcome = resultOf(await handler(job));
      if (outcome.outcome === "done") {
        await options.store.markDone(job.id, options.workerId);
        await emit(options, telemetryEvent("job_completed", job, nowOf(options)));
      } else if (outcome.outcome === "cancelled") {
        await options.store.markCancelled(job.id, options.workerId);
        await emit(options, telemetryEvent("job_cancelled", job, nowOf(options)));
      } else if (outcome.outcome === "expired") {
        await options.store.markExpired(job.id, options.workerId);
        await emit(options, telemetryEvent("job_expired", job, nowOf(options)));
      } else {
        const retryDelay = outcome.delayMs ?? (typeof defaultRetryDelayMs === "function" ? defaultRetryDelayMs(job.attempts) : defaultRetryDelayMs);
        if (job.attempts < maxAttempts) {
          await options.store.scheduleRetry(job.id, options.workerId, new Date(nowOf(options).getTime() + retryDelay), outcome.reason ?? "handler_retry");
          await emit(options, telemetryEvent("job_retry", job, nowOf(options), { reason: outcome.reason ?? "handler_retry" }));
        } else {
          await options.store.markFailed(job.id, options.workerId, outcome.reason ?? "max_attempts");
          await emit(options, telemetryEvent("job_failed", job, nowOf(options), { reason: outcome.reason ?? "max_attempts" }));
        }
      }
    } catch (error) {
      const retryable = error instanceof RetryableJobError || (typeof error === "object" && error !== null && (error as { retryable?: unknown }).retryable === true);
      const delay = error instanceof RetryableJobError && error.delayMs !== undefined ? error.delayMs : (typeof defaultRetryDelayMs === "function" ? defaultRetryDelayMs(job.attempts) : defaultRetryDelayMs);
      if (retryable && job.attempts < maxAttempts) {
        await options.store.scheduleRetry(job.id, options.workerId, new Date(nowOf(options).getTime() + delay), "handler_error");
        await emit(options, telemetryEvent("job_retry", job, nowOf(options), { reason: "handler_error" }));
      } else {
        await options.store.markFailed(job.id, options.workerId, retryable ? "max_attempts" : "handler_error");
        await emit(options, telemetryEvent("job_failed", job, nowOf(options), { reason: retryable ? "max_attempts" : "handler_error" }));
      }
    }
  };

  const poll = async (): Promise<number> => {
    if (polling || stopping) return 0;
    polling = true;
    try {
      const now = nowOf(options);
      const expired = await options.store.expireDueJobs(now);
      for (const jobId of expired) await emit(options, telemetryEvent("job_expired", { id: jobId }, now));
      const jobs = await options.store.claimDueJobs({
        workerId: options.workerId,
        now,
        limit: batchSize,
        staleLockBefore: new Date(now.getTime() - lockTimeoutMs),
      });
      for (const job of jobs) {
        await emit(options, telemetryEvent("job_claimed", job, now));
        const work = execute(job);
        inFlight.add(work);
        void work.finally(() => inFlight.delete(work)).catch(() => undefined);
      }
      return jobs.length;
    } finally {
      polling = false;
    }
  };

  const runPoll = (): Promise<number> => {
    if (currentPoll) return currentPoll;
    const pollPromise = poll().finally(() => {
      if (currentPoll === pollPromise) currentPoll = undefined;
    });
    currentPoll = pollPromise;
    return pollPromise;
  };

  return {
    get running() { return timer !== undefined && !stopping; },
    start() {
      if (timer || stopping) return;
      void runPoll().catch(() => undefined);
      timer = setInterval(() => { void runPoll().catch(() => undefined); }, pollIntervalMs);
    },
    async runOnce() {
      if (stopping) return 0;
      return runPoll();
    },
    async stop(timeoutMs = 5_000): Promise<StopResult> {
      stopping = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      const deadline = Date.now() + timeoutMs;
      while ((currentPoll || inFlight.size > 0) && Date.now() < deadline) {
        const poll = currentPoll;
        await Promise.race([
          ...(poll ? [poll.then(() => undefined)] : []),
          ...[...inFlight],
          new Promise<void>((resolve) => setTimeout(resolve, 10)),
        ]);
      }
      return { drained: inFlight.size === 0, inFlight: inFlight.size };
    },
  };
}

export const createDelayedJobRunner = createJobRunner;
