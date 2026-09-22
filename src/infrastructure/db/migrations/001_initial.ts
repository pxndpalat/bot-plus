import { CompiledQuery, type Kysely } from "kysely";
import type { Database } from "../types.ts";

export const MIGRATION_NAME = "001_initial";

const UP_SQL = String.raw`
CREATE TABLE groups (
  id text PRIMARY KEY,
  line_group_id text NOT NULL UNIQUE,
  display_name text,
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT groups_left_after_join CHECK (left_at IS NULL OR left_at >= joined_at)
);

CREATE TABLE group_settings (
  group_id text PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'normal' CHECK (mode IN ('polite', 'normal', 'teasing')),
  muted_until timestamptz,
  ambient_enabled boolean NOT NULL DEFAULT true,
  ambient_min_delay_seconds integer NOT NULL DEFAULT 15 CHECK (ambient_min_delay_seconds BETWEEN 15 AND 30),
  ambient_max_delay_seconds integer NOT NULL DEFAULT 30 CHECK (ambient_max_delay_seconds BETWEEN 15 AND 30),
  ambient_cooldown_seconds integer NOT NULL DEFAULT 180 CHECK (ambient_cooldown_seconds BETWEEN 180 AND 300),
  daily_token_budget integer NOT NULL DEFAULT 100000 CHECK (daily_token_budget >= 0),
  raw_message_retention_days integer NOT NULL DEFAULT 30 CHECK (raw_message_retention_days > 0),
  content_log_retention_days integer NOT NULL DEFAULT 7 CHECK (content_log_retention_days > 0),
  persona_decay_days integer NOT NULL DEFAULT 180 CHECK (persona_decay_days > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT group_settings_delay_range CHECK (ambient_max_delay_seconds >= ambient_min_delay_seconds)
);

CREATE TABLE members (
  id text PRIMARY KEY,
  group_id text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  line_user_id text NOT NULL,
  display_name text,
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  memory_opted_out boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id, line_user_id),
  CONSTRAINT members_left_after_join CHECK (left_at IS NULL OR left_at >= joined_at)
);

CREATE TABLE member_aliases (
  id text PRIMARY KEY,
  group_id text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  member_id text NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  alias text NOT NULL CHECK (length(trim(alias)) > 0),
  normalized_alias text NOT NULL CHECK (length(trim(normalized_alias)) > 0),
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id, normalized_alias)
);

CREATE TABLE webhook_events (
  id text PRIMARY KEY,
  webhook_event_id text NOT NULL UNIQUE,
  group_id text REFERENCES groups(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  event_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  redelivered boolean NOT NULL DEFAULT false,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id text PRIMARY KEY,
  webhook_event_id text NOT NULL REFERENCES webhook_events(id) ON DELETE RESTRICT,
  group_id text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  sender_member_id text REFERENCES members(id) ON DELETE SET NULL,
  line_message_id text UNIQUE,
  message_type text NOT NULL CHECK (message_type IN ('text', 'sticker', 'image', 'video', 'audio', 'file', 'other')),
  text_content text,
  media_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  line_quoted_message_id text,
  sent_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  reply_token text,
  reply_token_received_at timestamptz,
  reply_token_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT messages_reply_token_timing CHECK (
    reply_token IS NULL
    OR (reply_token_received_at IS NOT NULL AND reply_token_expires_at IS NOT NULL AND reply_token_expires_at > reply_token_received_at)
  )
);

CREATE TABLE message_tombstones (
  id text PRIMARY KEY,
  group_id text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  message_id text REFERENCES messages(id) ON DELETE SET NULL,
  line_message_id text NOT NULL UNIQUE,
  reason text NOT NULL CHECK (reason IN ('unsent', 'forgotten', 'retention')),
  invalidated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE conversation_episodes (
  id text PRIMARY KEY,
  group_id text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL,
  last_message_at timestamptz NOT NULL,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_episodes_order CHECK (last_message_at >= started_at AND (ended_at IS NULL OR ended_at >= last_message_at))
);

CREATE TABLE delayed_jobs (
  id text PRIMARY KEY,
  group_id text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  job_type text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'completed', 'cancelled', 'failed', 'expired')),
  idempotency_key text NOT NULL,
  due_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  locked_at timestamptz,
  locked_by text,
  source_message_id text REFERENCES messages(id) ON DELETE SET NULL,
  episode_id text REFERENCES conversation_episodes(id) ON DELETE SET NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (idempotency_key)
);

CREATE TABLE bot_responses (
  id text PRIMARY KEY,
  group_id text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL UNIQUE,
  source_message_id text REFERENCES messages(id) ON DELETE SET NULL,
  job_id text REFERENCES delayed_jobs(id) ON DELETE SET NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'claimed', 'sent', 'unknown', 'suppressed', 'cancelled')),
  reply_token text,
  reply_token_received_at timestamptz,
  reply_token_expires_at timestamptz,
  claimed_at timestamptz,
  delivered_at timestamptz,
  suppression_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bot_responses_reply_token_timing CHECK (
    reply_token IS NULL
    OR (reply_token_received_at IS NOT NULL AND reply_token_expires_at IS NOT NULL AND reply_token_expires_at > reply_token_received_at)
  )
);

CREATE TABLE persona_observations (
  id text PRIMARY KEY,
  group_id text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  subject_member_id text NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  source_message_id text REFERENCES messages(id) ON DELETE SET NULL,
  extracted_by_member_id text REFERENCES members(id) ON DELETE SET NULL,
  category text NOT NULL,
  claim text NOT NULL CHECK (length(trim(claim)) > 0),
  source_strength text NOT NULL CHECK (source_strength IN ('self_explicit', 'self_behavioral', 'third_party', 'self_correction')),
  confidence double precision NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  visibility text NOT NULL CHECK (visibility IN ('public_safe', 'private', 'risky')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invalidated')),
  observed_at timestamptz NOT NULL,
  invalidated_at timestamptz,
  invalidation_reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT observations_invalidation_timing CHECK (
    (status = 'active' AND invalidated_at IS NULL) OR (status = 'invalidated' AND invalidated_at IS NOT NULL)
  )
);

CREATE TABLE persona_facts (
  id text PRIMARY KEY,
  group_id text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  subject_member_id text NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  category text NOT NULL,
  claim text NOT NULL CHECK (length(trim(claim)) > 0),
  confidence double precision NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  visibility text NOT NULL CHECK (visibility IN ('public_safe', 'private', 'risky')),
  active boolean NOT NULL DEFAULT true,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  expires_or_decay_at timestamptz NOT NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT facts_time_order CHECK (last_seen_at >= first_seen_at AND expires_or_decay_at >= last_seen_at),
  CONSTRAINT facts_archive_state CHECK ((active AND archived_at IS NULL) OR (NOT active))
);

CREATE TABLE persona_fact_observations (
  fact_id text NOT NULL REFERENCES persona_facts(id) ON DELETE CASCADE,
  observation_id text NOT NULL REFERENCES persona_observations(id) ON DELETE RESTRICT,
  is_supporting boolean NOT NULL DEFAULT true,
  linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (fact_id, observation_id)
);

CREATE TABLE decision_records (
  id text PRIMARY KEY,
  group_id text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  source_message_id text REFERENCES messages(id) ON DELETE SET NULL,
  episode_id text REFERENCES conversation_episodes(id) ON DELETE SET NULL,
  response_id text REFERENCES bot_responses(id) ON DELETE SET NULL,
  decision_type text NOT NULL CHECK (decision_type IN ('direct', 'ambient')),
  respond boolean NOT NULL,
  reason text NOT NULL,
  interest_score double precision CHECK (interest_score BETWEEN 0 AND 1),
  answered_by_human boolean,
  safety text NOT NULL CHECK (safety IN ('allowed', 'blocked', 'uncertain')),
  draft text,
  used_fact_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  suppression_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ai_usage_events (
  id text PRIMARY KEY,
  group_id text REFERENCES groups(id) ON DELETE SET NULL,
  decision_id text REFERENCES decision_records(id) ON DELETE SET NULL,
  operation text NOT NULL,
  model text NOT NULL,
  input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  total_tokens integer NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
  occurred_at timestamptz NOT NULL,
  request_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE feedback_signals (
  id text PRIMARY KEY,
  group_id text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  response_id text REFERENCES bot_responses(id) ON DELETE SET NULL,
  member_id text REFERENCES members(id) ON DELETE SET NULL,
  signal text NOT NULL,
  value double precision,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
  id text PRIMARY KEY,
  group_id text REFERENCES groups(id) ON DELETE SET NULL,
  actor_member_id text REFERENCES members(id) ON DELETE SET NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE content_debug_logs (
  id text PRIMARY KEY,
  group_id text REFERENCES groups(id) ON DELETE SET NULL,
  correlation_id text,
  level text NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  event_name text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  contains_content boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX webhook_events_group_event_at_idx ON webhook_events (group_id, event_at DESC);
CREATE INDEX messages_context_idx ON messages (group_id, sent_at DESC);
CREATE INDEX messages_episode_idx ON messages (group_id, sent_at DESC, id);
CREATE INDEX messages_quoted_idx ON messages (group_id, line_quoted_message_id) WHERE line_quoted_message_id IS NOT NULL;
CREATE INDEX message_tombstones_group_invalidated_idx ON message_tombstones (group_id, invalidated_at DESC);
CREATE INDEX conversation_episodes_context_idx ON conversation_episodes (group_id, last_message_at DESC);
CREATE INDEX delayed_jobs_due_poll_idx ON delayed_jobs (status, due_at) WHERE status = 'pending';
CREATE INDEX delayed_jobs_source_message_idx ON delayed_jobs (source_message_id) WHERE source_message_id IS NOT NULL;
CREATE INDEX bot_responses_source_idx ON bot_responses (source_message_id) WHERE source_message_id IS NOT NULL;
CREATE INDEX persona_observations_retrieval_idx ON persona_observations (group_id, subject_member_id, category, status, confidence DESC, observed_at DESC);
CREATE INDEX persona_observations_source_message_idx ON persona_observations (source_message_id) WHERE source_message_id IS NOT NULL;
CREATE INDEX persona_facts_retrieval_idx ON persona_facts (group_id, subject_member_id, category, active, confidence DESC, last_seen_at DESC);
CREATE INDEX persona_fact_observations_observation_idx ON persona_fact_observations (observation_id);
CREATE INDEX decision_records_group_created_idx ON decision_records (group_id, created_at DESC);
CREATE INDEX ai_usage_daily_budget_idx ON ai_usage_events (group_id, occurred_at DESC);
CREATE INDEX feedback_response_idx ON feedback_signals (response_id) WHERE response_id IS NOT NULL;
CREATE INDEX audit_events_group_created_idx ON audit_events (group_id, created_at DESC);
CREATE INDEX content_debug_logs_expiry_idx ON content_debug_logs (expires_at);

CREATE OR REPLACE FUNCTION ensure_active_fact_has_observation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM persona_facts f WHERE f.id = COALESCE(NEW.fact_id, OLD.fact_id) AND f.active)
     AND NOT EXISTS (SELECT 1 FROM persona_fact_observations fo WHERE fo.fact_id = COALESCE(NEW.fact_id, OLD.fact_id)) THEN
    RAISE EXCEPTION 'active persona fact % must have at least one observation', COALESCE(NEW.fact_id, OLD.fact_id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER active_fact_requires_observation_on_link
AFTER INSERT OR UPDATE OR DELETE ON persona_fact_observations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ensure_active_fact_has_observation();

CREATE OR REPLACE FUNCTION ensure_active_fact_has_observation_on_fact() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.active AND NOT EXISTS (SELECT 1 FROM persona_fact_observations fo WHERE fo.fact_id = NEW.id) THEN
    RAISE EXCEPTION 'active persona fact % must have at least one observation', NEW.id;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER active_fact_requires_observation_on_fact
AFTER INSERT OR UPDATE OF active ON persona_facts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ensure_active_fact_has_observation_on_fact();
`;

