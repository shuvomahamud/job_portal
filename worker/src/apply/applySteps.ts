import type { FrameLike, LocatorLike, PageLike } from "../browser/playwrightTypes";
import { detectBrowserBlocker } from "../browser/blockerDetection";
import { classifyControlLabel, ADVANCE_CONTROL_NAME, TERMINAL_CONTROL_NAME } from "./external/controlLocator";

export type SiteAdapter = {
  source: "indeed" | "dice" | "fixture";
  allowedApplyHosts: string[];
  findApplyButton(page: PageLike): Promise<LocatorLike | null>;
  findAdvanceControl(
    frame: FrameLike,
  ): Promise<{ locator: LocatorLike; isTerminalSubmit: boolean } | null>;
  detectSuccess(page: PageLike): Promise<boolean>;
  detectBlocked(page: PageLike): Promise<{ blocked: boolean; reason: string }>;
};

function firstVisible(locator: LocatorLike): Promise<LocatorLike | null> {
  return locator.count().then(async (count) => {
    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index);
      if (await item.isVisible({ timeout: 200 }).catch(() => false)) return item;
    }
    return null;
  });
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function accessibleName(locator: LocatorLike): Promise<string> {
  const aria = (await locator.getAttribute("aria-label").catch(() => null))?.trim();
  if (aria) return aria;
  return (await locator.innerText().catch(() => "")).trim();
}

export function looksLikeAlreadyApplied(text: string): boolean {
  return /you['’]?ve already applied|already applied to this job/i.test(text);
}

export function looksLikeSubmitted(text: string): boolean {
  return /application (has been )?submitted|thanks for applying|we received your application/i.test(
    text,
  );
}

/**
 * First visible button whose accessible name matches, after dropping carousel/preview
 * and abandon controls that a `/next/` regex would otherwise accept.
 */
async function firstVisibleAdvance(
  frame: FrameLike,
  name: RegExp,
): Promise<LocatorLike | null> {
  const locator = frame.getByRole("button", { name });
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (!(await item.isVisible({ timeout: 200 }).catch(() => false))) continue;
    if (!classifyControlLabel(await accessibleName(item)).advances) continue;
    return item;
  }
  return null;
}

const indeedAdapter: SiteAdapter = {
  source: "indeed",
  allowedApplyHosts: ["indeed.com", "smartapply.indeed.com"],
  async findApplyButton(page) {
    const candidates = [
      page.getByRole("button", { name: /apply now|easily apply|apply/i }),
      page.locator('a:has-text("Apply now"), button:has-text("Apply")'),
    ];
    for (const locator of candidates) {
      const found = await firstVisible(locator);
      if (found) return found;
    }
    return null;
  },
  async findAdvanceControl(frame) {
    const submit = await firstVisibleAdvance(frame, TERMINAL_CONTROL_NAME);
    if (submit) return { locator: submit, isTerminalSubmit: true };
    const cont = await firstVisibleAdvance(frame, ADVANCE_CONTROL_NAME);
    if (cont) return { locator: cont, isTerminalSubmit: false };
    return null;
  },
  async detectSuccess(page) {
    const text = await page.locator("body").innerText({ timeout: 2000 }).catch(() => "");
    return looksLikeAlreadyApplied(text) || looksLikeSubmitted(text);
  },
  async detectBlocked(page) {
    // Delegates to the shared detector rather than testing for the bare word "captcha".
    //
    // That test was matching Indeed's own apply form: the footer carries a "protected by
    // reCAPTCHA" notice, so a perfectly ordinary "Add your location" page was declared a
    // challenge. The run stopped, an alert fired, and the tab was left open on a form
    // nobody was filling — with the real challenge nowhere to be seen.
    //
    // The shared detector already knows better: it needs a *visible* challenge element or
    // explicit human-verification wording, precisely because Indeed embeds invisible
    // reCAPTCHA on ordinary pages.
    const blocker = await detectBrowserBlocker(page);
    if (blocker) {
      return { blocked: true, reason: blocker.message };
    }
    return { blocked: false, reason: "" };
  },
};

