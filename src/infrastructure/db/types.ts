import type { ColumnType, Kysely } from "kysely";

/** PostgreSQL timestamptz values are returned by `pg` as UTC Date instances. */
export type Timestamp = ColumnType<Date, Date | string, Date | string>;
export type DefaultTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonColumn = ColumnType<JsonValue, JsonValue, JsonValue>;
export type DefaultJsonColumn = ColumnType<JsonValue, JsonValue | undefined, JsonValue>;

export interface GroupsTable {
  id: string;
  line_group_id: string;
  display_name: string | null;
  joined_at: DefaultTimestamp;
  left_at: Timestamp | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface GroupSettingsTable {
  group_id: string;
  mode: "polite" | "normal" | "teasing";
  muted_until: Timestamp | null;
  ambient_enabled: boolean;
  ambient_min_delay_seconds: number;
  ambient_max_delay_seconds: number;
  ambient_cooldown_seconds: number;
  daily_token_budget: number;
  raw_message_retention_days: number;
  content_log_retention_days: number;
  persona_decay_days: number;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface MembersTable {
  id: string;
  group_id: string;
  line_user_id: string;
  display_name: string | null;
  joined_at: DefaultTimestamp;
  left_at: Timestamp | null;
  memory_opted_out: boolean;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface MemberAliasesTable {
  id: string;
  group_id: string;
  member_id: string;
  alias: string;
  normalized_alias: string;
  is_primary: boolean;
  created_at: DefaultTimestamp;
}

export interface WebhookEventsTable {
  id: string;
  webhook_event_id: string;
  group_id: string | null;
  event_type: string;
  event_at: Timestamp;
  received_at: DefaultTimestamp;
  redelivered: boolean;
  payload: DefaultJsonColumn;
  created_at: DefaultTimestamp;
}

export interface MessagesTable {
  id: string;
  webhook_event_id: string;
  group_id: string;
  sender_member_id: string | null;
  line_message_id: string | null;
  message_type: "text" | "sticker" | "image" | "video" | "audio" | "file" | "other";
  text_content: string | null;
  media_metadata: DefaultJsonColumn;
  line_quoted_message_id: string | null;
  sent_at: Timestamp;
  received_at: DefaultTimestamp;
  reply_token: string | null;
  reply_token_received_at: Timestamp | null;
  reply_token_expires_at: Timestamp | null;
  created_at: DefaultTimestamp;
}

export interface MessageTombstonesTable {
  id: string;
  group_id: string;
  message_id: string | null;
  line_message_id: string;
  reason: "unsent" | "forgotten" | "retention";
  invalidated_at: Timestamp;
  created_at: DefaultTimestamp;
}

export interface ConversationEpisodesTable {
  id: string;
  group_id: string;
  started_at: Timestamp;
  last_message_at: Timestamp;
  ended_at: Timestamp | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface DelayedJobsTable {
  id: string;
  group_id: string;
  job_type: string;
  status: "pending" | "claimed" | "completed" | "cancelled" | "failed" | "expired";
  idempotency_key: string;
  due_at: Timestamp;
  attempts: number;
  locked_at: Timestamp | null;
  locked_by: string | null;
  source_message_id: string | null;
  episode_id: string | null;
  payload: DefaultJsonColumn;
  last_error: string | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface BotResponsesTable {
  id: string;
  group_id: string;
  idempotency_key: string;
  source_message_id: string | null;
  job_id: string | null;
  state: "pending" | "claimed" | "sent" | "unknown" | "suppressed" | "cancelled";
  reply_token: string | null;
  reply_token_received_at: Timestamp | null;
  reply_token_expires_at: Timestamp | null;
  claimed_at: Timestamp | null;
  delivered_at: Timestamp | null;
  suppression_reason: string | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface PersonaObservationsTable {
  id: string;
  group_id: string;
  subject_member_id: string;
  source_message_id: string | null;
  extracted_by_member_id: string | null;
  category: string;
  claim: string;
  source_strength: "self_explicit" | "self_behavioral" | "third_party" | "self_correction";
  confidence: number;
  visibility: "public_safe" | "private" | "risky";
  status: "active" | "invalidated";
  observed_at: Timestamp;
  invalidated_at: Timestamp | null;
  invalidation_reason: string | null;
  metadata: DefaultJsonColumn;
  created_at: DefaultTimestamp;
}

export interface PersonaFactsTable {
  id: string;
  group_id: string;
  subject_member_id: string;
  category: string;
  claim: string;
  confidence: number;
  visibility: "public_safe" | "private" | "risky";
  active: boolean;
  first_seen_at: Timestamp;
  last_seen_at: Timestamp;
  expires_or_decay_at: Timestamp;
  archived_at: Timestamp | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface PersonaFactObservationsTable {
  fact_id: string;
  observation_id: string;
  is_supporting: boolean;
  linked_at: DefaultTimestamp;
}

export interface DecisionRecordsTable {
  id: string;
  group_id: string;
  source_message_id: string | null;
  episode_id: string | null;
  response_id: string | null;
  decision_type: "direct" | "ambient";
  respond: boolean;
  reason: string;
  interest_score: number | null;
  answered_by_human: boolean | null;
  safety: "allowed" | "blocked" | "uncertain";
  draft: string | null;
  used_fact_ids: DefaultJsonColumn;
  suppression_reason: string | null;
  created_at: DefaultTimestamp;
}

export interface AiUsageEventsTable {
  id: string;
  group_id: string | null;
  decision_id: string | null;
  operation: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  occurred_at: Timestamp;
  request_id: string | null;
  metadata: DefaultJsonColumn;
}

export interface FeedbackSignalsTable {
  id: string;
  group_id: string;
  response_id: string | null;
  member_id: string | null;
  signal: string;
  value: number | null;
  created_at: DefaultTimestamp;
}

export interface AuditEventsTable {
  id: string;
  group_id: string | null;
  actor_member_id: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  metadata: DefaultJsonColumn;
  created_at: DefaultTimestamp;
}

export interface ContentDebugLogsTable {
  id: string;
  group_id: string | null;
  correlation_id: string | null;
  level: "debug" | "info" | "warn" | "error";
  event_name: string;
  payload: DefaultJsonColumn;
  contains_content: boolean;
  created_at: DefaultTimestamp;
  expires_at: Timestamp;
}

export interface Database {
  groups: GroupsTable;
  group_settings: GroupSettingsTable;
  members: MembersTable;
  member_aliases: MemberAliasesTable;
  webhook_events: WebhookEventsTable;
  messages: MessagesTable;
  message_tombstones: MessageTombstonesTable;
  conversation_episodes: ConversationEpisodesTable;
  delayed_jobs: DelayedJobsTable;
  bot_responses: BotResponsesTable;
  persona_observations: PersonaObservationsTable;
  persona_facts: PersonaFactsTable;
  persona_fact_observations: PersonaFactObservationsTable;
  decision_records: DecisionRecordsTable;
  ai_usage_events: AiUsageEventsTable;
  feedback_signals: FeedbackSignalsTable;
  audit_events: AuditEventsTable;
  content_debug_logs: ContentDebugLogsTable;
}

export type DatabaseClient = Kysely<Database>;
