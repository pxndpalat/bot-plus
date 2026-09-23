# Mallnew Friends Bot production runbook

This runbook deploys the MVP as one `bot-app` container and one PostgreSQL
container on a private Docker network. It assumes a clean host with Docker
Engine 24+ and Docker Compose v2. The reverse proxy/TLS terminator runs on the
host (or an existing edge proxy); it is not part of this Compose stack.

## Deployment invariants

- PostgreSQL has no published host port. Only `bot-app` is bound, by default,
  to `127.0.0.1:3000` so an edge proxy can reach it locally.
- `migrate` is a release step. Compose starts `bot-app` only after that service
  exits successfully, and a failed migration prevents app startup.
- Keep `.env` and any secret files outside source control. Never put a LINE
  secret, LINE access token, OpenAI key, database password, or authorization
  header in an image, compose file, log, or ticket.
- The MVP has no automated backup. PostgreSQL data loss means the bot starts
  learning again from new events; do not claim historical recovery.

## Configure a clean host

1. Install Docker Engine and the Compose v2 plugin. Copy the release files to
   the host and verify `docker compose version`.
2. Create the runtime environment file:

   ```sh
   cp .env.example .env
   chmod 600 .env
   ```

3. Set at least these values in `.env`:

   ```dotenv
   POSTGRES_DB=mallnew_friends_bot
   POSTGRES_USER=mallnew
   POSTGRES_PASSWORD=<long-random-password>
   LINE_CHANNEL_SECRET=<LINE-channel-secret>
   LINE_CHANNEL_ACCESS_TOKEN=<LINE-channel-access-token>
   OPENAI_API_KEY=<OpenAI-api-key>
   OPENAI_MODEL=gpt-5-nano
   ADMIN_LINE_USER_IDS=<comma-separated-Line-user-ids>
   ```

   Keep `DATABASE_URL` in `.env` as a local-development value if it is present
   in `.env.example`; Compose overrides it inside the containers to use the
   private `postgres` service and the configured database credentials.
4. Validate the rendered configuration without starting anything:

   ```sh
   docker compose config
   ```

   Review that no secret value is checked into the repository or printed into
   a saved artifact. The rendered config should have no `postgres` `ports:`.

## LINE webhook and TLS

Terminate HTTPS at the existing reverse proxy. Point the LINE Developers
Messaging API webhook URL to:

```text
https://<public-host>/webhooks/line
```

The proxy must forward `POST` requests, the original request body bytes, and
the `x-line-signature` header to `http://127.0.0.1:3000`. Do not parse or
rewrite the body before the app verifies the signature. Obtain a trusted TLS
certificate, redirect HTTP to HTTPS, and restrict the proxy to the webhook and
health routes required by operations. Do not expose port 5432 publicly.

## Deploy or update

Build the pinned Bun image and start PostgreSQL plus the migration release
step. The app is started only when the migration succeeds:

```sh
docker compose build --pull bot-app migrate
docker compose up -d postgres
docker compose run --rm migrate
docker compose up -d bot-app
```

For an all-in-one Compose reconciliation after the image has been built:

```sh
docker compose up -d --build
```

If `migrate` fails, stop there, inspect the migration logs, fix the cause, and
rerun the same migration step. Do not bypass the migration gate by starting
`bot-app` manually against an unknown schema.

Check process and dependency health:

```sh
docker compose ps
curl -fsS http://127.0.0.1:3000/health/live
curl -fsS http://127.0.0.1:3000/health/ready
```

`/health/live` means the process is running. `/health/ready` must also verify
PostgreSQL connectivity and the expected migration version; it must not reveal
configuration or secrets.

## Logs and routine operations

```sh
docker compose logs --since=10m bot-app
docker compose logs --since=10m migrate
docker compose logs --since=10m postgres
docker compose top
docker compose restart bot-app
```

The app handles SIGTERM and has a 45-second stop grace period so it can stop
accepting requests, drain its worker, and close database/client resources.

## Migration failure or rollback

Capture the failing migration log and database health first:

```sh
docker compose logs migrate
docker compose exec postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

Do not delete the PostgreSQL volume to fix a migration error. Correct the
configuration or migration issue, then rerun `docker compose run --rm migrate`.
For a release rollback, deploy the previous known-good image and run only the
backward migration operation explicitly approved for that release. Never run a
destructive down migration in production without a tested recovery plan.

## Database loss and re-learning

The MVP intentionally has no automated backup. If the volume is lost, recreate
the stack and apply migrations:

```sh
docker compose up -d postgres
docker compose run --rm migrate
docker compose up -d bot-app
```

Verify the LINE webhook and health endpoints. Existing persona facts,
conversation history, jobs, and telemetry are unrecoverable without an
external backup; members learn again only from new webhook events. Treat this
as an incident and record the data-loss window.

## Stop and emergency actions

Graceful stop:

```sh
docker compose stop
```

Emergency app isolation while preserving the database volume:

```sh
docker compose stop bot-app migrate
```

Do not publish PostgreSQL's port, commit `.env`, or run `docker compose down
-v` during routine operations. `down -v` removes the persistent database
volume and is a data-loss action.
