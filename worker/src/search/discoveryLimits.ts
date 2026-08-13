/**
 * How many postings one discovery request may ask for.
 *
 * Three layers used to carry their own copy of this number — run_apply_cycle computed a
 * target, find_matching_jobs validated it, discover_jobs_browser enforced it — and they
 * drifted: a 50-application run asked for 100 and find_matching_jobs rejected the whole
 * command with "Too big: expected number to be <=50", so a discovery run silently found
 * nothing at all. Both handlers now validate against this constant.
 */
export { MAX_DISCOVERY_RESULTS_PER_COMMAND } from "../../../src/lib/runLimits";
import { MAX_DISCOVERY_RESULTS_PER_COMMAND } from "../../../src/lib/runLimits";

/** Never search for fewer than this, however small the apply target is. */
const MIN_DISCOVERY_RESULTS = 10;

/**
 * How many postings to search for in order to end up with `requestedJobs` worth applying to.
 *
 * Discovery has to out-run the target: most postings are scored uncertain or reject, so
 * finding exactly N would leave far fewer than N eligible. The result is always a value
 * discover_jobs_browser will accept.
 */
export function discoveryTargetFor(requestedJobs: number): number {
  return Math.min(
    MAX_DISCOVERY_RESULTS_PER_COMMAND,
    Math.max(MIN_DISCOVERY_RESULTS, requestedJobs * 2),
  );
}
