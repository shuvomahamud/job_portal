/**
 * Finds controls on an employer's site by asking a model to look at the page.
 *
 * Uses Stagehand's observe handler, not its agent. That distinction is the whole design:
 * `observe` proposes candidate elements and returns them, while an agent decides and
 * clicks. Everything about this system says a model may find a button and may not press
 * one — the submission guard makes that call — so the autonomous surface is deliberately
 * left unused even though it is right there.
 *
 * Attaches to the Chrome the worker is already driving rather than launching its own. Two
 * browsers would mean two sessions, two sets of cookies, and a challenge solved in the
 * wrong window. Note that Stagehand wants the WebSocket debugger URL here, not the HTTP
 * endpoint: given `http://127.0.0.1:9222` it fails with a bare "Unexpected server
 * response: 404", which is a long way from saying "I wanted a ws:// address".
 */
import { getConfig } from "../../config";
import { logger } from "../../logger";
import { classifyControlLabel, type ControlLocator, type LocatedControl } from "./controlLocator";
import type { FrameLike, PageLike } from "../../browser/playwrightTypes";

type ObserveResult = {
  selector?: string;
  description?: string;
  method?: string;
};

type StagehandLike = {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  observeHandler?: { observe(options: unknown): Promise<ObserveResult[]> };
};

/** Turns the browser's HTTP CDP endpoint into the WebSocket address Stagehand expects. */
export async function resolveCdpWebSocketUrl(httpUrl: string): Promise<string> {
  if (httpUrl.startsWith("ws://") || httpUrl.startsWith("wss://")) return httpUrl;
  const response = await fetch(new URL("/json/version", httpUrl), {
    signal: AbortSignal.timeout(5_000),
  });
  const body = (await response.json()) as { webSocketDebuggerUrl?: string };
  if (!body.webSocketDebuggerUrl) {
    throw new Error("The browser did not report a WebSocket debugger URL.");
  }
  return body.webSocketDebuggerUrl;
}

let shared: StagehandLike | null = null;

/**
 * One Stagehand per worker process, reused across applications.
 *
 * Initialising it is not free and it holds a CDP connection; creating one per application
 * would churn connections against the same browser for no benefit.
 */
async function getStagehand(): Promise<StagehandLike | null> {
  if (shared) return shared;
  const cfg = getConfig();
  if (!cfg.JOB_BROWSER_AGENT_ENABLED || !cfg.JOB_BROWSER_CDP_URL) return null;

  try {
    // Cast through unknown because `observeHandler` is private on the exported class.
    //
    // That is not an oversight to tidy up later — it is the honest state of the library.
    // In LOCAL mode there is no public observe: the public `observe()` lives on
    // StagehandAPIClient, which is the hosted Browserbase client and wants an API key and
    // project id. The only alternative on this side is `agent()`, which decides and clicks,
    // and handing an autonomous agent the submit button is the one thing this design will
    // not do.
    //
    // So the version is pinned exactly rather than by caret, and that pin is load-bearing:
    // a private field can move in a patch release without it being anybody's fault.
    const { Stagehand } = (await import("@browserbasehq/stagehand")) as unknown as {
      Stagehand: new (options: unknown) => StagehandLike;
    };
    const cdpUrl = await resolveCdpWebSocketUrl(cfg.JOB_BROWSER_CDP_URL);
    const instance = new Stagehand({
      env: "LOCAL",
      // Ollama speaks the OpenAI wire format on /v1, which is how a local model is used
      // here without any of it leaving the machine.
      modelName: `ollama/${cfg.JOB_BROWSER_AGENT_MODEL ?? cfg.OLLAMA_MODEL}`,
      modelClientOptions: {
        baseURL: `${cfg.OLLAMA_BASE_URL.replace(/\/$/, "")}/v1`,
        apiKey: "ollama",
      },
      localBrowserLaunchOptions: { cdpUrl },
      verbose: 0,
    });
    await instance.init();
    shared = instance;
    logger.info("Stagehand attached to the worker browser", {
      model: cfg.JOB_BROWSER_AGENT_MODEL ?? cfg.OLLAMA_MODEL,
    });
    return shared;
  } catch (error) {
    // Never fatal. Without it the deterministic locator still runs; the application is
    // slower to give up on an unfamiliar form, not broken.
    logger.warn("Could not start Stagehand; falling back to deterministic control finding", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function closeStagehand(): Promise<void> {
  if (!shared) return;
  try {
    await shared.close();
  } catch {
    // The browser outlives us either way; a failed close is not worth reporting.
  }
  shared = null;
}

export function createStagehandLocator(): ControlLocator {
  return {
    name: "model",
    async findAdvanceControl(_frame: FrameLike, _page: PageLike): Promise<LocatedControl | null> {
      const stagehand = await getStagehand();
      if (!stagehand?.observeHandler) return null;

      let candidates: ObserveResult[];
      try {
        candidates = await stagehand.observeHandler.observe({
          instruction:
            "Find the single button or link that submits this job application, or moves it to the next step. Ignore anything that saves for later, cancels, goes back, signs in, or creates an account.",
          returnAction: false,
        });
      } catch (error) {
        logger.warn("Stagehand observe failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }

      for (const candidate of candidates ?? []) {
        const label = (candidate.description ?? "").trim();
        if (!candidate.selector) continue;
        // The model's proposal is still put through the same label rules the deterministic
        // locator uses. It is good at finding things on an unseen page and no better than
        // a regex at knowing that "Save and close" throws the application away.
        const { advances, isTerminalSubmit } = classifyControlLabel(label);
        if (!advances) continue;
        return {
          locator: candidate.selector,
          isTerminalSubmit,
          label,
          proposedByModel: true,
        };
      }
      return null;
    },
  };
}
