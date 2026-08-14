import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyingHoldsLock,
  lockIsStale,
  withOllamaLock,
} from "../src/ai/ollamaLock";

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "ollama-lock-test-"));
}

test("two holders never overlap", async () => {
  const lockRoot = freshRoot();
  try {
    const order: string[] = [];
    const first = withOllamaLock(
      "scoring",
      async () => {
        order.push("first:in");
        await new Promise((r) => setTimeout(r, 120));
        order.push("first:out");
      },
      { lockRoot },
    );
    // Starts while the first is mid-flight, so it must queue rather than interleave.
    await new Promise((r) => setTimeout(r, 20));
    const second = withOllamaLock(
      "applying",
      async () => {
        order.push("second:in");
      },
      { lockRoot, pollMs: 10 },
    );
    await Promise.all([first, second]);
    assert.deepEqual(order, ["first:in", "first:out", "second:in"]);
  } finally {
    rmSync(lockRoot, { recursive: true, force: true });
  }
});

test("the lock is released even when the work throws", async () => {
  const lockRoot = freshRoot();
  try {
    await assert.rejects(
      withOllamaLock("scoring", async () => {
        throw new Error("model exploded");
      }, { lockRoot }),
    );
    // A leaked lock here would silently stop all model work until a restart.
    const after = await withOllamaLock("scoring", async () => "took it", { lockRoot, waitMs: 200 });
    assert.equal(after, "took it");
  } finally {
    rmSync(lockRoot, { recursive: true, force: true });
  }
});

test("scoring gives up rather than blocking its worker forever", async () => {
  const lockRoot = freshRoot();
  try {
    let released!: () => void;
    const holder = withOllamaLock(
      "applying",
      () => new Promise<void>((resolve) => { released = resolve; }),
      { lockRoot },
    );
    await new Promise((r) => setTimeout(r, 20));

    const startedAt = Date.now();
    const result = await withOllamaLock("scoring", async () => "should not run", {
      lockRoot,
      waitMs: 150,
      pollMs: 10,
    });
    assert.equal(result, null, "gave up instead of running");
    assert.ok(Date.now() - startedAt >= 140, "waited before giving up");
    released();
    await holder;
  } finally {
    rmSync(lockRoot, { recursive: true, force: true });
  }
});

test("applying announces itself so scoring can stand down", async () => {
  const lockRoot = freshRoot();
  try {
    assert.equal(applyingHoldsLock(lockRoot), false);
    let release!: () => void;
    const held = withOllamaLock(
      "applying",
      () => new Promise<void>((resolve) => { release = resolve; }),
      { lockRoot },
    );
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(applyingHoldsLock(lockRoot), true);
    release();
    await held;
    assert.equal(applyingHoldsLock(lockRoot), false);
  } finally {
    rmSync(lockRoot, { recursive: true, force: true });
  }
});

test("a lock held by a dead process is reclaimed, not deadlocked", () => {
  // The failure this prevents: a SIGKILL leaves the directory behind and every model call
  // afterwards waits on an owner that will never release.
  const owner = {
    pid: 999_999_999,
    token: "t",
    role: "scoring" as const,
    acquiredAt: new Date().toISOString(),
  };
  assert.equal(lockIsStale(owner, Date.now(), false), true, "dead owner loses the lock");
  assert.equal(lockIsStale(owner, Date.now(), true), false, "a live owner keeps it");
});

test("a live but wedged owner loses the lock eventually", () => {
  // A hung process still answers a liveness check while making no progress.
  const owner = {
    pid: process.pid,
    token: "t",
    role: "scoring" as const,
    acquiredAt: new Date(Date.now() - 10 * 60_000).toISOString(),
  };
  assert.equal(lockIsStale(owner, Date.now(), true), true);
});
