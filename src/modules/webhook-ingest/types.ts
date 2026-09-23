import type { LineEvent } from "../line-adapter/index.ts";

export type IngestJobType = "direct" | "ambient_candidate" | "persona_extract" | "unsend" | "join_transparency";

export interface IngestJobIntent {
  readonly type: IngestJobType;
  readonly idempotencyKey: string;
  readonly dueAt: Date;
  readonly sourceMessageId?: string;
}

export interface WebhookIngestResult {
  readonly duplicate: boolean;
  readonly webhookEventId: string;
  readonly databaseEventId?: string;
  readonly messageId?: string;
  readonly jobs: readonly IngestJobIntent[];
}

export interface WebhookIngestRepository {
  recordVerifiedEvent(event: LineEvent): Promise<WebhookIngestResult>;
  ingest?(event: LineEvent): Promise<WebhookIngestResult>;
}

export interface WebhookIngestHandler {
  handleVerifiedEvent(event: LineEvent): Promise<WebhookIngestResult>;
  handle?(event: LineEvent): Promise<WebhookIngestResult>;
}
