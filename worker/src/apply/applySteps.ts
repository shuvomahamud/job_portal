import type { FrameLike, LocatorLike, PageLike } from "../browser/playwrightTypes";

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
    const submit = await firstVisible(
      frame.getByRole("button", { name: /submit application|submit|send application/i }),
    );
    if (submit) return { locator: submit, isTerminalSubmit: true };
    const cont = await firstVisible(
      frame.getByRole("button", { name: /continue|next|save and continue/i }),
    );
    if (cont) return { locator: cont, isTerminalSubmit: false };
    return null;
  },
  async detectSuccess(page) {
    const text = await page.locator("body").innerText({ timeout: 2000 }).catch(() => "");
    return /application (has been )?submitted|thanks for applying|we received your application/i.test(
      text,
    );
  },
  async detectBlocked(page) {
    const text = await page.locator("body").innerText({ timeout: 2000 }).catch(() => "");
    if (/captcha|verify you are human|unusual traffic|access denied/i.test(text)) {
      return { blocked: true, reason: "Blocked by anti-bot or captcha challenge." };
    }
    return { blocked: false, reason: "" };
  },
};

const diceAdapter: SiteAdapter = {
  ...indeedAdapter,
  source: "dice",
  allowedApplyHosts: ["dice.com"],
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
