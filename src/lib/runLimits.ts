/**
 * A run is explicitly started by the user and stops after this many applications.
 * Keep one shared ceiling across the dashboard, command validation, and Mac worker so a
 * value accepted by one layer is never rejected by another.
 */
export const MAX_APPLICATIONS_PER_RUN = 1_000;

/** Discovery intentionally looks at more postings than the apply target. */
export const MAX_DISCOVERY_RESULTS_PER_COMMAND = MAX_APPLICATIONS_PER_RUN * 2;
