import type { JobSource, NormalizedJobInput } from "../types";

export type BrowserDiscoverySource = Extract<JobSource, "linkedin" | "indeed" | "dice">;

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
  linkedin: ["linkedin.com"],
  indeed: ["indeed.com"],
  dice: ["dice.com"],
};

export function buildBrowserSearchUrl(spec: BrowserDiscoverySpec) {
  const query = encodeURIComponent(spec.query.trim());
  const location = spec.location ? encodeURIComponent(spec.location.trim()) : "";
  switch (spec.source) {
    case "linkedin":
      return `https://www.linkedin.com/jobs/search/?keywords=${query}${location ? `&location=${location}` : ""}`;
    case "indeed":
      return `https://www.indeed.com/jobs?q=${query}${location ? `&l=${location}` : ""}`;
    case "dice":
      return `https://www.dice.com/jobs?q=${query}${location ? `&location=${location}` : ""}`;
  }
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
    const url = new URL(rawHref, currentUrl);
    if (!sourceHosts[source].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) return null;
    if (!looksLikeJobUrl(source, url)) return null;
    stripTracking(url);
    return url.toString();
  } catch {
    return null;
  }
}

function looksLikeJobUrl(source: BrowserDiscoverySource, url: URL) {
  const path = url.pathname.toLowerCase();
  const params = url.searchParams;
  if (source === "linkedin") return path.includes("/jobs/view") || params.has("currentJobId");
  if (source === "indeed") return path.includes("/viewjob") || params.has("jk");
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
  return urls.map((url) => ({
    title: `${spec.query} discovered job${spec.location ? ` — ${spec.location}` : ""}`,
    company: `${source} browser discovery`,
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
  }));
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
