import type { LineEvent } from "../line-adapter/index.ts";
import type { WebhookIngestHandler, WebhookIngestRepository, WebhookIngestResult } from "./types.ts";

/**
 * HTTP composition verifies a webhook before calling this handler. Keeping the
 * boundary event-based means invalid signatures cannot reach persistence and
 * this module never performs AI or network work before its transaction commits.
 */
export function createWebhookIngestHandler(repository: WebhookIngestRepository): WebhookIngestHandler {
  const handleVerifiedEvent = (event: LineEvent): Promise<WebhookIngestResult> => repository.recordVerifiedEvent(event);
  return {
    handleVerifiedEvent,
    handle: handleVerifiedEvent,
  };
}

export async function handleVerifiedEvent(
  repository: WebhookIngestRepository,
  event: LineEvent,
): Promise<WebhookIngestResult> {
  return repository.recordVerifiedEvent(event);
}

export const createWebhookIngestService = createWebhookIngestHandler;
