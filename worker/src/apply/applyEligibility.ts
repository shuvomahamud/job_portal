import { eq } from "drizzle-orm";
import * as schema from "../../../src/db/schema";
import { getWorkerDb } from "../db";

export const ELIGIBLE_ROLE_MATCH_STATUS = "match" as const;

export async function isApplyPaused(userId: string): Promise<boolean> {
  const [settings] = await getWorkerDb()
    .select({ applyPaused: schema.automationSettings.applyPaused })
    .from(schema.automationSettings)
    .where(eq(schema.automationSettings.userId, userId))
    .limit(1);
  return settings?.applyPaused ?? false;
}

export type RunLimitCandidate = {
  jobId: string;
  targetRoleId: string;
  roleRunLimit: number | null;
};

/**
 * Selects jobs for one apply run. Counts start at zero for every invocation; historical
 * applications and earlier runs never reduce this run's allowance.
 */
export function selectJobsWithinRunLimits(
  candidates: RunLimitCandidate[],
  maxApplicationsPerRun: number,
): string[] {
  const selectedJobIds: string[] = [];
  const selectedJobs = new Set<string>();
  const selectedPerRole = new Map<string, number>();

  for (const candidate of candidates) {
    if (selectedJobIds.length >= maxApplicationsPerRun) break;
    if (selectedJobs.has(candidate.jobId)) continue;

    const roleCount = selectedPerRole.get(candidate.targetRoleId) ?? 0;
    if (candidate.roleRunLimit != null && roleCount >= candidate.roleRunLimit) {
      continue;
    }

    selectedJobs.add(candidate.jobId);
    selectedJobIds.push(candidate.jobId);
    selectedPerRole.set(candidate.targetRoleId, roleCount + 1);
  }

  return selectedJobIds;
}
