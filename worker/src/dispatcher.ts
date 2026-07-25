import { z } from "zod";
import { addCommandEvent } from "./db";
import { handleImportJobs } from "./handlers/importJobs";
import { handleRunRuleFilter } from "./handlers/runRuleFilter";
import { handleRunJobSearch } from "./handlers/runJobSearch";
import type { DashboardCommand, HandlerResult } from "./types";

const phase2Handlers: Record<string, (payload: unknown) => Promise<HandlerResult>> = {
  import_jobs: handleImportJobs,
  run_rule_filter: handleRunRuleFilter,
  run_job_search: handleRunJobSearch,
};

export function supportedPhase2CommandTypes() {
  return Object.keys(phase2Handlers);
}

export async function dispatchCommand(command: DashboardCommand): Promise<HandlerResult> {
  const handler = phase2Handlers[command.type];
  if (!handler) {
    throw new Error(`Worker does not support command type ${command.type}. Enable this command in a later phase.`);
  }
  await addCommandEvent(command.id, "worker_dispatch", `Worker dispatching ${command.type}.`, {
    workerSupportedTypes: supportedPhase2CommandTypes(),
  });
  try {
    return await handler(command.payloadJson ?? {});
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(`Invalid ${command.type} payload: ${error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
    }
    throw error;
  }
}
