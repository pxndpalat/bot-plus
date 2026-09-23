import { strict as assert } from "node:assert";
import { test } from "bun:test";
import {
  DURATION,
  ValidationError,
  bangkokBudgetDay,
  fixedClock,
  fixedIdGenerator,
  fixedRandom,
  isOk,
  ok,
  parseDuration,
  parseEnvironment,
  serializeId,
  startOfBangkokBudgetDay,
  toFactId,
  toGroupId,
  toMemberId,
  toUtcIso,
  unwrapResult
} from "./index.ts";

const validEnvironment = {
  LINE_CHANNEL_SECRET: "secret",
  LINE_CHANNEL_ACCESS_TOKEN: "token",
  OPENAI_API_KEY: "api-key",
  DATABASE_URL: "postgres://localhost/mallnew",
  ADMIN_LINE_USER_IDS: "Uadmin1,Uadmin2"
} as const;

test("branded domain ids remain strings at the serialization boundary", () => {
    const group = toGroupId("C-group");
    const fact = toFactId("fact_1");
    assert.equal(typeof group, "string");
    assert.equal(serializeId(group), "C-group");
    assert.equal(JSON.stringify({ group, fact }), '{"group":"C-group","fact":"fact_1"}');
});

test("branded domain ids reject empty and padded identifiers", () => {
    assert.throws(() => toMemberId(" "));
    assert.throws(() => toMemberId(" U-user"));
});

test("deterministic primitives clock returns defensive date copies", () => {
    const clock = fixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const value = clock.now();
    value.setUTCFullYear(2030);
    assert.equal(toUtcIso(clock.now()), "2026-01-01T00:00:00.000Z");
});

test("deterministic primitives random and ids can be injected", () => {
    assert.equal(fixedRandom([0.2, 0.8]).next(), 0.2);
    const ids = fixedIdGenerator([toMemberId("U-1"), toMemberId("U-2")]);
    assert.equal(ids.next(), "U-1");
    assert.equal(ids.next(), "U-2");
});

test("deterministic primitives result helpers preserve success and unwrap value", () => {
    const result = ok(42);
    assert.equal(isOk(result), true);
    assert.equal(unwrapResult(result), 42);
});

test("time contracts parse supported durations and reject malformed values", () => {
    assert.equal(parseDuration("15s"), 15_000);
    assert.equal(parseDuration("1.5m"), 90_000);
    assert.equal(parseDuration("2h"), 2 * DURATION.hour);
    assert.throws(() => parseDuration("0s"));
    assert.throws(() => parseDuration("tomorrow"));
});

test("time contracts use Bangkok calendar boundaries regardless of UTC date", () => {
    assert.equal(bangkokBudgetDay("2026-01-01T16:59:59.999Z"), "2026-01-01");
    assert.equal(bangkokBudgetDay("2026-01-01T17:00:00.000Z"), "2026-01-02");
    assert.equal(startOfBangkokBudgetDay("2026-01-01T17:00:00.000Z").toISOString(), "2026-01-01T17:00:00.000Z");
    // Bangkok has no DST; a summer/winter host timezone must not affect this.
    assert.equal(bangkokBudgetDay("2026-07-01T16:59:59.000Z"), "2026-07-01");
    assert.equal(bangkokBudgetDay("2026-12-01T16:59:59.000Z"), "2026-12-01");
});

test("environment configuration applies documented defaults", () => {
    const config = parseEnvironment(validEnvironment);
    assert.equal(config.openAiModel, "gpt-5-nano");
    assert.equal(config.rawMessageRetentionDays, 30);
    assert.equal(config.contentLogRetentionDays, 7);
    assert.equal(config.personaDecayDays, 180);
    assert.equal(config.ambientDelayMin, 15_000);
    assert.equal(config.ambientDelayMax, 30_000);
    assert.equal(config.contextWindow, 10 * DURATION.minute);
});

test("environment configuration parses configurable values and durations", () => {
    const config = parseEnvironment({
      ...validEnvironment,
      OPENAI_MODEL: "gpt-custom",
      AMBIENT_DELAY_MIN_SECONDS: "20",
      AMBIENT_DELAY_MAX_SECONDS: "40",
      CONTEXT_WINDOW_MINUTES: "12",
      CONTEXT_LIMIT: "25",
      DAILY_AI_TOKEN_BUDGET: "12345"
    });
    assert.equal(config.openAiModel, "gpt-custom");
    assert.equal(config.ambientDelayMin, 20_000);
    assert.equal(config.ambientDelayMax, 40_000);
    assert.equal(config.contextWindow, 12 * DURATION.minute);
    assert.equal(config.contextLimit, 25);
    assert.equal(config.dailyAiTokenBudget, 12_345);
});

test("environment configuration fails fast for missing or malformed values", () => {
    assert.throws(() => parseEnvironment({ ...validEnvironment, DATABASE_URL: "" }), ValidationError);
    assert.throws(() => parseEnvironment({ ...validEnvironment, CONTEXT_LIMIT: "nope" }), ValidationError);
    assert.throws(() => parseEnvironment({ ...validEnvironment, DAILY_AI_TOKEN_BUDGET: "0" }), ValidationError);
    assert.throws(
      () => parseEnvironment({ ...validEnvironment, AMBIENT_DELAY_MIN_SECONDS: "40", AMBIENT_DELAY_MAX_SECONDS: "20" }),
      ValidationError
    );
});
