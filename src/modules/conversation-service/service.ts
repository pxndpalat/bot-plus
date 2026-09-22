import {
  CONVERSATION_SILENCE_MS,
  CONTEXT_MESSAGE_LIMIT,
  CONTEXT_WINDOW_MS,
  type CandidateAnalysis,
  type CandidateAnalysisInput,
  type ContextQuery,
  type ConversationContext,
  type ConversationEpisode,
  type ConversationMessage,
  type ConversationRepository,
  type ConversationService,
  type RenderedContext,
} from "./types.ts";

export interface ConversationServiceOptions {
  readonly idGenerator?: () => string;
}

function defaultIdGenerator(): string {
  return crypto.randomUUID();
}

function copyDate(value: Date): Date {
  return new Date(value.getTime());
}

function assertDate(value: Date, field: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError(`${field} must be a valid Date`);
}

function assertMessage(message: ConversationMessage): void {
  if (!message.id.trim() || !message.groupId.trim()) throw new TypeError("Conversation message id and groupId are required");
  assertDate(message.eventAt, "message.eventAt");
}

function activeMessage(message: ConversationMessage): boolean {
  return message.lifecycle === undefined || message.lifecycle === "active";
}

function sortMessages(messages: readonly ConversationMessage[]): ConversationMessage[] {
  return [...messages].sort((left, right) => {
    const byEvent = left.eventAt.getTime() - right.eventAt.getTime();
    return byEvent !== 0 ? byEvent : left.id.localeCompare(right.id);
  });
}

