import { and, eq, sql } from "drizzle-orm";
import * as schema from "../../../src/db/schema";
import { getWorkerDb } from "../db";

const COUNTED_DAILY_STATUSES = [
  "submitting",
  "submission_unknown",
  "applied",
  "screening",
  "interview",
  "offer",
  "rejected",
  "withdrawn",
] as const;

export const ELIGIBLE_ROLE_MATCH_STATUS = "match" as const;

export async function isApplyPaused(userId: string): Promise<boolean> {
  const [settings] = await getWorkerDb()
    .select({ applyPaused: schema.automationSettings.applyPaused })
    .from(schema.automationSettings)
    .where(eq(schema.automationSettings.userId, userId))
    .limit(1);
  return settings?.applyPaused ?? false;
}

export function remainingDailyCapacity(input: {
  globalCap: number;
  globalCount: number;
  roleCap: number | null;
  roleCount: number;
}): { globalRemaining: number; roleRemaining: number; remaining: number } {
  const globalRemaining = Math.max(0, input.globalCap - input.globalCount);
  const roleRemaining = input.roleCap == null
    ? Number.POSITIVE_INFINITY
    : Math.max(0, input.roleCap - input.roleCount);
  return { globalRemaining, roleRemaining, remaining: Math.min(globalRemaining, roleRemaining) };
}

export async function getRemainingDailyCapacity(input: {
  userId: string;
  targetRoleId: string;
  globalCap: number;
  roleCap: number | null;
}): Promise<{ globalRemaining: number; roleRemaining: number; remaining: number }> {
  const database = getWorkerDb();
  const countedToday = sql`COALESCE(${schema.applications.submittedAt}, ${schema.applications.appliedAt}, ${schema.applications.createdAt}) >= CURRENT_DATE`;
  const countedStatus = sql`${schema.applications.status} IN (${sql.join(
    COUNTED_DAILY_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  )})`;

  const [[globalRow], [roleRow]] = await Promise.all([
    database
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.applications)
      .where(and(eq(schema.applications.userId, input.userId), countedStatus, countedToday)),
    database
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.applications)
      .where(
        and(
          eq(schema.applications.userId, input.userId),
          eq(schema.applications.targetRoleId, input.targetRoleId),
          countedStatus,
          countedToday,
        ),
      ),
  ]);

  return remainingDailyCapacity({
    globalCap: input.globalCap,
    globalCount: globalRow?.count ?? 0,
    roleCap: input.roleCap,
    roleCount: roleRow?.count ?? 0,
  });
}
