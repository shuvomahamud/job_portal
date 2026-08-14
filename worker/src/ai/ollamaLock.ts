/**
 * Mutual exclusion over the local Ollama, shared by the scoring and applying workers.
 *
 * Once scoring and applying run continuously in separate processes they genuinely
 * contend: Ollama serves one request at a time, so an application waiting to have a
 * dropdown mapped can end up queued behind a fifteen-second scoring call while a real
 * employer's form sits half-filled on screen.
 *
 * Applying wins. It is the side with an open form and a person's name on it; scoring can
 * always wait, because nothing downstream is blocked by a posting being scored a minute
 * later. So the applier takes the lock immediately and, if scoring holds it, scoring is
 * told to give it up at its next safe point.
 *
 * The mechanism is a directory, exactly like the worker process lock this borrows from:
 * mkdir is atomic on POSIX, the owner file records a pid, and a lock whose owner is no
 * longer alive is reclaimed rather than deadlocking the machine after a SIGKILL. Postgres
 * advisory locks were the obvious alternative and do not work here — the Neon HTTP driver
 * is stateless and cannot hold a session — and both workers are on the same Mac anyway.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../logger";

export type OllamaLockRole = "scoring" | "applying";

type LockOwner = {
  pid: number;
  token: string;
  role: OllamaLockRole;
  acquiredAt: string;
};

export type OllamaLease = { release: () => void };

/** Long enough for the slowest single call, short enough that a crash is not fatal. */
const STALE_AFTER_MS = 3 * 60_000;

function lockPath(root: string): string {
  return join(root, "job-portal-ollama.lock");
}

function readOwner(path: string): LockOwner | null {
  try {
    return JSON.parse(readFileSync(join(path, "owner.json"), "utf8")) as LockOwner;
  } catch {
    return null;
  }
}

function processIsRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * True when a held lock should be taken away from its owner.
 *
 * Two ways to lose it: the owner died, or it has been held implausibly long. The second
 * matters because a wedged process still answers a liveness check while making no
 * progress, and a permanently stuck lock would silently stop all model work.
 */
export function lockIsStale(
  owner: LockOwner | null,
  now = Date.now(),
  ownerAlive = owner ? processIsRunning(owner.pid) : false,
): boolean {
  if (!owner) return true;
  if (!ownerAlive) return true;
  const heldMs = now - new Date(owner.acquiredAt).getTime();
  return Number.isFinite(heldMs) && heldMs > STALE_AFTER_MS;
}

function tryAcquire(path: string, role: OllamaLockRole): OllamaLease | null {
  const owner: LockOwner = {
    pid: process.pid,
    token: randomUUID(),
    role,
    acquiredAt: new Date().toISOString(),
  };
  try {
    mkdirSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = readOwner(path);
    if (!lockIsStale(existing)) return null;
    logger.warn("Reclaiming a stale Ollama lock", {
      heldBy: existing?.role ?? "unknown",
      pid: existing?.pid ?? null,
    });
    rmSync(path, { recursive: true, force: true });
    try {
      mkdirSync(path);
    } catch {
      return null;
    }
  }
  writeFileSync(join(path, "owner.json"), JSON.stringify(owner));

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const current = readOwner(path);
    if (current?.token === owner.token) rmSync(path, { recursive: true, force: true });
    process.off("exit", release);
  };
  process.once("exit", release);
  return { release };
}

/** True when the lock is currently held by the applier. */
export function applyingHoldsLock(lockRoot = tmpdir()): boolean {
  const owner = readOwner(lockPath(lockRoot));
  if (!owner || lockIsStale(owner)) return false;
  return owner.role === "applying";
}

/**
 * Waits for the model, then runs `work` while holding it.
 *
 * Scoring gives up after `waitMs` and lets its caller move on rather than blocking the
 * whole worker; applying waits much longer, because abandoning a form mid-fill is worse
 * than being slow. Returns null when the lock could not be taken in time.
 */
export async function withOllamaLock<T>(
  role: OllamaLockRole,
  work: () => Promise<T>,
  options: { waitMs?: number; pollMs?: number; lockRoot?: string } = {},
): Promise<T | null> {
  const root = options.lockRoot ?? tmpdir();
  const path = lockPath(root);
  const waitMs = options.waitMs ?? (role === "applying" ? 120_000 : 15_000);
  const pollMs = options.pollMs ?? 250;
  const deadline = Date.now() + waitMs;

  for (;;) {
    const lease = tryAcquire(path, role);
    if (lease) {
      try {
        return await work();
      } finally {
        lease.release();
      }
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
