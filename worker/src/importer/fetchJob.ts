import { getConfig } from "../config";
import type { JobSource, NormalizedJobInput } from "../types";

function textBetween(html: string, pattern: RegExp) {
  const match = html.match(pattern);
  return match?.[1]?.replace(/\s+/g, " ").trim() || null;
}

function inferSource(url: string): JobSource {
  const host = new URL(url).hostname.toLowerCase();
  if (host.includes("linkedin")) return "linkedin";
  if (host.includes("indeed")) return "indeed";
  if (host.includes("dice")) return "dice";
  if (host.includes("greenhouse") || host.includes("lever") || host.includes("workday") || host.includes("icims")) return "company_site";
  return "other";
}

export async function normalizeUrlJob(url: string, source?: JobSource): Promise<NormalizedJobInput> {
  const cfg = getConfig();
  const sourceUrl = new URL(url).toString();
  let title = "Imported job";
  let company = new URL(sourceUrl).hostname.replace(/^www\./, "");
  let description = `Imported from ${sourceUrl}. Description fetch disabled or unavailable.`;

  if (cfg.JOB_IMPORT_FETCH_DESCRIPTIONS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), cfg.JOB_IMPORT_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(sourceUrl, {
        signal: controller.signal,
        headers: { "user-agent": "Mozilla/5.0 SearchlightJobWorker/1.0" },
      });
      const html = await response.text();
      const metaTitle = textBetween(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
        ?? textBetween(html, /<title[^>]*>([^<]+)<\/title>/i);
      const metaDescription = textBetween(html, /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["']/i);
      if (metaTitle) title = metaTitle.slice(0, 300);
      if (metaDescription) description = metaDescription.slice(0, 20000);
      company = textBetween(html, /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i) ?? company;
    } catch {
      // Keep safe fallback. Many job boards block server-side fetches.
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    title,
    company,
    source: source ?? inferSource(sourceUrl),
    sourceUrl,
    description,
    status: "new",
    notes: "Imported by Phase 2 worker.",
  };
}
