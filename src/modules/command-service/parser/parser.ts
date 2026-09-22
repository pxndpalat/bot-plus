import { parseMemberId } from "../../../shared/index.ts";
import type {
  CommandMention,
  CommandName,
  CommandParseResult,
  CommandParserInput,
  CommandScope,
  NotCommandResult,
  ParsedCommand,
  ToneMode,
} from "./types.ts";

const MUTATING_COMMANDS = new Set<CommandName>([
  "correct_persona",
  "forget_me",
  "memory_opt_out",
  "memory_opt_in",
  "set_alias",
  "mute",
  "set_mode",
]);

/**
 * Only used for matching. The raw text and all command payloads remain intact
 * apart from trimming the payload boundary.
 */
function normalizeForMatching(value: string): string {
  return value
    .replace(/\u200B|\u200C|\u200D|\uFEFF/gu, "")
    .replace(/：/gu, ":")
    .replace(/．/gu, ".")
    .replace(/\s+/gu, " ")
    .trim();
}

function mentionPresent(input: CommandParserInput): boolean {
  return input.botMentioned === true || input.isBotMentioned === true || input.mentions?.some((mention) => mention.isSelf) === true;
}

function removeSelfMentionForMatching(text: string, mentions: readonly CommandMention[] | undefined): string {
  if (!mentions?.some((mention) => mention.isSelf)) return text;
  const ranges = mentions
    .filter((mention) => mention.isSelf && Number.isInteger(mention.index) && Number.isInteger(mention.length))
    .map((mention) => ({ start: mention.index as number, end: (mention.index as number) + (mention.length as number) }))
    .filter((range) => range.start >= 0 && range.end >= range.start && range.end <= text.length)
    .sort((a, b) => b.start - a.start);
  let result = text;
  for (const range of ranges) result = `${result.slice(0, range.start)} ${result.slice(range.end)}`;
  return result;
}

function removeExplicitBotMarker(text: string, input: CommandParserInput): string {
  const explicitMention = input.botMentioned === true || input.isBotMentioned === true || input.mentions?.some((mention) => mention.isSelf) === true;
  if (!explicitMention) return text;
  return text.replace(/^@bot(?:\s|$)/iu, "");
}

function actorId(value: string | { readonly __brand?: string }): ReturnType<typeof parseMemberId> | undefined {
  try {
    return parseMemberId(String(value));
  } catch {
    return undefined;
  }
}

function notCommand(input: CommandParserInput, normalizedText: string, reason: NotCommandResult["reason"], id?: ReturnType<typeof parseMemberId>): NotCommandResult {
  return {
    kind: "not_command",
    reason,
    ...(id ? { actorUserId: id } : {}),
    rawText: typeof input.text === "string" ? input.text : "",
    normalizedText,
  };
}

function payloadAfterPrefix(normalizedText: string, prefix: string): string | undefined {
  if (!normalizedText.startsWith(prefix)) return undefined;
  const payload = normalizedText.slice(prefix.length).trim();
  return payload.length > 0 ? payload : undefined;
}

interface Match {
  readonly command: CommandName;
  readonly scope: CommandScope;
  readonly payload?: string;
  readonly durationMinutes?: number;
  readonly mode?: ToneMode;
}

