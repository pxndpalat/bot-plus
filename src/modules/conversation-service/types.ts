export const CONVERSATION_SILENCE_MS = 10 * 60 * 1000;
export const CONTEXT_WINDOW_MS = 10 * 60 * 1000;
export const CONTEXT_MESSAGE_LIMIT = 30;

export type ConversationMessageType = "text" | "sticker" | "image" | "video" | "audio" | "file" | "other";
export type MessageAuthorKind = "human" | "bot";
export type MessageLifecycle = "active" | "deleted" | "forgotten" | "tombstoned";

export interface ConversationMessage {
  readonly id: string;
  readonly groupId: string;
  readonly senderMemberId?: string | null;
  readonly authorKind?: MessageAuthorKind;
  readonly lineMessageId?: string | null;
  readonly type: ConversationMessageType;
  readonly text?: string | null;
  readonly quotedMessageId?: string | null;
  readonly eventAt: Date;
  readonly receivedAt?: Date;
  readonly lifecycle?: MessageLifecycle;
}

export interface ConversationEpisode {
  readonly id: string;
  readonly groupId: string;
  readonly startedAt: Date;
  readonly lastMessageAt: Date;
  readonly endedAt?: Date | null;
}

export interface ConversationMessageQuery {
  readonly groupId: string;
  readonly from?: Date;
  readonly to?: Date;
  readonly limit?: number;
}

export interface ConversationRepository {
  readonly getLatestEpisode: (groupId: string) => Promise<ConversationEpisode | null>;
  readonly findEpisodeContaining?: (groupId: string, eventAt: Date) => Promise<ConversationEpisode | null>;
  readonly createEpisode: (episode: ConversationEpisode) => Promise<void>;
  readonly updateEpisode: (episode: ConversationEpisode) => Promise<void>;
  readonly listMessages: (query: ConversationMessageQuery) => Promise<readonly ConversationMessage[]>;
  readonly findMessage: (groupId: string, messageId: string) => Promise<ConversationMessage | null>;
}

export interface ConversationService {
  readonly assignMessageToEpisode: (message: ConversationMessage) => Promise<ConversationEpisode>;
  readonly buildContext: (query: ContextQuery) => Promise<ConversationContext>;
  readonly evaluateCandidate: (input: CandidateAnalysisInput) => Promise<CandidateAnalysis>;
  readonly renderContext: (context: ConversationContext) => RenderedContext;
}

export interface ContextQuery {
  readonly groupId: string;
  readonly anchorAt?: Date;
  readonly anchorMessageId?: string;
  readonly episodeId?: string;
  readonly limit?: number;
}

export interface ContextMessage {
  readonly message: ConversationMessage;
  readonly quotedSource?: ConversationMessage;
}

export interface ConversationContext {
  readonly groupId: string;
  readonly episodeId?: string;
  readonly anchorAt: Date;
  readonly windowStartedAt: Date;
  readonly messages: readonly ContextMessage[];
}

export interface CandidateAnalysisInput {
  readonly groupId: string;
  readonly candidateMessageId: string;
  readonly relevantMessageIds: readonly string[];
  readonly asOf?: Date;
}

export interface CandidateAnalysis {
  readonly answeredByHuman: boolean;
  readonly answeringMessageIds: readonly string[];
  readonly staleContext: boolean;
  readonly staleMessageIds: readonly string[];
  readonly relevantMessageIds: readonly string[];
}

export interface TrustedContextMetadata {
  readonly groupId: string;
  readonly episodeId?: string;
  readonly messageIds: readonly string[];
  readonly windowStartedAt: string;
  readonly anchorAt: string;
}

export interface UntrustedContextMessage {
  readonly messageId: string;
  readonly senderMemberId?: string | null;
  readonly eventAt: string;
  readonly type: ConversationMessageType;
  readonly text: string | null;
  readonly quotedMessageId?: string | null;
}

export interface RenderedContext {
  readonly trustedMetadata: TrustedContextMetadata;
  readonly untrustedUserText: readonly UntrustedContextMessage[];
}