const DOWN_SQL = String.raw`
DROP TRIGGER IF EXISTS active_fact_requires_observation_on_fact ON persona_facts;
DROP TRIGGER IF EXISTS active_fact_requires_observation_on_link ON persona_fact_observations;
DROP FUNCTION IF EXISTS ensure_active_fact_has_observation_on_fact();
DROP FUNCTION IF EXISTS ensure_active_fact_has_observation();
DROP TABLE IF EXISTS content_debug_logs;
DROP TABLE IF EXISTS audit_events;
DROP TABLE IF EXISTS feedback_signals;
DROP TABLE IF EXISTS ai_usage_events;
DROP TABLE IF EXISTS decision_records;
DROP TABLE IF EXISTS persona_fact_observations;
DROP TABLE IF EXISTS persona_facts;
DROP TABLE IF EXISTS persona_observations;
DROP TABLE IF EXISTS bot_responses;
DROP TABLE IF EXISTS delayed_jobs;
DROP TABLE IF EXISTS conversation_episodes;
DROP TABLE IF EXISTS message_tombstones;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS webhook_events;
DROP TABLE IF EXISTS member_aliases;
DROP TABLE IF EXISTS members;
DROP TABLE IF EXISTS group_settings;
DROP TABLE IF EXISTS groups;
`;

export async function up(db: Kysely<Database>): Promise<void> {
  await db.executeQuery(CompiledQuery.raw(UP_SQL));
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.executeQuery(CompiledQuery.raw(DOWN_SQL));
}

export const migration = { up, down };
