import { z } from "zod";
import { getConfig } from "../config";
import { upsertJobs } from "../db";
import { buildSearchLinkJobs, type SearchSpec } from "../search/searchUrls";
import type { HandlerContext, HandlerResult } from "../types";

const sources = z.array(z.enum(["indeed", "dice"])).min(1).max(2).optional();
const payloadSchema = z.object({
  sources,
  queries: z.array(z.string().trim().min(1).max(200)).max(30).optional(),
  locations: z.array(z.string().trim().min(1).max(200)).max(30).optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).strict();

const defaultQueries = [
  ".NET developer C# SQL",
  "ASP.NET full stack developer",
  "application support SQL Oracle",
  "production support .NET SQL",
];

const defaultLocations = ["Remote", "New York", "Albany NY", "United States"];

export async function handleRunJobSearch(
  payload: unknown,
  context: HandlerContext,
): Promise<HandlerResult> {
  const cfg = getConfig();
  const input = payloadSchema.parse(payload);
  const limit = Math.min(input.limit ?? cfg.JOB_SEARCH_MAX_RESULTS_PER_COMMAND, cfg.JOB_SEARCH_MAX_RESULTS_PER_COMMAND);
  const sourcesToUse = input.sources ?? ["indeed", "dice"];
  const queries = input.queries?.length ? input.queries : defaultQueries;
  const locations = input.locations?.length ? input.locations : defaultLocations;

  const specs: SearchSpec[] = [];
  for (const source of sourcesToUse) {
    for (const query of queries) {
      for (const location of locations) {
        specs.push({ source, query, location });
      }
    }
  }

  const jobs = buildSearchLinkJobs(specs, limit);
  if (context.claimGuard.lost) {
    return { generated: jobs.length, upserted: 0, jobIds: [], claimLost: true };
  }
  const upserted = await upsertJobs(jobs);

  return {
    mode: "lightweight_search_links",
    message: "Generated Indeed/Dice search links without account automation. Use Find matching jobs for individual posting discovery and AI review.",
    generated: jobs.length,
    upserted: upserted.length,
    sources: sourcesToUse,
    queries,
    locations,
    jobIds: upserted.map((job) => job.id),
  };
}
