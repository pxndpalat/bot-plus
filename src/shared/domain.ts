/**
 * Opaque identifiers used at module boundaries.  LINE identifiers are
 * intentionally kept as strings: the application must never infer structure
 * from a provider id.
 */
export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type GroupId = Brand<string, "GroupId">;
export type MemberId = Brand<string, "MemberId">;
export type WebhookEventId = Brand<string, "WebhookEventId">;
export type MessageId = Brand<string, "MessageId">;
export type JobId = Brand<string, "JobId">;
export type ResponseId = Brand<string, "ResponseId">;
export type ObservationId = Brand<string, "ObservationId">;
export type FactId = Brand<string, "FactId">;

export type DomainId =
  | GroupId
  | MemberId
  | WebhookEventId
  | MessageId
  | JobId
  | ResponseId
  | ObservationId
  | FactId;

function brandId<T extends DomainId>(value: string, label: string): T {
  if (value.trim().length === 0 || value !== value.trim()) {
    throw new TypeError(`${label} must be a non-empty trimmed string`);
  }

  return value as T;
}

export const toGroupId = (value: string): GroupId => brandId<GroupId>(value, "GroupId");
export const toMemberId = (value: string): MemberId => brandId<MemberId>(value, "MemberId");
export const toWebhookEventId = (value: string): WebhookEventId =>
  brandId<WebhookEventId>(value, "WebhookEventId");
export const toMessageId = (value: string): MessageId => brandId<MessageId>(value, "MessageId");
export const toJobId = (value: string): JobId => brandId<JobId>(value, "JobId");
export const toResponseId = (value: string): ResponseId => brandId<ResponseId>(value, "ResponseId");
export const toObservationId = (value: string): ObservationId =>
  brandId<ObservationId>(value, "ObservationId");
export const toFactId = (value: string): FactId => brandId<FactId>(value, "FactId");

// Verbose aliases read naturally at parsing boundaries.
export const parseGroupId = toGroupId;
export const parseMemberId = toMemberId;
export const parseWebhookEventId = toWebhookEventId;
export const parseMessageId = toMessageId;
export const parseJobId = toJobId;
export const parseResponseId = toResponseId;
export const parseObservationId = toObservationId;
export const parseFactId = toFactId;

export const serializeId = (id: DomainId): string => id;

export type FactVisibility = "public_safe" | "private" | "risky";

export interface Group {
  readonly id: GroupId;
}

export interface Member {
  readonly id: MemberId;
  readonly groupId: GroupId;
  readonly displayName?: string;
}

export interface WebhookEvent {
  readonly id: WebhookEventId;
  readonly groupId?: GroupId;
  readonly receivedAt: Date;
  readonly eventAt: Date;
}

export interface Message {
  readonly id: MessageId;
  readonly groupId: GroupId;
  readonly senderId?: MemberId;
  readonly sentAt: Date;
}

export interface Job {
  readonly id: JobId;
  readonly dueAt: Date;
}

export interface Response {
  readonly id: ResponseId;
  readonly groupId: GroupId;
}

export interface Observation {
  readonly id: ObservationId;
  readonly subjectMemberId: MemberId;
  readonly sourceMessageId?: MessageId;
  readonly observedAt: Date;
}

export interface Fact {
  readonly id: FactId;
  readonly subjectMemberId: MemberId;
  readonly claim: string;
  readonly visibility: FactVisibility;
  readonly observationIds: readonly ObservationId[];
}
