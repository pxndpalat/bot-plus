# MFB-022 evaluation runbook

This runbook turns the persisted MVP events into the two-week trial metrics.
Queries are PostgreSQL 16 SQL and use the schema in migration `001_initial`.
Always filter by the staging `group_id`; do not export message text or tokens.

## Start and record the evaluation window

```sh
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

In `psql`, set a UTC window and group:

```sql
\set group_id '''C-staging-group'''
\set since '''2026-01-01 00:00:00+00'''
\set until '''2026-01-15 00:00:00+00'''
```

Do not put `LINE_CHANNEL_SECRET`, access tokens, API keys, reply tokens or raw
message content in the report. Use counts, rates and reason categories only.

## Dashboard queries

### Ambient response rate (target 5–10%)

```sql
SELECT
  count(*) FILTER (WHERE decision_type = 'ambient') AS ambient_candidates,
  count(*) FILTER (WHERE decision_type = 'ambient' AND respond) AS ambient_responses,
  round(100.0 * count(*) FILTER (WHERE decision_type = 'ambient' AND respond)
    / NULLIF(count(*) FILTER (WHERE decision_type = 'ambient'), 0), 2) AS ambient_rate_pct
FROM decision_records
WHERE group_id = :'group_id'
  AND created_at >= :'since'::timestamptz
  AND created_at < :'until'::timestamptz;
```

Expected: `ambient_rate_pct` is 5–10% after enough traffic. A small sample is
reported as insufficient rather than forced into a go/no-go decision.

### Follow-up within five minutes (target >=30%)

```sql
WITH sent AS (
  SELECT br.id, br.delivered_at, br.group_id
  FROM bot_responses br
  WHERE br.group_id = :'group_id' AND br.state = 'sent'
    AND br.delivered_at >= :'since'::timestamptz
    AND br.delivered_at < :'until'::timestamptz
), followups AS (
  SELECT DISTINCT s.id
  FROM sent s
  JOIN messages m ON m.group_id = s.group_id
   AND m.sender_member_id IS NOT NULL
   AND m.sent_at > s.delivered_at
   AND m.sent_at <= s.delivered_at + interval '5 minutes'
)
SELECT count(*) AS sent_responses, count(f.id) AS followed_up,
  round(100.0 * count(f.id) / NULLIF(count(*), 0), 2) AS follow_up_pct
FROM sent s LEFT JOIN followups f ON f.id = s.id;
```

Expected: `follow_up_pct >= 30` on a sufficiently large sample. Interpret
silence and a human answer separately when reading the suppression query.

### Negative feedback (target <=10%)

```sql
SELECT count(*) FILTER (WHERE signal = 'negative') AS negative_feedback,
       count(*) AS all_feedback,
       round(100.0 * count(*) FILTER (WHERE signal = 'negative')
         / NULLIF(count(*), 0), 2) AS negative_pct
FROM feedback_signals
WHERE group_id = :'group_id'
  AND created_at >= :'since'::timestamptz
  AND created_at < :'until'::timestamptz;
```

Expected: `negative_pct <= 10`; if there is no feedback, record “insufficient
sample” instead of treating it as zero.

### Token budget and AI cost proxy

```sql
SELECT operation, model, count(*) AS calls,
       sum(input_tokens) AS input_tokens,
       sum(output_tokens) AS output_tokens,
       sum(total_tokens) AS total_tokens
FROM ai_usage_events
WHERE group_id = :'group_id'
  AND occurred_at >= :'since'::timestamptz
  AND occurred_at < :'until'::timestamptz
GROUP BY operation, model
ORDER BY total_tokens DESC;
```

Compare the daily sum with `group_settings.daily_token_budget`; ambient must be
suppressed when the budget is exhausted while direct/command remains the
priority path.

### Suppression distribution

```sql
SELECT decision_type, coalesce(suppression_reason, 'none') AS reason,
       count(*) AS decisions
FROM decision_records
WHERE group_id = :'group_id'
  AND created_at >= :'since'::timestamptz
  AND created_at < :'until'::timestamptz
GROUP BY decision_type, coalesce(suppression_reason, 'none')
ORDER BY decision_type, decisions DESC;
```

Check that `human_answered`, `cooldown`, `low_signal`, `stale_context`,
`stale_reply_token`, `daily_budget_exhausted` and safety reasons are explainable;
unexpected spikes are a stop signal.

### Safety rejection and duplicate invariant

```sql
SELECT safety, count(*) AS decisions
FROM decision_records
WHERE group_id = :'group_id'
  AND created_at >= :'since'::timestamptz
  AND created_at < :'until'::timestamptz
GROUP BY safety;

SELECT count(*) FILTER (WHERE state = 'sent') AS sent,
       count(*) FILTER (WHERE state = 'unknown') AS unknown_transport,
       count(*) FILTER (WHERE state = 'suppressed') AS suppressed,
       count(*) AS response_rows,
       count(DISTINCT idempotency_key) AS unique_idempotency_keys
FROM bot_responses
WHERE group_id = :'group_id'
  AND created_at >= :'since'::timestamptz
  AND created_at < :'until'::timestamptz;

SELECT idempotency_key, count(*) AS rows
FROM bot_responses
WHERE group_id = :'group_id'
GROUP BY idempotency_key
HAVING count(*) > 1;
```

Expected: blocked/uncertain content is not sent; `unknown_transport` is
reviewed manually; the final query returns zero rows. The unique database
constraint is a safety net, not a substitute for checking transport logs.

## Go/no-go checklist for the two-week trial

Record the window, group and operator in the release ticket, then check:

- [ ] build, typecheck, lint and deterministic E2E tests pass;
- [ ] Compose migration completed and `/health/live` + `/health/ready` are 2xx;
- [ ] LINE signature rejects are observed without persistence;
- [ ] duplicate response query returns zero rows;
- [ ] transport timeout-after-claim rows are `unknown` and are not retried;
- [ ] privacy commands (view/correct/forget/opt-out/opt-in) and admin denial
      were exercised in staging;
- [ ] secrets/reply tokens/raw authorization headers are absent from logs;
- [ ] ambient response rate is 5–10% (or sample-size exception documented);
- [ ] follow-up within five minutes is at least 30% (or exception documented);
- [ ] negative feedback is at most 10% (or insufficient sample documented);
- [ ] token usage is within the configured daily budget and safety rejections
      are explainable;
- [ ] operator confirms MVP limitations: no backup, no media analysis, no
      scheduled icebreaker and no phase-2 dashboard.

Go only when every unchecked item has an explicit owner, mitigation and trial
stop condition. No-go on any duplicate send, secret leak, failed migration,
unhealthy readiness, unexplained safety bypass or persistent job backlog.
