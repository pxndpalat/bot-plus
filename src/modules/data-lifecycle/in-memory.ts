import type { LifecycleRepository } from "./ports.ts";
import type { ForgetInput, LifecycleAudit, LifecycleResult, RetentionSweepInput, UnsendInput } from "./types.ts";

export interface LifecycleMessageSeed { readonly id: string; readonly groupId: string; readonly lineMessageId: string; readonly senderMemberId?: string | null; readonly sentAt: Date; readonly textContent?: string | null; }
export interface LifecycleJobSeed { readonly id: string; readonly groupId: string; readonly sourceMessageId?: string | null; status?: "pending" | "claimed" | "completed" | "cancelled" | "failed" | "expired"; }
export interface LifecycleObservationSeed { readonly id: string; readonly groupId: string; readonly subjectMemberId: string; readonly sourceMessageId?: string | null; status?: "active" | "invalidated"; }
export interface LifecycleFactSeed { readonly id: string; readonly groupId: string; readonly subjectMemberId: string; readonly observationIds: readonly string[]; active?: boolean; readonly lastSeenAt: Date; }
export interface LifecycleContentLogSeed { readonly id: string; readonly groupId?: string | null; readonly createdAt: Date; readonly expiresAt: Date; }
export interface LifecycleSeed { readonly messages?: readonly LifecycleMessageSeed[]; readonly jobs?: readonly LifecycleJobSeed[]; readonly observations?: readonly LifecycleObservationSeed[]; readonly facts?: readonly LifecycleFactSeed[]; readonly contentLogs?: readonly LifecycleContentLogSeed[]; }

export interface InMemoryLifecycleRepository extends LifecycleRepository {
  readonly messages: readonly LifecycleMessageSeed[];
  readonly jobs: readonly LifecycleJobSeed[];
  readonly observations: readonly LifecycleObservationSeed[];
  readonly facts: readonly LifecycleFactSeed[];
  readonly contentLogs: readonly LifecycleContentLogSeed[];
  readonly audits: readonly LifecycleAudit[];
  readonly tombstones: readonly { readonly groupId: string; readonly lineMessageId: string; readonly messageId: string | null; readonly reason: "unsent" | "forgotten" | "retention"; }[];
}

function result(overrides: Partial<LifecycleResult> = {}): LifecycleResult { return { alreadyApplied: false, messagesDeleted: 0, jobsCancelled: 0, observationsInvalidated: 0, factsArchived: 0, contentLogsDeleted: 0, aliasesDeleted: 0, tombstoneCreated: false, ...overrides }; }
function copyMessage(value: LifecycleMessageSeed): LifecycleMessageSeed { return { ...value, sentAt: new Date(value.sentAt.getTime()) }; }
function copyJob(value: LifecycleJobSeed): LifecycleJobSeed { return { ...value, status: value.status ?? "pending" }; }
function copyObservation(value: LifecycleObservationSeed): LifecycleObservationSeed { return { ...value, status: value.status ?? "active" }; }
function copyFact(value: LifecycleFactSeed): LifecycleFactSeed { return { ...value, active: value.active ?? true, observationIds: [...value.observationIds], lastSeenAt: new Date(value.lastSeenAt.getTime()) }; }
function copyLog(value: LifecycleContentLogSeed): LifecycleContentLogSeed { return { ...value, createdAt: new Date(value.createdAt.getTime()), expiresAt: new Date(value.expiresAt.getTime()) }; }