const diceAdapter: SiteAdapter = {
  ...indeedAdapter,
  source: "dice",
  allowedApplyHosts: ["dice.com"],
  async findAdvanceControl(frame) {
    const submit = await firstVisibleAdvance(frame, TERMINAL_CONTROL_NAME);
    if (submit) return { locator: submit, isTerminalSubmit: true };
    const exact = await firstVisibleAdvance(frame, /^(next|continue)$/i);
    if (exact) return { locator: exact, isTerminalSubmit: false };
    const labeled = await firstVisibleAdvance(frame, ADVANCE_CONTROL_NAME);
    if (labeled) return { locator: labeled, isTerminalSubmit: false };
    const textNext = await firstVisible(frame.getByText(/^(next|continue)$/i));
    if (textNext) return { locator: textNext, isTerminalSubmit: false };
    return null;
  },
  /**
   * Dice needs its own, and inheriting Indeed's was why no Dice application ever started.
   *
   * Measured against a live posting: `getByRole("button", { name: /apply/i })` — the first
   * thing the Indeed adapter tries — matches nothing at all, because Dice's control is not
   * exposed with a button role. Every Dice application therefore sat on the job-detail page
   * until it was declared stalled, which is exactly what eighteen of them did.
   *
   * Dice also offers two different things called apply, and the difference matters.
   * "Easy Apply" is the on-platform form this system can actually complete. "Apply Now"
   * leaves for the employer's own site, which is a different path with a much higher score
   * bar and its own switch. So Easy Apply is preferred, and the external one is only taken
   * when there is no other way in.
   */
  async findApplyButton(page) {
    // Waits rather than checking once. Dice is a single-page app, and tonight's faster
    // pacing cut the settle time that used to paper over a control rendering late; a
    // 200ms glance at a page still assembling itself finds nothing and reports a stall.
    //
    // A partially completed application replaces Easy Apply with "Continue Application".
    // Waiting only for Easy Apply then looking for Apply Now never sees that button, so
    // the run stays on the job page and stalls with no click in the trace.
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const continueApp =
        (await firstVisible(page.getByRole("button", { name: /continue application/i }))) ??
        (await firstVisible(page.getByText(/continue application/i)));
      if (continueApp) return continueApp;
      const easy = await firstVisible(page.getByText(/easy apply/i));
      if (easy) return easy;
      const applyNow = await firstVisible(
        page.locator('a:has-text("Apply Now"), button:has-text("Apply Now")'),
      );
      if (applyNow) return applyNow;
      await delay(250);
    }
    return null;
  },
};

const fixtureAdapter: SiteAdapter = {
  source: "fixture",
  allowedApplyHosts: [],
  async findApplyButton(page) {
    return firstVisible(page.locator("#start-apply, [data-apply-start]"));
  },
  async findAdvanceControl(frame) {
    const terminal = await firstVisible(
      frame.locator("#final-submit, [data-terminal-submit], button[type=submit]"),
    );
    if (terminal) return { locator: terminal, isTerminalSubmit: true };
    const next = await firstVisible(frame.locator("#continue, [data-advance]"));
    if (next) return { locator: next, isTerminalSubmit: false };
    return null;
  },
  async detectSuccess(page) {
    const status = await page.locator("#submission-status").textContent().catch(() => null);
    if (status && /submitted|received/i.test(status)) return true;
    const text = await page.locator("body").innerText().catch(() => "");
    return /application submitted|thanks for applying/i.test(text);
  },
  async detectBlocked() {
    return { blocked: false, reason: "" };
  },
};

export function adapterFor(source: string): SiteAdapter {
  const normalized = source.toLowerCase();
  if (normalized === "dice") return diceAdapter;
  if (normalized === "fixture" || normalized === "file") return fixtureAdapter;
  return indeedAdapter;
}

export function isExternalAts(
  url: string,
  allowed: string[],
): { external: boolean; host: string } {
  try {
    if (url.startsWith("file:") || url.startsWith("about:")) {
      return { external: false, host: "" };
    }
    const host = new URL(url).hostname.toLowerCase();
    const allowedHost = allowed.some(
      (item) => host === item || host.endsWith(`.${item}`),
    );
    return { external: !allowedHost, host };
  } catch {
    return { external: true, host: "" };
  }
}

export function sourceUrlAllowed(source: string, sourceUrl: string): boolean {
  if (source === "fixture" || sourceUrl.startsWith("file:")) return true;
  try {
    const host = new URL(sourceUrl).hostname.toLowerCase();
    if (source === "indeed") return host === "indeed.com" || host.endsWith(".indeed.com");
    if (source === "dice") return host === "dice.com" || host.endsWith(".dice.com");
    return false;
  } catch {
    return false;
  }
}
