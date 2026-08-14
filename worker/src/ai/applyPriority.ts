/**
 * Keeps scoring out of the way of an application in progress.
 *
 * Scoring and applying both talk to the same local Ollama, which serves one request at a
 * time. Once they run in separate processes they can collide: an application that needs a
 * dropdown mapped would queue behind a scoring request and wait fifteen seconds, in the
 * middle of filling a real employer's form.
 *
 * A mutex would not fix that — it would make the waiting orderly rather than remove it,
 * because whoever holds the lock still finishes first. What is actually wanted is that
 * applying always wins, so the scorer stands down for the duration instead.
 *
 * No lock primitive is needed to know that. An apply run is already a command sitting in
 * `claimed`, so the question "is an application happening right now" is answered by state
 * the database is keeping anyway. Postgres advisory locks would not have worked in any
 * case: the Neon HTTP driver is stateless and cannot hold a session.
 *
 * This costs nothing in throughput. Discovery and applying are both claimed by the single
 * browser worker, so they never overlap; scoring runs flat out during discovery — the
 * whole point of the split — and only pauses while applying, when no new postings are
 * arriving to score.
 */
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "../../../src/db/schema";
import { getWorkerDb } from "../db";

/** Command types that mean a form is being filled or submitted right now. */
const APPLYING_TYPES = ["apply_to_jobs"] as const;

export async function isApplyRunActive(userId: string): Promise<boolean> {
  const [row] = await getWorkerDb()
    .select({ id: schema.commands.id })
    .from(schema.commands)
    .where(
      and(
        eq(schema.commands.requestedBy, userId),
        inArray(schema.commands.type, [...APPLYING_TYPES]),
        eq(schema.commands.status, "claimed"),
      ),
    )
    .limit(1);
  return Boolean(row);
}
