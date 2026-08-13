import type { PageLike } from "./playwrightTypes";

export type BrowserBlockerKind = "captcha" | "login_required" | "access_denied";
export type BrowserBlockerSite = "indeed" | "dice" | "linkedin" | "unknown";

export type BrowserBlocker = {
  kind: BrowserBlockerKind;
  site: BrowserBlockerSite;
  pageUrl: string;
  message: string;
  evidence: string;
};

export class BrowserInterventionRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserInterventionRequiredError";
  }
}

const CAPTCHA_TEXT =
  /verify (?:that )?you are (?:a )?human|unusual traffic|security check|press and hold|complete the challenge|cloudflare ray id/i;
const ACCESS_DENIED_TEXT =
  /access denied|temporarily blocked|request blocked|automated traffic|forbidden|too many requests/i;
const LOGIN_TEXT =
  /sign in to continue|log in to continue|session (?:has )?expired|authentication required/i;
const LOGIN_URL = /\/(?:login|signin|sign-in|auth)(?:[/?#]|$)|secure\.indeed\.com\/account/i;

async function hasVisibleChallengeElement(page: PageLike): Promise<boolean> {
  const candidates = page.locator(
    'iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], iframe[src*="challenge" i], [data-sitekey], input[name="cf-turnstile-response"]',
  );
  const count = await candidates.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    if (await candidates.nth(index).isVisible({ timeout: 500 }).catch(() => false)) {
      return true;
    }
  }
  return false;
}

export function siteFromUrl(rawUrl: string): BrowserBlockerSite {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === "indeed.com" || host.endsWith(".indeed.com")) return "indeed";
    if (host === "dice.com" || host.endsWith(".dice.com")) return "dice";
    if (host === "linkedin.com" || host.endsWith(".linkedin.com")) return "linkedin";
  } catch {
    // The caller still gets an actionable unknown-site alert.
  }
  return "unknown";
}

export function isLoginUrl(rawUrl: string): boolean {
  return LOGIN_URL.test(rawUrl);
}

/** Detects the intervention states that must never be mistaken for an empty result page. */
export async function detectBrowserBlocker(
  page: PageLike,
  expectedSite?: BrowserBlockerSite,
): Promise<BrowserBlocker | null> {
  const pageUrl = page.url();
  const site = expectedSite && expectedSite !== "unknown" ? expectedSite : siteFromUrl(pageUrl);
  const body = (await page.locator("body").innerText({ timeout: 2_000 }).catch(() => ""))
    .replace(/\s+/g, " ")
    .slice(0, 30_000);

  // Indeed embeds invisible reCAPTCHA frames on ordinary search-result pages. Presence
  // alone is therefore not evidence of a blocker; the challenge element must be visible
  // (or the page itself must contain explicit human-verification language).
  const visibleCaptcha = await hasVisibleChallengeElement(page);
  if (visibleCaptcha || CAPTCHA_TEXT.test(body)) {
    return {
      kind: "captcha",
      site,
      pageUrl,
      message: `${site === "unknown" ? "A job site" : site} needs a CAPTCHA or human verification solved in the worker browser.`,
      evidence: visibleCaptcha ? "Visible CAPTCHA/challenge element detected." : "Human-verification text detected.",
    };
  }

  if (ACCESS_DENIED_TEXT.test(body)) {
    return {
      kind: "access_denied",
      site,
      pageUrl,
      message: `${site === "unknown" ? "A job site" : site} blocked the worker browser and needs human attention.`,
      evidence: "Access-denied or automated-traffic text detected.",
    };
  }

  if (isLoginUrl(pageUrl) || LOGIN_TEXT.test(body)) {
    return {
      kind: "login_required",
      site,
      pageUrl,
      message: `${site === "unknown" ? "A job site" : site} requires you to log in again.`,
      evidence: isLoginUrl(pageUrl) ? "The browser was redirected to a login URL." : "Login-required text detected.",
    };
  }

  return null;
}
