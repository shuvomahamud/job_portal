import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BrowserContextLike, PageLike } from "../browser/playwrightTypes";
import { logger } from "../logger";

export type ArtifactContext = {
  commandId: string;
  jobId: string;
  artifactDir: string;
  page: PageLike;
  context: BrowserContextLike;
  paths: string[];
  sequence: number;
};

export function defaultArtifactRoot(configured?: string): string {
  return configured?.trim() || join(homedir(), ".job-portal", "artifacts");
}

export async function createArtifactContext(input: {
  commandId: string;
  jobId: string;
  artifactDir?: string;
  page: PageLike;
  context: BrowserContextLike;
}): Promise<ArtifactContext> {
  const root = defaultArtifactRoot(input.artifactDir);
  const dir = join(root, input.commandId, input.jobId);
  await mkdir(dir, { recursive: true }).catch(() => undefined);
  return {
    commandId: input.commandId,
    jobId: input.jobId,
    artifactDir: dir,
    page: input.page,
    context: input.context,
    paths: [],
    sequence: 0,
  };
}

export async function screenshot(ctx: ArtifactContext, label: string): Promise<string | null> {
  try {
    const index = String(ctx.sequence).padStart(2, "0");
    ctx.sequence += 1;
    const path = join(ctx.artifactDir, `${index}-${label}.png`);
    await ctx.page.screenshot({ path, fullPage: true });
    ctx.paths.push(path);
    return path;
  } catch (error) {
    logger.warn("Screenshot capture failed", {
      label,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function startTrace(ctx: ArtifactContext): Promise<void> {
  try {
    if (!ctx.context.tracing?.start) return;
    await ctx.context.tracing.start({ screenshots: true, snapshots: true });
  } catch (error) {
    logger.warn("Trace start failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function finishTrace(ctx: ArtifactContext, keep = false): Promise<string | null> {
  try {
    if (!ctx.context.tracing?.stop) return null;
    if (!keep) {
      await ctx.context.tracing.stop();
      return null;
    }
    const path = join(ctx.artifactDir, "trace.zip");
    await ctx.context.tracing.stop({ path });
    ctx.paths.push(path);
    return path;
  } catch (error) {
    logger.warn("Trace finish failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function writePlanArtifact(
  ctx: ArtifactContext,
  plan: unknown,
): Promise<string | null> {
  try {
    const path = join(ctx.artifactDir, "dry-run-plan.json");
    await writeFile(path, JSON.stringify(plan, null, 2), "utf8");
    ctx.paths.push(path);
    return path;
  } catch {
    return null;
  }
}
