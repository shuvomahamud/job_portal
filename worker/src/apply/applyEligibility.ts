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
  /** Job board the posting came from, used to split a run across boards. */
  source?: string;
};

/**
 * Divides a run allowance evenly across the chosen boards, giving any remainder to the
 * earlier boards. 50 over two boards is 25/25; 51 is 26/25.
 */
export function splitAcrossSources(
  total: number,
  sources: readonly string[],
): Map<string, number> {
  const quotas = new Map<string, number>();
  if (!sources.length) return quotas;
  const base = Math.floor(total / sources.length);
  let remainder = total % sources.length;
  for (const source of sources) {
    quotas.set(source, base + (remainder > 0 ? 1 : 0));
    if (remainder > 0) remainder -= 1;
  }
  return quotas;
}

/**
 * Selects jobs for one apply run. Counts start at zero for every invocation; historical
 * applications and earlier runs never reduce this run's allowance.
 *
 * With more than one board chosen the allowance is split between them, so one board
 * cannot consume the whole run. A board that cannot fill its share does not waste it:
 * a second pass hands the leftovers to whichever board still has candidates, because the
 * number asked for is a target, not a per-board cap.
 */
export function selectJobsWithinRunLimits(
  candidates: RunLimitCandidate[],
  maxApplicationsPerRun: number,
  sources?: readonly string[],
): string[] {
  const selectedJobIds: string[] = [];
  const selectedJobs = new Set<string>();
  const selectedPerRole = new Map<string, number>();
  const selectedPerSource = new Map<string, number>();
  const quotas =
    sources && sources.length > 1
      ? splitAcrossSources(maxApplicationsPerRun, sources)
      : null;

  const take = (candidate: RunLimitCandidate, respectSourceQuota: boolean) => {
    if (selectedJobIds.length >= maxApplicationsPerRun) return;
    if (selectedJobs.has(candidate.jobId)) return;

    const roleCount = selectedPerRole.get(candidate.targetRoleId) ?? 0;
    if (candidate.roleRunLimit != null && roleCount >= candidate.roleRunLimit) return;

    if (respectSourceQuota && quotas && candidate.source) {
      const quota = quotas.get(candidate.source);
      const used = selectedPerSource.get(candidate.source) ?? 0;
      if (quota != null && used >= quota) return;
    }

    selectedJobs.add(candidate.jobId);
    selectedJobIds.push(candidate.jobId);
    selectedPerRole.set(candidate.targetRoleId, roleCount + 1);
    if (candidate.source) {
      selectedPerSource.set(candidate.source, (selectedPerSource.get(candidate.source) ?? 0) + 1);
    }
  };

  for (const candidate of candidates) take(candidate, true);
  // Backfill only matters when a board ran out of candidates before its share was used.
  if (quotas && selectedJobIds.length < maxApplicationsPerRun) {
    for (const candidate of candidates) take(candidate, false);
  }

  return selectedJobIds;
}
