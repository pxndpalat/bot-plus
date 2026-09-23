# MFB-022 E2E test plan

สถานะ: Wave 8 gate (deterministic suite checked in; Compose run required for the final gate)

## Scope and contracts

The suite exercises the public application/module entry points only. It uses
in-memory ports for LINE, AI, settings, persona, response claims and job
hydration, so it is deterministic and can run without Docker or credentials.
The Compose run is the acceptance gate for the production composition,
PostgreSQL repositories and the real worker lifecycle.

Scenarios covered by `test/e2e/mfb-022.e2e.test.ts`:

| Area | Assertions |
|---|---|
| Webhook boundary | raw-byte signature verification, invalid signature before persistence, valid fast 2xx, duplicate/redelivery 2xx, malformed payload, ingest/DB failure 503, live/ready, unsend parsing |
| Direct path | mention, reply-to-bot, command, response claim before send, duplicate response suppression and stale reply-token expiry |
| Ambient path | 15–30 second scheduling, response, hard-ignore for sticker/low signal, human cancellation, stale context/token, restart hydration, model failure and duplicate claim |
| Failure injection | model timeout, LINE timeout after irreversible claim, response claim collision and out-of-order/stale conversation analysis |
| Privacy/safety/persona | secret/prompt-injection blocking, direct neutral fallback, opt-out/in, observation/fact resolution, alias collision, member/admin authorization |
| Lifecycle | unsend tombstone, message deletion, delayed-job cancellation, observation invalidation and fact archival; idempotent repeated unsend |
| Load smoke | Compose-only command below sends a 1,000-message equivalent burst and checks 2xx/latency/backlog/duplicate invariants |

## Commands

Run the deterministic suite first:

```sh
bun test test/e2e
bun run typecheck
bun run lint
```

Expected result: all E2E tests pass; `tsc --noEmit` and ESLint exit 0. No
network, PostgreSQL, LINE token or OpenAI key is required for this phase.

Run the final production-composition gate on a host with Docker Engine/Compose:

```sh
docker compose config
docker compose build --pull bot-app migrate
docker compose up -d postgres
docker compose run --rm migrate
docker compose up -d bot-app
E2E_BASE_URL=http://127.0.0.1:3000 E2E_CHANNEL_SECRET='<staging-channel-secret>' bun test test/e2e
curl -fsS http://127.0.0.1:3000/health/live
curl -fsS http://127.0.0.1:3000/health/ready
```

Expected result: config/build/migration succeed, both health calls return 2xx,
the app has no public PostgreSQL port, and the optional Compose smoke test
passes (7 deterministic tests pass plus one Compose test). If Docker is
unavailable, report the commands above as Docker-only blocked; do not mark the
Compose acceptance criterion as passed.

## Load smoke and observability checks

Use a staging `.env` and never paste real secrets into shell history. Generate
valid signed payloads with a short-lived script or a load tool that preserves
the exact request bytes. Send 1,000 messages over a short burst, then check:

- webhook acknowledgement p95 is within the operational target (direct path
  target is 3–5 seconds for the full worker flow; webhook acknowledgement must
  remain fast and asynchronous);
- `delayed_jobs` has no permanently stuck `claimed` rows and backlog drains;
- `bot_responses` has one row per idempotency key and zero duplicate sends;
- duplicate/redelivery of the same webhook does not create another response.

The test is deterministic about at-most-once claims. Provider rate limits and
real LINE delivery are intentionally excluded from the local suite and must be
validated in staging with a test channel.

## Exit criteria

The MVP is not ready for the two-week trial until every required check is
green:

1. deterministic E2E suite, build, typecheck and lint pass;
2. Compose config/build/migration/start and live/ready pass;
3. valid/invalid/duplicate/failure webhook contracts match the table above;
4. response duplicate count is zero and transport timeout-after-claim is
   recorded as unknown without automatic retry;
5. safety/privacy/admin/lifecycle cases pass and no secret appears in logs;
6. evaluation SQL in `docs/evaluation-runbook.md` returns complete data for the
   trial group; and
7. an operator signs the go/no-go checklist after a staging smoke.
