import type { DecisionRecord, DecisionRepository, DecisionUsage } from "./types.ts";

function clone(record: DecisionRecord): DecisionRecord {
  return { ...record, createdAt: new Date(record.createdAt.getTime()), usedFactIds: [...record.usedFactIds] };
}
function cloneUsage(usage: DecisionUsage): DecisionUsage {
  return { ...usage, occurredAt: new Date(usage.occurredAt.getTime()), usage: { ...usage.usage } };
}

export interface InMemoryDecisionRepository extends DecisionRepository {
  readonly decisions: readonly DecisionRecord[];
  readonly records: readonly DecisionRecord[];
  readonly usageEvents: readonly DecisionUsage[];
}

export function createInMemoryDecisionRepository(): InMemoryDecisionRepository {
  const decisions: DecisionRecord[] = [];
  const usageEvents: DecisionUsage[] = [];
  return {
    get decisions() { return decisions.map(clone); },
    get records() { return decisions.map(clone); },
    get usageEvents() { return usageEvents.map(cloneUsage); },
    async createDecision(record) {
      const existing = decisions.find((item) => item.id === record.id);
      if (existing) return clone(existing);
      decisions.push(clone(record));
      return clone(record);
    },
    async recordUsage(usage) { usageEvents.push(cloneUsage(usage)); },
    async getLastAmbientResponseAt(groupId, before) {
      const result = decisions
        .filter((item) => item.groupId === groupId && item.decisionType === "ambient" && item.respond && item.createdAt <= before)
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0];
      return result ? new Date(result.createdAt.getTime()) : null;
    },
    async countAmbientResponsesSince(groupId, since, until) {
      return decisions.filter((item) => item.groupId === groupId && item.decisionType === "ambient" && item.respond && item.createdAt >= since && item.createdAt <= until).length;
    },
  };
}

export const createInMemoryDecisionStore = createInMemoryDecisionRepository;

