import { parseMemberId } from "../../shared/index.ts";
import type {
  LineProfile,
  LineProfilePort,
  LineReplyPort,
  LineReplyMessage,
  LineReplyPort as ReplyPort,
  LineTransportClient,
  LineTransportOutcome,
  ReplyRequest,
  ResponseClaimProof,
} from "./types.ts";
import { normalizeProfile } from "./parser.ts";

const claimProofBrand = Symbol("line-adapter.response-claim-proof");
type BrandedProof = ResponseClaimProof & { readonly [claimProofBrand]: true };

export class MissingResponseClaimError extends Error {
  constructor() {
    super("A response claim proof is required before sending a LINE reply");
    this.name = "MissingResponseClaimError";
  }
}

export function createResponseClaimProof(idempotencyKey: string, responseId?: string): ResponseClaimProof {
  if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0) {
    throw new TypeError("Response idempotency key must be non-empty");
  }
  return Object.freeze({
    ...(responseId ? { responseId } : {}),
    idempotencyKey,
    [claimProofBrand]: true,
  }) as BrandedProof;
}

function hasClaimProof(value: ResponseClaimProof | undefined): value is BrandedProof {
  return Boolean(value && (value as BrandedProof)[claimProofBrand] === true);
}

export class LineTransportError extends Error {
  readonly outcome: LineTransportOutcome;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(outcome: LineTransportOutcome, status?: number) {
    super(`LINE transport failure (${outcome}${status === undefined ? "" : `, status ${status}`})`);
    this.name = "LineTransportError";
    this.outcome = outcome;
    this.status = status;
    this.retryable = outcome === "transient";
  }
}

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  const status = candidate.status ?? candidate.statusCode ?? candidate.response?.status;
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

function isTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown };
  const text = `${String(candidate.name ?? "")} ${String(candidate.code ?? "")} ${String(candidate.message ?? "")}`.toLowerCase();
  return text.includes("timeout") || text.includes("timed out") || text.includes("etimedout");
}

export function mapTransportError(error: unknown): LineTransportError {
  if (error instanceof LineTransportError) return error;
  const status = statusOf(error);
  if (status !== undefined) {
    if (status === 408 || status === 425 || status === 429 || status >= 500) {
      return new LineTransportError("transient", status);
    }
    if (status >= 400 && status < 500) return new LineTransportError("permanent", status);
  }
  if (isTimeout(error)) return new LineTransportError("unknown");
  return new LineTransportError("unknown");
}

export const mapLineTransportError = mapTransportError;

function replyCall(client: LineTransportClient, token: string, messages: readonly LineReplyMessage[]): Promise<unknown> {
  const call = client.replyMessage ?? client.reply;
  if (!call) throw new LineTransportError("permanent");
  return call(token, messages);
}

function profileCall(client: LineTransportClient, userId: string): Promise<unknown> {
  const call = client.getProfile ?? client.profile;
  if (!call) throw new LineTransportError("permanent");
  return call(userId);
}

export function createReplyPort(client: LineTransportClient): LineReplyPort {
  return {
    async reply(request: ReplyRequest): Promise<void> {
      if (!hasClaimProof(request.claimProof)) throw new MissingResponseClaimError();
      if (typeof request.replyToken !== "string" || request.replyToken.length === 0) {
        throw new TypeError("Reply token must be non-empty");
      }
      try {
        await replyCall(client, request.replyToken, request.messages);
      } catch (error) {
        throw mapTransportError(error);
      }
    },
  } satisfies ReplyPort;
}

export function createProfilePort(client: LineTransportClient): LineProfilePort {
  return {
    async lookup(userId): Promise<LineProfile> {
      try {
        return normalizeProfile(await profileCall(client, userId), userId);
      } catch (error) {
        throw mapTransportError(error);
      }
    },
  };
}

export const createLineReplyPort = createReplyPort;
export const createLineProfilePort = createProfilePort;
export const createResponseClaim = createResponseClaimProof;

/** Useful when the consumer already has a raw LINE user id rather than a branded id. */
export async function lookupProfile(port: LineProfilePort, userId: string): Promise<LineProfile> {
  return port.lookup(parseMemberId(userId));
}
