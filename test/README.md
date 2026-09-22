# Test harness

The shared helpers live in `test/support/index.ts` and are intentionally
independent of production module internals. Import them through that barrel so
future modules can use the same fakes and fixture contracts without deep
imports.

Run the suites separately when developing:

```text
bun test test/unit
bun test test/integration
```

Integration PostgreSQL tests are opt-in. Set `TEST_DATABASE_URL` to a local
PostgreSQL URL whose database name contains `test` (for example
`postgres://user:pass@localhost/mallnew_test`). The harness creates a unique
schema per instance, runs the supplied migration callback, and can truncate
all tables in that schema between tests. It never falls back to `DATABASE_URL`
and rejects non-local or non-test database names.

`createFakeClock`, `createFakeRandom`, and `createFakeIdGenerator` provide
deterministic primitives. `createFakeLineClient` and `createFakeOpenAI` record
transport calls and support one-shot failures. `assertNoSecrets` and
`assertAtMostOnce` cover the two cross-cutting quality invariants.