function matchCommand(normalizedText: string): Match | undefined {
  if (normalizedText === "ฉันเป็นใคร") return { command: "who_am_i", scope: "member" };
  if (normalizedText === "ลืมฉัน") return { command: "forget_me", scope: "member" };
  if (normalizedText === "หยุดวิเคราะห์ฉัน") return { command: "memory_opt_out", scope: "member" };
  if (normalizedText === "จำฉันได้แล้ว") return { command: "memory_opt_in", scope: "member" };
  if (normalizedText === "สถานะ") return { command: "status", scope: "admin" };

  const correction = normalizedText.match(/^แก้ข้อมูลฉัน\s*(?::)\s*(.*)$/u);
  if (correction) {
    const payload = correction[1]?.trim();
    return payload ? { command: "correct_persona", scope: "member", payload } : undefined;
  }

  const alias = payloadAfterPrefix(normalizedText, "เรียกฉันว่า");
  if (alias) return { command: "set_alias", scope: "member", payload: alias };

  const mute = normalizedText.match(/^เงียบ\s+(\d+)\s*(นาที|น\.|ชม\.?|ชั่วโมง)$/u);
  if (mute) {
    const amount = Number(mute[1]);
    if (!Number.isSafeInteger(amount) || amount <= 0) return undefined;
    const unit = mute[2];
    const durationMinutes = unit === "ชม." || unit === "ชม" || unit === "ชั่วโมง" ? amount * 60 : amount;
    if (!Number.isSafeInteger(durationMinutes)) return undefined;
    return { command: "mute", scope: "admin", durationMinutes };
  }

  const mode = normalizedText.match(/^โหมด\s+(สุภาพ|ปกติ|แซวแรง)$/u);
  if (mode) return { command: "set_mode", scope: "admin", mode: mode[1] as ToneMode };
  return undefined;
}

function rawPayload(rawText: string, command: CommandName): string | undefined {
  const value = rawText.trim();
  if (command === "correct_persona") {
    const match = value.match(/^แก้ข้อมูลฉัน\s*[:：]\s*(.*)$/u);
    return match?.[1]?.trim() || undefined;
  }
  if (command === "set_alias") {
    const match = value.match(/^เรียกฉันว่า\s+(.*)$/u);
    return match?.[1]?.trim() || undefined;
  }
  return undefined;
}

function buildCommand(input: CommandParserInput, normalizedText: string, match: Match, id: ReturnType<typeof parseMemberId>, hasMention: boolean): ParsedCommand {
  const base = {
    kind: "command" as const,
    command: match.command,
    intent: match.command,
    actorUserId: id,
    actor: { userId: id },
    scope: match.scope,
    authorization: match.scope,
    requiresMention: MUTATING_COMMANDS.has(match.command),
    mentionPresent: hasMention,
    rawText: input.text,
    normalizedText,
  };
  switch (match.command) {
    case "correct_persona":
      return { ...base, command: match.command, intent: match.command, payload: match.payload as string, correction: match.payload as string };
    case "set_alias":
      return { ...base, command: match.command, intent: match.command, payload: match.payload as string, alias: match.payload as string };
    case "mute":
      return { ...base, command: match.command, intent: match.command, durationMinutes: match.durationMinutes as number, durationMs: (match.durationMinutes as number) * 60_000 };
    case "set_mode":
      return { ...base, command: match.command, intent: match.command, mode: match.mode as ToneMode };
    default:
      return { ...base, command: match.command, intent: match.command } as ParsedCommand;
  }
}

/** Deterministic parser; it never invokes a model and never performs authorization. */
export function parseCommand(input: CommandParserInput): CommandParseResult {
  if (!input || typeof input.text !== "string") {
    return { kind: "not_command", reason: "not_command", rawText: "", normalizedText: "" };
  }
  const id = actorId(input.actorUserId);
  const matchingText = removeExplicitBotMarker(removeSelfMentionForMatching(input.text, input.mentions), input);
  const normalizedText = normalizeForMatching(matchingText);
  const match = matchCommand(normalizedText);
  if (!match) return notCommand(input, normalizedText, normalizedText.length === 0 ? "not_command" : "malformed", id);
  const hasMention = mentionPresent(input);
  if (!id) return notCommand(input, normalizedText, "not_command");
  if (MUTATING_COMMANDS.has(match.command) && !hasMention) return notCommand(input, normalizedText, "missing_mention", id);
  const preservedPayload = rawPayload(matchingText, match.command);
  return buildCommand(
    input,
    normalizedText,
    preservedPayload === undefined ? match : { ...match, payload: preservedPayload },
    id,
    hasMention,
  );
}

export const parse = parseCommand;
export const parseCommandIntent = parseCommand;