export function createConversationService(repository: ConversationRepository, options: ConversationServiceOptions = {}): ConversationService {
  const nextId = options.idGenerator ?? defaultIdGenerator;

  const assignMessageToEpisode = async (message: ConversationMessage): Promise<ConversationEpisode> => {
    assertMessage(message);
    const containing = repository.findEpisodeContaining ? await repository.findEpisodeContaining(message.groupId, message.eventAt) : null;
    if (containing) {
      if (!containing.endedAt && message.eventAt.getTime() > containing.lastMessageAt.getTime()) {
        const updated: ConversationEpisode = { ...containing, lastMessageAt: copyDate(message.eventAt) };
        await repository.updateEpisode(updated);
        return updated;
      }
      return containing;
    }

    const latest = await repository.getLatestEpisode(message.groupId);
    if (latest && !latest.endedAt) {
      const gap = message.eventAt.getTime() - latest.lastMessageAt.getTime();
      if (gap >= -CONVERSATION_SILENCE_MS && gap <= CONVERSATION_SILENCE_MS) {
        const updated: ConversationEpisode = {
          ...latest,
          startedAt: message.eventAt.getTime() < latest.startedAt.getTime() ? copyDate(message.eventAt) : copyDate(latest.startedAt),
          lastMessageAt: message.eventAt.getTime() > latest.lastMessageAt.getTime() ? copyDate(message.eventAt) : copyDate(latest.lastMessageAt),
          endedAt: null,
        };
        await repository.updateEpisode(updated);
        return updated;
      }
      if (gap > CONVERSATION_SILENCE_MS) {
        await repository.updateEpisode({ ...latest, endedAt: copyDate(latest.lastMessageAt) });
      }
    }

    const episode: ConversationEpisode = {
      id: nextId(),
      groupId: message.groupId,
      startedAt: copyDate(message.eventAt),
      lastMessageAt: copyDate(message.eventAt),
      endedAt: null,
    };
    await repository.createEpisode(episode);
    return episode;
  };

  const buildContext = async (query: ContextQuery): Promise<ConversationContext> => {
    if (!query.groupId.trim()) throw new TypeError("Context groupId is required");
    let anchorAt = query.anchorAt ? copyDate(query.anchorAt) : undefined;
    let anchorMessage: ConversationMessage | null = null;
    if (query.anchorMessageId) anchorMessage = await repository.findMessage(query.groupId, query.anchorMessageId);
    if (!anchorAt && anchorMessage) anchorAt = copyDate(anchorMessage.eventAt);
    if (!anchorAt) throw new TypeError("Context requires anchorAt or an existing anchorMessageId");
    assertDate(anchorAt, "context.anchorAt");

    const limit = query.limit ?? CONTEXT_MESSAGE_LIMIT;
    if (!Number.isInteger(limit) || limit <= 0) throw new TypeError("Context limit must be a positive integer");
    const windowStartedAt = new Date(anchorAt.getTime() - CONTEXT_WINDOW_MS);
    const listed = await repository.listMessages({ groupId: query.groupId, from: windowStartedAt, to: anchorAt, limit: Math.max(limit, CONTEXT_MESSAGE_LIMIT) });
    const filtered = sortMessages(listed.filter((message) => message.groupId === query.groupId && activeMessage(message) && message.eventAt >= windowStartedAt && message.eventAt <= anchorAt));
    const selected = filtered.slice(-Math.min(limit, CONTEXT_MESSAGE_LIMIT));
    const messages = await Promise.all(selected.map(async (message) => {
      if (!message.quotedMessageId) return { message };
      const quoted = await repository.findMessage(query.groupId, message.quotedMessageId);
      return quoted && activeMessage(quoted) ? { message, quotedSource: quoted } : { message };
    }));
    const episode = query.episodeId
      ? undefined
      : anchorMessage
        ? await repository.findEpisodeContaining?.(query.groupId, anchorMessage.eventAt)
        : await repository.findEpisodeContaining?.(query.groupId, anchorAt);
    return {
      groupId: query.groupId,
      ...(query.episodeId ? { episodeId: query.episodeId } : episode?.id ? { episodeId: episode.id } : {}),
      anchorAt,
      windowStartedAt,
      messages,
    };
  };

  const evaluateCandidate = async (input: CandidateAnalysisInput): Promise<CandidateAnalysis> => {
    if (!input.groupId.trim() || !input.candidateMessageId.trim()) throw new TypeError("Candidate groupId and messageId are required");
    const candidate = await repository.findMessage(input.groupId, input.candidateMessageId);
    if (!candidate || !activeMessage(candidate)) return { answeredByHuman: false, answeringMessageIds: [], staleContext: true, staleMessageIds: [], relevantMessageIds: [...input.relevantMessageIds] };
    const asOf = input.asOf ? copyDate(input.asOf) : new Date();
    assertDate(asOf, "candidate.asOf");
    const relevant = new Set(input.relevantMessageIds);
    const messages = await repository.listMessages({ groupId: input.groupId, from: candidate.eventAt, to: asOf, limit: Number.MAX_SAFE_INTEGER });
    const later = sortMessages(messages.filter((message) => activeMessage(message) && message.id !== candidate.id && message.eventAt > candidate.eventAt && message.eventAt <= asOf));
    const answeringMessageIds = later.filter((message) => (message.authorKind ?? "human") === "human" && relevant.has(message.id)).map((message) => message.id);
    const missingRelevantIds = (await Promise.all(input.relevantMessageIds.map(async (messageId) => (await repository.findMessage(input.groupId, messageId)) ? null : messageId))).filter((messageId): messageId is string => messageId !== null);
    const staleMessageIds = [...later.filter((message) => !relevant.has(message.id)).map((message) => message.id), ...missingRelevantIds];
    return {
      answeredByHuman: answeringMessageIds.length > 0,
      answeringMessageIds,
      staleContext: staleMessageIds.length > 0,
      staleMessageIds,
      relevantMessageIds: [...input.relevantMessageIds],
    };
  };

  const renderContext = (context: ConversationContext): RenderedContext => ({
    trustedMetadata: {
      groupId: context.groupId,
      ...(context.episodeId ? { episodeId: context.episodeId } : {}),
      messageIds: context.messages.map(({ message }) => message.id),
      windowStartedAt: context.windowStartedAt.toISOString(),
      anchorAt: context.anchorAt.toISOString(),
    },
    untrustedUserText: context.messages.map(({ message }) => ({
      messageId: message.id,
      ...(message.senderMemberId !== undefined ? { senderMemberId: message.senderMemberId } : {}),
      eventAt: message.eventAt.toISOString(),
      type: message.type,
      text: message.text ?? null,
      ...(message.quotedMessageId ? { quotedMessageId: message.quotedMessageId } : {}),
    })),
  });

  return { assignMessageToEpisode, buildContext, evaluateCandidate, renderContext };
}

export const createConversationEpisodeService = createConversationService;
