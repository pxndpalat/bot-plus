# Implementation Contracts

สถานะ: Locked for MVP implementation  
Package manager: npm 10 (package-lock.json)

## Module boundaries

- `src/app` เป็น composition root และเป็นที่เดียวที่ประกอบ infrastructure implementations
- `src/modules/<module>/index.ts` เป็น public API ของแต่ละโมดูล ห้าม deep import ข้ามโมดูล
- `src/shared` มีเฉพาะ contracts และ deterministic primitives ที่ไม่มี business logic
- `src/infrastructure/db` เป็นเจ้าของ Kysely database types, migrations และ repository implementations
- ทุก timestamp เก็บเป็น UTC; daily budget คำนวณตาม `Asia/Bangkok`

## Table ownership

| Owner | Tables |
|---|---|
| webhook-ingest | `webhook_events`, `messages`, `message_tombstones` |
| conversation/job-runner | `conversation_episodes`, `delayed_jobs`, `bot_responses` |
| persona-service | `members`, `member_aliases`, `persona_observations`, `persona_facts`, `persona_fact_observations` |
| decision-engine | `decision_records`, `ai_usage_events`, `feedback_signals` |
| settings/retention | `groups`, `group_settings`, `audit_events`, `content_debug_logs` |

Repository consumers must use ports. Only the persistence owner edits `migrations/`.

## At-most-once response rule

Before a LINE reply, the response idempotency key is claimed in an irreversible transaction. A transport timeout after claim has an unknown outcome and must not be retried automatically. Duplicate webhooks and restarted jobs therefore cannot create a second reply.

## Failure rules

- Invalid LINE signature: reject without parsing or persistence.
- Database failure during ingest: return non-2xx so LINE may redeliver.
- OpenAI timeout or invalid structured output: retry once; direct uses a neutral fallback, ambient is cancelled.
- Safety `blocked` or `uncertain`: ambient is silent; direct uses a neutral response with no risky facts.
- Reply token older than 45 seconds: expire; never fall back to push.
