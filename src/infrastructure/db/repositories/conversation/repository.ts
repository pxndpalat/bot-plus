import type { Kysely } from "kysely";
import type { ConversationEpisode, ConversationMessage, ConversationMessageQuery, ConversationRepository } from "../../../../modules/conversation-service/index.ts";
import type { Database } from "../../types.ts";

interface ConversationEpisodeRow {
  readonly id: string;
  readonly group_id: string;
  readonly started_at: Date;
  readonly last_message_at: Date;
  readonly ended_at: Date | null;
}

interface ConversationMessageRow {
  readonly id: string;
  readonly group_id: string;
  readonly sender_member_id: string | null;
  readonly line_message_id: string | null;
  readonly message_type: ConversationMessage["type"];
  readonly text_content: string | null;
  readonly line_quoted_message_id: string | null;
  readonly sent_at: Date;
  readonly received_at: Date;
}

function episodeFromRow(row: ConversationEpisodeRow): ConversationEpisode {
  return {
    id: row.id,
    groupId: row.group_id,
    startedAt: new Date(row.started_at),
    lastMessageAt: new Date(row.last_message_at),
    endedAt: row.ended_at ? new Date(row.ended_at) : null,
  };
}

function messageFromRow(row: ConversationMessageRow): ConversationMessage {
  return {
    id: row.id,
    groupId: row.group_id,
    senderMemberId: row.sender_member_id,
    authorKind: "human",
    lineMessageId: row.line_message_id,
    type: row.message_type,
    text: row.text_content,
    quotedMessageId: row.line_quoted_message_id,
    eventAt: new Date(row.sent_at),
    receivedAt: new Date(row.received_at),
    lifecycle: "active",
  };
}

async function tombstoneKeys(db: Kysely<Database>, groupId: string): Promise<Set<string>> {
  const rows = await db.selectFrom("message_tombstones").select(["message_id", "line_message_id"]).where("group_id", "=", groupId).execute();
  const keys = new Set<string>();
  for (const row of rows) {
    if (row.message_id) keys.add(`id:${row.message_id}`);
    keys.add(`line:${row.line_message_id}`);
  }
  return keys;
}

function isTombstoned(message: ConversationMessage, keys: Set<string>): boolean {
  return keys.has(`id:${message.id}`) || (message.lineMessageId ? keys.has(`line:${message.lineMessageId}`) : false);
}

export function createConversationRepository(db: Kysely<Database>): ConversationRepository {
  return {
    async getLatestEpisode(groupId) {
      const row = await db.selectFrom("conversation_episodes").selectAll().where("group_id", "=", groupId).orderBy("last_message_at", "desc").orderBy("id", "desc").limit(1).executeTakeFirst();
      return row ? episodeFromRow(row) : null;
    },
    async findEpisodeContaining(groupId, eventAt) {
      const lowerBound = new Date(eventAt.getTime() - 10 * 60 * 1000);
      const row = await db.selectFrom("conversation_episodes").selectAll().where("group_id", "=", groupId).where("started_at", "<=", eventAt).where("last_message_at", ">=", lowerBound).orderBy("last_message_at", "desc").orderBy("id", "desc").limit(1).executeTakeFirst();
      return row ? episodeFromRow(row) : null;
    },
    async createEpisode(episode) {
      const now = new Date();
      await db.insertInto("conversation_episodes").values({
        id: episode.id,
        group_id: episode.groupId,
        started_at: episode.startedAt,
        last_message_at: episode.lastMessageAt,
        ended_at: episode.endedAt ?? null,
        created_at: now,
        updated_at: now,
      }).execute();
    },
    async updateEpisode(episode) {
      await db.updateTable("conversation_episodes").set({
        started_at: episode.startedAt,
        last_message_at: episode.lastMessageAt,
        ended_at: episode.endedAt ?? null,
        updated_at: new Date(),
      }).where("id", "=", episode.id).execute();
    },
    async listMessages(query: ConversationMessageQuery) {
      const rows = await db.selectFrom("messages").selectAll().where("group_id", "=", query.groupId).$if(query.from !== undefined, (builder) => builder.where("sent_at", ">=", query.from as Date)).$if(query.to !== undefined, (builder) => builder.where("sent_at", "<=", query.to as Date)).orderBy("sent_at", "asc").orderBy("id", "asc").execute();
      const keys = await tombstoneKeys(db, query.groupId);
      return rows.map(messageFromRow).filter((message) => !isTombstoned(message, keys)).slice(-(query.limit ?? 1000));
    },
    async findMessage(groupId, messageId) {
      const row = await db.selectFrom("messages").selectAll().where("group_id", "=", groupId).where((eb) => eb.or([eb("id", "=", messageId), eb("line_message_id", "=", messageId)])).executeTakeFirst();
      if (!row) return null;
      const message = messageFromRow(row);
      const keys = await tombstoneKeys(db, groupId);
      return isTombstoned(message, keys) ? null : message;
    },
  };
}

export const createKyselyConversationRepository = createConversationRepository;
