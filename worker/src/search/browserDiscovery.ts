import type { JobSource, NormalizedJobInput } from "../types";

export type BrowserDiscoverySource = Extract<JobSource, "indeed" | "dice">;

export type BrowserDiscoverySpec = {
  source: BrowserDiscoverySource;
  query: string;
  location?: string;
};

export type HumanDelayOptions = {
  minDelayMs: number;
  maxDelayMs: number;
};

const sourceHosts: Record<BrowserDiscoverySource, string[]> = {
  indeed: ["indeed.com"],
  dice: ["dice.com"],
};

export function buildBrowserSearchUrl(spec: BrowserDiscoverySpec) {
  const query = encodeURIComponent(spec.query.trim());
  const location = spec.location ? encodeURIComponent(spec.location.trim()) : "";
  switch (spec.source) {
    case "indeed":
      return `https://www.indeed.com/jobs?q=${query}${location ? `&l=${location}` : ""}`;
    case "dice":
      return `https://www.dice.com/jobs?q=${query}${location ? `&location=${location}` : ""}`;
  }
}

export function buildBrowserSearchPageUrl(
  spec: BrowserDiscoverySpec,
  pageNumber: number,
) {
  const url = new URL(buildBrowserSearchUrl(spec));
  const page = Math.max(1, Math.floor(pageNumber));
  if (page > 1) {
    if (spec.source === "indeed") url.searchParams.set("start", String((page - 1) * 10));
    else url.searchParams.set("page", String(page));
  }
  return url.toString();
}

export function humanDelayMs(options: HumanDelayOptions, random = Math.random) {
  const min = Math.max(1000, Math.round(options.minDelayMs));
  const max = Math.max(min, Math.round(options.maxDelayMs));
  return Math.round(min + random() * (max - min));
}

export function extractJobUrlsFromHtml(source: BrowserDiscoverySource, html: string, currentUrl: string, maxResults: number) {
  const urls: string[] = [];
  const seen = new Set<string>();
  const anchorPattern = /<a\b[^>]*?href=["']([^"'#]+(?:#[^"']*)?)["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(html)) && urls.length < maxResults) {
    const normalized = normalizeJobUrl(source, match[1], currentUrl);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    urls.push(normalized);
  }
  return urls;
}

export function normalizeJobUrl(source: BrowserDiscoverySource, rawHref: string, currentUrl: string) {
  try {
    const url = new URL(decodeHtmlAttribute(rawHref), currentUrl);
    if (!sourceHosts[source].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) return null;
    if (!looksLikeJobUrl(source, url)) return null;
    stripTracking(url);
    return url.toString();
  } catch {
    return null;
  }
}

function decodeHtmlAttribute(value: string) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function looksLikeJobUrl(source: BrowserDiscoverySource, url: URL) {
  const path = url.pathname.toLowerCase();
  if (source === "indeed") {
    // The bare `jk` check this replaced was too loose: `/addlLoc/redirect` — Indeed's
    // "more locations for this search" widget — also stamps a jk parameter onto its
    // links, so every one of them passed as if it were a job. It is not; it lands on a
    // search-results page, not a posting, and the title/description extraction that then
    // ran against that page picked up the search page's own <title> tag instead — the
    // "Flexible Senior Software Engineer Jobs – Apply Today..." records this produced
    // were not a separate bug, they were this one.
    //
    // Checked against the actual URL shapes this discovery has stored: /viewjob and
    // /rc/clk both lead to a real posting — /rc/clk verified by hand, following one all
    // the way through a live Indeed apply flow. /addlLoc/redirect does not, and nothing
    // else has been observed, so nothing else is allowed on the strength of a guess.
    return path.includes("/viewjob") || path.includes("/rc/clk");
  }
  if (source === "dice") return path.includes("/job-detail") || path.includes("/jobs/detail");
  return false;
}

function stripTracking(url: URL) {
  for (const key of Array.from(url.searchParams.keys())) {
    if (/^(utm_|trk|ref|from|src|ss|sp|vjk)/i.test(key)) url.searchParams.delete(key);
  }
  url.hash = "";
}

export function buildDiscoveredJobRecords(
  source: BrowserDiscoverySource,
  urls: string[],
  spec: { query: string; location?: string },
): NormalizedJobInput[] {
  return urls.map((url) => {
    const metadata = jobMetadataFromUrl(source, url);
    return {
      title: metadata.title ?? `${spec.query} discovered job${spec.location ? ` — ${spec.location}` : ""}`,
      company: metadata.company ?? `${source} browser discovery`,
      location: spec.location ?? null,
      source,
      sourceUrl: url,
      description:
        `Browser-assisted discovery found this ${source} job link for query "${spec.query}"` +
        `${spec.location ? ` in "${spec.location}"` : ""}. Open locally to verify details before applying.`,
      status: "new",
      priority: "normal",
      visaSignal: "unknown",
      techStack: keywordsFromQuery(spec.query),
      notes: "Phase 2B browser-assisted discovery. Human-speed search only; no apply/submit automation.",
    };
  });
}

function jobMetadataFromUrl(source: BrowserDiscoverySource, rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    if (source === "indeed") {
      return {
        title: cleanMetadataValue(url.searchParams.get("ti")),
        company: cleanMetadataValue(url.searchParams.get("cmp")),
      };
    }
  } catch {
    // Keep generic discovery labels when URL metadata cannot be parsed.
  }
  return {};
}

function cleanMetadataValue(value: string | null) {
  const cleaned = value?.replace(/\s+/g, " ").trim();
  return cleaned || undefined;
}

function keywordsFromQuery(query: string) {
  const normalized = query.toLowerCase();
  const stack: string[] = [];
  if (normalized.includes(".net") || normalized.includes("dotnet")) stack.push(".NET");
  if (normalized.includes("c#") || normalized.includes("csharp") || normalized.includes("c sharp")) stack.push("C#");
  if (normalized.includes("sql")) stack.push("SQL");
  if (normalized.includes("oracle")) stack.push("Oracle");
  if (normalized.includes("azure")) stack.push("Azure");
  if (normalized.includes("react")) stack.push("React");
  if (normalized.includes("angular")) stack.push("Angular");
  return stack;
}
