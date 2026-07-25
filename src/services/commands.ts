import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { commandEvents, commands, type Command } from "@/db/schema";
import { ApiError } from "@/lib/api";
import {
  commandCreateSchema,
  type CommandType,
  validateCommandPayload,
} from "@/lib/validation";

type CommandActor = {
  source: "dashboard" | "hermes" | "worker" | "n8n" | "system";
  requestedBy: string;
};

export async function createCommand(input: unknown, actor: CommandActor) {
  const parsed = commandCreateSchema.parse(input);
  const payload = validateCommandPayload(parsed.type, parsed.payloadJson);
  const db = getDb();

  const [command] = await db
    .insert(commands)
    .values({
      type: parsed.type,
      source: actor.source,
      requestedBy: actor.requestedBy,
      payloadJson: payload,
      priority: parsed.priority,
      scheduledFor: parsed.scheduledFor ?? new Date(),
    })
    .returning();

  await db.insert(commandEvents).values({
    commandId: command.id,
    eventType: "created",
    message: `Command created by ${actor.source}.`,
    metadataJson: { requestedBy: actor.requestedBy },
  });

  return command;
}

export async function listCommands(filters?: {
  status?: Command["status"];
  type?: CommandType;
  limit?: number;
}) {
  const conditions = [];
  if (filters?.status) conditions.push(eq(commands.status, filters.status));
  if (filters?.type) conditions.push(eq(commands.type, filters.type));

  return getDb()
    .select()
    .from(commands)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(commands.createdAt))
    .limit(filters?.limit ?? 50);
}

export async function getCommandDetail(id: string) {
  const db = getDb();
  const [command] = await db
    .select()
    .from(commands)
    .where(eq(commands.id, id))
    .limit(1);
  if (!command) return null;

  const events = await db
    .select()
    .from(commandEvents)
    .where(eq(commandEvents.commandId, id))
    .orderBy(desc(commandEvents.createdAt));
  return { ...command, events };
}

export async function claimCommand(
  workerId: string,
  commandTypes?: CommandType[],
) {
  const db = getDb();
  const typeFilter =
    commandTypes?.length
      ? sql`AND "type" IN (${sql.join(
          commandTypes.map((type) => sql`${type}`),
          sql`, `,
        )})`
      : sql``;

  const result = await db.execute(sql`
    WITH next_command AS (
      SELECT "id"
      FROM "commands"
      WHERE "status" = 'pending'
        AND "scheduled_for" <= NOW()
        ${typeFilter}
      ORDER BY
        CASE "priority"
          WHEN 'urgent' THEN 4
          WHEN 'high' THEN 3
          WHEN 'normal' THEN 2
          ELSE 1
        END DESC,
        "scheduled_for" ASC,
        "created_at" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE "commands" AS command
    SET
      "status" = 'claimed',
      "claimed_by" = ${workerId},
      "claimed_at" = NOW(),
      "updated_at" = NOW()
    FROM next_command
    WHERE command."id" = next_command."id"
    RETURNING command.*
  `);

  const command = (result.rows[0] as Command | undefined) ?? null;
  if (command) {
    await db.insert(commandEvents).values({
      commandId: command.id,
      eventType: "claimed",
      message: `Command claimed by worker ${workerId}.`,
      metadataJson: { workerId },
    });
  }
  return command;
}

export async function completeCommand(
  commandId: string,
  workerId: string,
  resultJson: Record<string, unknown>,
) {
  const db = getDb();
  const [command] = await db
    .update(commands)
    .set({
      status: "completed",
      resultJson,
      errorMessage: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(commands.id, commandId),
        eq(commands.claimedBy, workerId),
        eq(commands.status, "claimed"),
      ),
    )
    .returning();

  if (!command) {
    throw new ApiError(
      409,
      "COMMAND_NOT_CLAIMED",
      "The command is not claimed by this worker.",
    );
  }

  await db.insert(commandEvents).values({
    commandId,
    eventType: "completed",
    message: `Command completed by worker ${workerId}.`,
    metadataJson: { workerId },
  });
  return command;
}

export async function failCommand(
  commandId: string,
  workerId: string,
  errorMessage: string,
  resultJson?: Record<string, unknown>,
) {
  const db = getDb();
  const [command] = await db
    .update(commands)
    .set({
      status: "failed",
      resultJson: resultJson ?? null,
      errorMessage,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(commands.id, commandId),
        eq(commands.claimedBy, workerId),
        eq(commands.status, "claimed"),
      ),
    )
    .returning();

  if (!command) {
    throw new ApiError(
      409,
      "COMMAND_NOT_CLAIMED",
      "The command is not claimed by this worker.",
    );
  }

  await db.insert(commandEvents).values({
    commandId,
    eventType: "failed",
    message: `Command failed on worker ${workerId}.`,
    metadataJson: { workerId, errorMessage },
  });
  return command;
}
