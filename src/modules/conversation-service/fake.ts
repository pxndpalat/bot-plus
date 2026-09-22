import type { ConversationEpisode, ConversationMessage, ConversationMessageQuery, ConversationRepository } from "./types.ts";

export interface InMemoryConversationRepository extends ConversationRepository {
  readonly episodes: ConversationEpisode[];
  readonly messages: ConversationMessage[];
  readonly addMessage: (message: ConversationMessage) => void;
}

function copyEpisode(episode: ConversationEpisode): ConversationEpisode {
  return {
    ...episode,
    startedAt: new Date(episode.startedAt.getTime()),
    lastMessageAt: new Date(episode.lastMessageAt.getTime()),
    endedAt: episode.endedAt ? new Date(episode.endedAt.getTime()) : episode.endedAt,
  };
}

export function createInMemoryConversationRepository(initialMessages: readonly ConversationMessage[] = []): InMemoryConversationRepository {
  const episodes: ConversationEpisode[] = [];
  const messages: ConversationMessage[] = initialMessages.map((message) => ({ ...message, eventAt: new Date(message.eventAt.getTime()) }));
  return {
    episodes,
    messages,
    addMessage(message) {
      if (!messages.some((existing) => existing.id === message.id)) messages.push({ ...message, eventAt: new Date(message.eventAt.getTime()) });
    },
    async getLatestEpisode(groupId) {
      const latest = episodes.filter((episode) => episode.groupId === groupId).sort((left, right) => right.lastMessageAt.getTime() - left.lastMessageAt.getTime() || right.id.localeCompare(left.id))[0];
      return latest ? copyEpisode(latest) : null;
    },
    async findEpisodeContaining(groupId, eventAt) {
      const matches = episodes.filter((episode) => episode.groupId === groupId && eventAt >= episode.startedAt && eventAt.getTime() <= episode.lastMessageAt.getTime() + 10 * 60 * 1000);
      const match = matches.sort((left, right) => right.lastMessageAt.getTime() - left.lastMessageAt.getTime() || right.id.localeCompare(left.id))[0];
      return match ? copyEpisode(match) : null;
    },
    async createEpisode(episode) {
      if (!episodes.some((existing) => existing.id === episode.id)) episodes.push(copyEpisode(episode));
    },
    async updateEpisode(episode) {
      const index = episodes.findIndex((existing) => existing.id === episode.id);
      if (index < 0) throw new Error(`Unknown episode ${episode.id}`);
      episodes[index] = copyEpisode(episode);
    },
    async listMessages(query: ConversationMessageQuery) {
      return messages
        .filter((message) => message.groupId === query.groupId && (!query.from || message.eventAt >= query.from) && (!query.to || message.eventAt <= query.to))
        .sort((left, right) => left.eventAt.getTime() - right.eventAt.getTime() || left.id.localeCompare(right.id))
        .slice(-(query.limit ?? Number.MAX_SAFE_INTEGER))
        .map((message) => ({ ...message, eventAt: new Date(message.eventAt.getTime()) }));
    },
    async findMessage(groupId, messageId) {
      const message = messages.find((item) => item.groupId === groupId && (item.id === messageId || item.lineMessageId === messageId) && (item.lifecycle === undefined || item.lifecycle === "active"));
      return message ? { ...message, eventAt: new Date(message.eventAt.getTime()) } : null;
    },
  };
}

export const createFakeConversationRepository = createInMemoryConversationRepository;
