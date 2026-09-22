import type { MemberId } from "../../../shared/index.ts";

export interface CommandMention {
  readonly isSelf: boolean;
  readonly index?: number;
  readonly length?: number;
}

export interface CommandParserInput {
  readonly text: string;
  readonly actorUserId: string | MemberId;
  /** Structured mention information from the LINE adapter. */
  readonly mentions?: readonly CommandMention[];
  /** Convenience boundary flag for callers that already normalized mentions. */
  readonly botMentioned?: boolean;
  readonly isBotMentioned?: boolean;
  /** Deliberately ignored; display names are never identity or authorization. */
  readonly displayName?: string;
}

export type CommandName =
  | "who_am_i"
  | "correct_persona"
  | "forget_me"
  | "memory_opt_out"
  | "memory_opt_in"
  | "set_alias"
  | "mute"
  | "set_mode"
  | "status";

export type CommandScope = "member" | "admin";
export type CommandParseFailure = "not_command" | "missing_mention" | "malformed";

interface ParsedCommandBase {
  readonly kind: "command";
  readonly command: CommandName;
  /** Alias for consumers that call the parsed command an intent. */
  readonly intent: CommandName;
  readonly actorUserId: MemberId;
  readonly actor: { readonly userId: MemberId };
  readonly scope: CommandScope;
  readonly authorization: CommandScope;
  readonly requiresMention: boolean;
  readonly mentionPresent: boolean;
  readonly rawText: string;
  readonly normalizedText: string;
}

export interface WhoAmICommand extends ParsedCommandBase {
  readonly command: "who_am_i";
  readonly intent: "who_am_i";
}

export interface CorrectPersonaCommand extends ParsedCommandBase {
  readonly command: "correct_persona";
  readonly intent: "correct_persona";
  readonly payload: string;
  readonly correction: string;
}

export interface ForgetMeCommand extends ParsedCommandBase {
  readonly command: "forget_me";
  readonly intent: "forget_me";
}

export interface MemoryOptOutCommand extends ParsedCommandBase {
  readonly command: "memory_opt_out";
  readonly intent: "memory_opt_out";
}

export interface MemoryOptInCommand extends ParsedCommandBase {
  readonly command: "memory_opt_in";
  readonly intent: "memory_opt_in";
}

export interface SetAliasCommand extends ParsedCommandBase {
  readonly command: "set_alias";
  readonly intent: "set_alias";
  readonly payload: string;
  readonly alias: string;
}

export interface MuteCommand extends ParsedCommandBase {
  readonly command: "mute";
  readonly intent: "mute";
  readonly durationMinutes: number;
  readonly durationMs: number;
}

export type ToneMode = "สุภาพ" | "ปกติ" | "แซวแรง";

export interface SetModeCommand extends ParsedCommandBase {
  readonly command: "set_mode";
  readonly intent: "set_mode";
  readonly mode: ToneMode;
}

export interface StatusCommand extends ParsedCommandBase {
  readonly command: "status";
  readonly intent: "status";
}

export type ParsedCommand =
  | WhoAmICommand
  | CorrectPersonaCommand
  | ForgetMeCommand
  | MemoryOptOutCommand
  | MemoryOptInCommand
  | SetAliasCommand
  | MuteCommand
  | SetModeCommand
  | StatusCommand;

export interface NotCommandResult {
  readonly kind: "not_command";
  readonly reason: CommandParseFailure;
  readonly actorUserId?: MemberId;
  readonly rawText: string;
  readonly normalizedText: string;
}

export type CommandParseResult = ParsedCommand | NotCommandResult;

