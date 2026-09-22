export type JobLifecycle = "done" | "cancelled" | "expired" | "retry";

export interface ClaimedJob {
  readonly id: string;
  readonly groupId: string;
  readonly jobType: string;
  readonly status: "claimed";
  readonly idempotencyKey: string;
  readonly dueAt: Date;
  readonly attempts: number;
  readonly lockedAt: Date;
  readonly lockedBy: string;
  readonly sourceMessageId?: string;
  readonly episodeId?: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ClaimJobsInput {
  readonly workerId: string;
  readonly now: Date;
  readonly limit: number;
  readonly staleLockBefore: Date;
}

export interface JobStore {
  claimDueJobs(input: ClaimJobsInput): Promise<readonly ClaimedJob[]>;
  markDone(jobId: string, workerId: string): Promise<boolean>;
  markCancelled(jobId: string, workerId?: string): Promise<boolean>;
  markExpired(jobId: string, workerId?: string): Promise<boolean>;
  scheduleRetry(jobId: string, workerId: string, dueAt: Date, reason?: string): Promise<boolean>;
  markFailed(jobId: string, workerId: string, reason?: string): Promise<boolean>;
  expireDueJobs(now: Date): Promise<readonly string[]>;
  cancelBySourceEvent(sourceEventId: string): Promise<number>;
  cancelBySourceMessage(sourceMessageId: string): Promise<number>;
  cancelByMember(memberId: string): Promise<number>;
  cancelByIdempotencyKey(idempotencyKey: string): Promise<number>;
}

export type JobHandlerResult = JobLifecycle | { readonly outcome: JobLifecycle; readonly delayMs?: number; readonly reason?: string };
export type JobHandler = (job: ClaimedJob) => Promise<JobHandlerResult | void>;

export interface JobHandlerRegistry {
  register(jobType: string, handler: JobHandler): void;
  unregister(jobType: string): boolean;
  get(jobType: string): JobHandler | undefined;
}

export interface JobTelemetryEvent {
  readonly event: "job_claimed" | "job_completed" | "job_cancelled" | "job_expired" | "job_retry" | "job_failed";
  readonly occurredAt: string;
  readonly jobId: string;
  readonly jobType?: string;
  readonly attempts?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface JobTelemetrySink {
  emit?(event: JobTelemetryEvent): void | Promise<void>;
  record?(event: JobTelemetryEvent): void | Promise<void>;
}

export interface JobRunnerOptions {
  readonly store: JobStore;
  readonly handlers?: JobHandlerRegistry;
  readonly workerId: string;
  readonly pollIntervalMs?: number;
  readonly batchSize?: number;
  readonly lockTimeoutMs?: number;
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number | ((attempts: number) => number);
  readonly telemetry?: JobTelemetrySink;
  readonly now?: () => Date;
}

export interface StopResult {
  readonly drained: boolean;
  readonly inFlight: number;
}

export interface JobRunner {
  start(): void;
  runOnce(): Promise<number>;
  stop(timeoutMs?: number): Promise<StopResult>;
  readonly running: boolean;
}

