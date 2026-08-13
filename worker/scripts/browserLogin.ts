/**
 * Opens the worker's dedicated Chromium profile so you can log in to job sites by hand.
 *
 * The worker never touches your personal Chrome. It drives a separate Chromium with its
 * own profile directory (JOB_BROWSER_USER_DATA_DIR). Cookies you create here persist in
 * that directory, so logging in once is enough for the worker to stay signed in.
 *
 * Chromium locks the profile directory, so the worker must be stopped before running this.
 *
 *   npm run worker:login
 *   npm run worker:login -- dice
 */
import { config as loadEnv } from "dotenv";

loadEnv({ path: process.env.WORKER_ENV_FILE || ".env.local", quiet: true });
loadEnv({ path: process.env.WORKER_ENV_FILE || ".env", quiet: true });

const SITES: Record<string, string> = {
  indeed: "https://secure.indeed.com/account/login",
  dice: "https://www.dice.com/dashboard/login",
  linkedin: "https://www.linkedin.com/login",
};

const DEFAULT_USER_DATA_DIR = `${process.env.HOME}/.job-worker-browser-profile`;

async function main() {
  const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
  const targets = requested.length ? requested : Object.keys(SITES);

  const unknown = targets.filter((site) => !SITES[site]);
  if (unknown.length) {
    throw new Error(
      `Unknown site(s): ${unknown.join(", ")}. Supported: ${Object.keys(SITES).join(", ")}`,
    );
  }

  const userDataDir = process.env.JOB_BROWSER_USER_DATA_DIR || DEFAULT_USER_DATA_DIR;

  const dynamicImport = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<typeof import("playwright")>;
  let playwright: typeof import("playwright");
  try {
    playwright = await dynamicImport("playwright");
  } catch {
    throw new Error(
      "Playwright is not installed. Run: npm install -D playwright && npx playwright install chromium",
    );
  }

  console.log(`\nProfile directory: ${userDataDir}`);
  console.log("This is the worker's own Chromium profile, not your personal Chrome.\n");

  // Must match what the worker uses. Signing in through one browser fingerprint and then
  // browsing with another is what makes a saved session get challenged again later.
  const channel = process.env.JOB_BROWSER_CHANNEL;
  if (channel) console.log(`Browser: installed ${channel} (separate profile, not your own).`);

  // Always headed and without slowMo: this session is driven by you, not the worker.
  const context = await playwright.chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1365, height: 900 },
    locale: "en-US",
    args: ["--disable-blink-features=AutomationControlled"],
    ignoreDefaultArgs: ["--enable-automation"],
    ...(channel ? { channel } : {}),
  });

  for (const [index, site] of targets.entries()) {
    const page = index === 0 ? context.pages()[0] ?? (await context.newPage()) : await context.newPage();
    await page.goto(SITES[site], { waitUntil: "domcontentloaded", timeout: 60_000 });
    console.log(`Opened ${site}: ${SITES[site]}`);
  }

  console.log("\nLog in to each tab, then press Ctrl+C here (or close the window) to save the session.");
  console.log("Solve any CAPTCHA or 2FA now so the worker does not hit it later.\n");

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
    context.once("close", finish);
  });

  await context.close().catch(() => {
    // Already closed by the user; the profile is written either way.
  });
  console.log("Session saved. The worker will reuse these logins.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