export function createInMemoryLifecycleRepository(seed: LifecycleSeed = {}): InMemoryLifecycleRepository {
  const messages = (seed.messages ?? []).map(copyMessage); const jobs = (seed.jobs ?? []).map(copyJob); const observations = (seed.observations ?? []).map(copyObservation); const facts = (seed.facts ?? []).map(copyFact); const contentLogs = (seed.contentLogs ?? []).map(copyLog); const audits: LifecycleAudit[] = [];
  const tombstones: { groupId: string; lineMessageId: string; messageId: string | null; reason: "unsent" | "forgotten" | "retention" }[] = [];
  const archiveAffectedFacts = (affectedObservationIds: ReadonlySet<string>): number => {
    let count = 0;
    for (const fact of facts) {
      if (!fact.active || !fact.observationIds.some((id) => affectedObservationIds.has(id))) continue;
      const remaining = fact.observationIds.some((id) => observations.some((item) => item.id === id && item.status === "active"));
      if (!remaining) { fact.active = false; count += 1; }
    }
    return count;
  };
  const repository: InMemoryLifecycleRepository = {
    get messages() { return messages.map(copyMessage); }, get jobs() { return jobs.map(copyJob); }, get observations() { return observations.map(copyObservation); }, get facts() { return facts.map(copyFact); }, get contentLogs() { return contentLogs.map(copyLog); }, get audits() { return audits.map((item) => ({ ...item, occurredAt: new Date(item.occurredAt.getTime()) })); }, get tombstones() { return tombstones.map((item) => ({ ...item })); },
    async unsend(input: UnsendInput, audit) {
      const existingTombstone = tombstones.find((item) => item.groupId === input.groupId && item.lineMessageId === input.lineMessageId);
      if (existingTombstone) return result({ alreadyApplied: true });
      const messageIndex = messages.findIndex((item) => item.groupId === input.groupId && (item.lineMessageId === input.lineMessageId || item.id === input.messageId));
      const message = messageIndex >= 0 ? messages[messageIndex] : undefined;
      tombstones.push({ groupId: input.groupId, lineMessageId: input.lineMessageId, messageId: message?.id ?? null, reason: "unsent" });
      const sourceId = message?.id;
      let jobsCancelled = 0;
      if (sourceId) for (const job of jobs) if ((job.status === "pending" || job.status === "claimed") && job.sourceMessageId === sourceId) { job.status = "cancelled"; jobsCancelled += 1; }
      const affected = new Set<string>(); let observationsInvalidated = 0;
      if (sourceId) for (const observation of observations) if (observation.groupId === input.groupId && observation.sourceMessageId === sourceId && observation.status === "active") { observation.status = "invalidated"; affected.add(observation.id); observationsInvalidated += 1; }
      if (messageIndex >= 0) messages.splice(messageIndex, 1);
      const factsArchived = archiveAffectedFacts(affected); audits.push(audit);
      return result({ messagesDeleted: message ? 1 : 0, jobsCancelled, observationsInvalidated, factsArchived, tombstoneCreated: true });
    },
    async forgetMe(input: ForgetInput, audit) {
      const messageIds = new Set(messages.filter((item) => item.groupId === input.groupId && item.senderMemberId === input.memberId).map((item) => item.id));
      const hasActivePersona = observations.some((item) => item.groupId === input.groupId && item.subjectMemberId === input.memberId && item.status === "active") || facts.some((item) => item.groupId === input.groupId && item.subjectMemberId === input.memberId && item.active);
      if (messageIds.size === 0 && !hasActivePersona) return result({ alreadyApplied: true });
      let jobsCancelled = 0; for (const job of jobs) if ((job.status === "pending" || job.status === "claimed") && job.sourceMessageId && messageIds.has(job.sourceMessageId)) { job.status = "cancelled"; jobsCancelled += 1; }
      const affected = new Set<string>(); let observationsInvalidated = 0;
      for (const observation of observations) if (observation.groupId === input.groupId && observation.subjectMemberId === input.memberId && observation.status === "active") { observation.status = "invalidated"; affected.add(observation.id); observationsInvalidated += 1; }
      let factsArchived = 0; for (const fact of facts) if (fact.groupId === input.groupId && fact.subjectMemberId === input.memberId && fact.active) { fact.active = false; factsArchived += 1; }
      const deletedMessages = messages.filter((item) => messageIds.has(item.id));
      messages.splice(0, messages.length, ...messages.filter((item) => !messageIds.has(item.id)));
      for (const message of deletedMessages) if (!tombstones.some((item) => item.lineMessageId === message.lineMessageId)) tombstones.push({ groupId: message.groupId, lineMessageId: message.lineMessageId, messageId: message.id, reason: "forgotten" });
      audits.push(audit);
      return result({ messagesDeleted: messageIds.size, jobsCancelled, observationsInvalidated, factsArchived });
    },
    async sweep(input: RetentionSweepInput, audit) {
      if (!input.policy || !input.now) throw new Error("Sweep policy and time are required");
      const cutoff = input.now.getTime() - input.policy.rawMessageRetentionDays * 86_400_000; const oldIds = new Set(messages.filter((item) => (!input.groupId || item.groupId === input.groupId) && item.sentAt.getTime() < cutoff).map((item) => item.id));
      let jobsCancelled = 0; for (const job of jobs) if ((job.status === "pending" || job.status === "claimed") && job.sourceMessageId && oldIds.has(job.sourceMessageId)) { job.status = "cancelled"; jobsCancelled += 1; }
      const deletedMessages = messages.filter((item) => oldIds.has(item.id));
      messages.splice(0, messages.length, ...messages.filter((item) => !oldIds.has(item.id)));
      for (const message of deletedMessages) if (!tombstones.some((item) => item.lineMessageId === message.lineMessageId)) tombstones.push({ groupId: message.groupId, lineMessageId: message.lineMessageId, messageId: message.id, reason: "retention" });
      const logCount = contentLogs.length; const logCutoff = input.now.getTime() - input.policy.contentLogRetentionDays * 86_400_000; contentLogs.splice(0, contentLogs.length, ...contentLogs.filter((item) => (input.groupId && item.groupId !== input.groupId) || (item.expiresAt > input.now! && item.createdAt.getTime() >= logCutoff)));
      let factsArchived = 0; const factCutoff = input.now.getTime() - input.policy.personaDecayDays * 86_400_000; for (const fact of facts) if (fact.active && (!input.groupId || fact.groupId === input.groupId) && fact.lastSeenAt.getTime() <= factCutoff) { fact.active = false; factsArchived += 1; }
      if (audit) audits.push(audit);
      return result({ messagesDeleted: oldIds.size, jobsCancelled, contentLogsDeleted: logCount - contentLogs.length, factsArchived });
    },
  };
  return repository;
}

export const createInMemoryRetentionRepository = createInMemoryLifecycleRepository;

