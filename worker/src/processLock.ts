import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type LockOwner = {
  pid: number;
  token: string;
  workerId: string;
  startedAt: string;
};

function processIsRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readOwner(path: string): LockOwner | null {
  try {
    return JSON.parse(readFileSync(join(path, "owner.json"), "utf8")) as LockOwner;
  } catch {
    return null;
  }
}

/**
 * Prevent two local processes with the same worker id from claiming work concurrently.
 * A SIGKILL can leave the directory behind, so a dead owner's lock is reclaimed safely.
 */
export function acquireWorkerProcessLock(
  workerId: string,
  lockRoot = tmpdir(),
): { path: string; release: () => void } {
  const safeWorkerId = workerId.replace(/[^a-z0-9_.-]/gi, "_");
  const path = join(lockRoot, `job-portal-worker-${safeWorkerId}.lock`);
  const owner: LockOwner = {
    pid: process.pid,
    token: randomUUID(),
    workerId,
    startedAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(path);
      writeFileSync(join(path, "owner.json"), JSON.stringify(owner), { flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = readOwner(path);
      if (existing && processIsRunning(existing.pid)) {
        throw new Error(
          `Worker ${workerId} is already running as process ${existing.pid}; refusing to start a duplicate.`,
        );
      }
      rmSync(path, { recursive: true, force: true });
      if (attempt === 1) throw error;
    }
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const current = readOwner(path);
    if (current?.token === owner.token) rmSync(path, { recursive: true, force: true });
    process.off("exit", release);
  };
  process.once("exit", release);
  return { path, release };
}
