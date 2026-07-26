import type { NormalizedJobInput } from "../types";
import type { BrowserDiscoverySource } from "./browserDiscovery";

export type JobDetailFallback = {
  query: string;
  location?: string;
};

export type ExtractedJobDetail = NormalizedJobInput & {
  extractionNotes: string[];
};

type JsonLdJobPosting = {
  "@type"?: string | string[];
  title?: string;
  name?: string;
  description?: string;
  employmentType?: string | string[];
  datePosted?: string;
  hiringOrganization?: { name?: string } | string;
  jobLocation?: unknown;
  applicantLocationRequirements?: unknown;
  baseSalary?: unknown;
};

export function decodeHtmlAttribute(value: string) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

export function stripHtmlToText(html: string) {
  return decodeHtmlAttribute(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>|<\/li>|<\/div>|<\/h[1-6]>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  ).replace(/[ \t]+/g, " ");
}

export function extractIndeedMetadata(rawUrl: string): Partial<NormalizedJobInput> {
  try {
    const url = new URL(decodeHtmlAttribute(rawUrl));
    return cleanPartial({
      title: clean(url.searchParams.get("ti")),
      company: clean(url.searchParams.get("cmp")),
      sourceUrl: url.toString(),
    });
  } catch {
    return {};
  }
}

export function extractJsonLdJobPosting(html: string): Partial<NormalizedJobInput> {
  const postings = extractJsonLdObjects(html).flatMap(flattenJsonLd).filter(isJobPosting);
  const posting = postings[0];
  if (!posting) return {};

  const company =
    typeof posting.hiringOrganization === "string"
      ? posting.hiringOrganization
      : posting.hiringOrganization?.name;

  return cleanPartial({
    title: clean(posting.title ?? posting.name),
    company: clean(company),
    description: clean(stripHtmlToText(posting.description ?? "")),
    employmentType: normalizeEmploymentType(arrayText(posting.employmentType)),
    postedDate: parseDate(posting.datePosted),
    salaryText: salaryToText(posting.baseSalary),
    location: locationToText(posting.jobLocation ?? posting.applicantLocationRequirements),
  });
}

export function extractJobDetail(
  source: BrowserDiscoverySource,
  rawUrl: string,
  html: string,
  fallback: JobDetailFallback,
): ExtractedJobDetail {
  const extractionNotes: string[] = [];
  const text = stripHtmlToText(html);
  const urlMetadata = source === "indeed" ? extractIndeedMetadata(rawUrl) : safeUrl(rawUrl);
  if (urlMetadata.title || urlMetadata.company) extractionNotes.push("used_url_metadata");

  const jsonLd = extractJsonLdJobPosting(html);
  if (jsonLd.title || jsonLd.company || jsonLd.description) extractionNotes.push("used_json_ld");

  const htmlFallback = extractHtmlFallback(source, html, text);
  if (htmlFallback.title || htmlFallback.company || htmlFallback.description) extractionNotes.push("used_html_fallback");

  const merged = cleanPartial({
    ...urlMetadata,
    ...jsonLd,
    ...htmlFallback,
    title: htmlFallback.title ?? jsonLd.title ?? urlMetadata.title ?? `${fallback.query} discovered job${fallback.location ? ` — ${fallback.location}` : ""}`,
    company: htmlFallback.company ?? jsonLd.company ?? urlMetadata.company ?? `${source} browser discovery`,
    location: htmlFallback.location ?? jsonLd.location ?? fallback.location ?? null,
    description:
      htmlFallback.description ??
      jsonLd.description ??
      `Browser-assisted discovery found this ${source} job link for query "${fallback.query}"${fallback.location ? ` in "${fallback.location}"` : ""}. Open locally to verify details before applying.`,
    source,
    sourceUrl: (urlMetadata.sourceUrl as string | undefined) ?? safeUrl(rawUrl).sourceUrl ?? rawUrl,
    employmentType: htmlFallback.employmentType ?? jsonLd.employmentType ?? detectEmploymentType(text),
    remoteType: htmlFallback.remoteType ?? detectRemoteType(`${text}\n${fallback.location ?? ""}`),
    salaryText: htmlFallback.salaryText ?? jsonLd.salaryText ?? detectSalary(text),
    visaSignal: detectVisaSignal(text),
    techStack: keywordsFromText(`${fallback.query}\n${text}`),
  }) as ExtractedJobDetail;

  merged.status = "new";
  merged.priority = "normal";
  merged.notes = [
    "Phase 2B browser-assisted discovery with detail enrichment. Human-speed search only; no apply/submit automation.",
    extractionNotes.length ? `Extraction: ${extractionNotes.join(", ")}.` : "Extraction: fallback only.",
  ].join(" ");
  merged.extractionNotes = extractionNotes;
  return merged;
}

function extractHtmlFallback(source: BrowserDiscoverySource, html: string, text: string): Partial<NormalizedJobInput> {
  const titleTag = clean(matchFirst(html, /<title[^>]*>([\s\S]*?)<\/title>/i));
  const h1 = clean(matchFirst(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i));
  const description = clean(firstLongSection(html, text));
  const title = cleanTitle(source, h1 ?? titleTag);
  const company = clean(matchFirst(html, /data-company-name=["']?true["']?[^>]*>([\s\S]*?)<\/[^>]+>/i)) ?? companyFromTitle(source, titleTag);
  return cleanPartial({
    title,
    company,
    description,
    employmentType: detectEmploymentType(text),
    remoteType: detectRemoteType(text),
    salaryText: detectSalary(text),
  });
}

function extractJsonLdObjects(html: string) {
  const objects: unknown[] = [];
  const pattern = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    try {
      objects.push(JSON.parse(decodeHtmlAttribute(match[1].trim())));
    } catch {
      // Ignore malformed JSON-LD blocks.
    }
  }
  return objects;
}

function flattenJsonLd(value: unknown): JsonLdJobPosting[] {
  if (Array.isArray(value)) return value.flatMap(flattenJsonLd);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const graph = record["@graph"];
  return [record as JsonLdJobPosting, ...flattenJsonLd(graph)];
}

function isJobPosting(value: JsonLdJobPosting) {
  const type = value["@type"];
  const types = Array.isArray(type) ? type : [type];
  return types.some((item) => String(item).toLowerCase() === "jobposting");
}

function cleanPartial<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== "")) as T;
}

function clean(value: string | null | undefined) {
  const cleaned = value ? stripHtmlToText(value).replace(/\s+/g, " ").trim() : undefined;
  return cleaned || undefined;
}

function matchFirst(text: string, pattern: RegExp) {
  return text.match(pattern)?.[1];
}

function firstLongSection(html: string, text: string) {
  const known =
    matchFirst(html, /<div[^>]+id=["']jobDescriptionText["'][^>]*>([\s\S]*?)<\/div>/i) ??
    matchFirst(html, /<section[^>]+class=["'][^"']*job[-_ ]?description[^"']*["'][^>]*>([\s\S]*?)<\/section>/i);
  const stripped = known ? stripHtmlToText(known) : text;
  return stripped.length > 400 ? stripped.slice(0, 12000) : stripped || undefined;
}

function cleanTitle(source: BrowserDiscoverySource, title?: string) {
  if (!title) return undefined;
  const separators = source === "indeed" ? [/ - .+? \| Indeed/i, / jobs, employment in .+? \| Indeed/i] : [/ \| Dice\.com/i, / \| LinkedIn/i];
  let cleaned = title;
  for (const pattern of separators) cleaned = cleaned.replace(pattern, "");
  return cleaned.replace(/\s+/g, " ").trim() || undefined;
}

function companyFromTitle(source: BrowserDiscoverySource, title?: string) {
  if (!title || source !== "indeed") return undefined;
  const match = title.match(/^(.*?)\s+-\s+(.+?)\s+\|\s+Indeed/i);
  return clean(match?.[2]);
}

function parseDate(value?: string) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function arrayText(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value.join(" ");
  return value;
}

function normalizeEmploymentType(value?: string) {
  if (!value) return undefined;
  if (/contractor/i.test(value)) return "contract";
  return detectEmploymentType(value) ?? value.toLowerCase().replace(/_/g, "-");
}

function salaryToText(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return clean(value);
  try {
    return clean(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function locationToText(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return clean(value);
  if (Array.isArray(value)) return clean(value.map(locationToText).filter(Boolean).join("; "));
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const address = record.address as Record<string, unknown> | undefined;
    return clean(
      [
        record.name,
        address?.addressLocality,
        address?.addressRegion,
        address?.addressCountry,
      ]
        .filter(Boolean)
        .join(", "),
    );
  }
  return undefined;
}

function safeUrl(rawUrl: string): Partial<NormalizedJobInput> {
  try {
    return { sourceUrl: new URL(decodeHtmlAttribute(rawUrl)).toString() };
  } catch {
    return {};
  }
}

function detectVisaSignal(text: string) {
  if (/u\.?s\.? citizens? only|citizenship required|must be a us citizen/i.test(text)) return "citizen_only";
  if (/\b(gc|green card)\s*(\/|or)?\s*(usc|u\.?s\.? citizen)|usc\s*(\/|or)?\s*gc/i.test(text)) return "gc_usc_only";
  if (/security clearance|active clearance|secret clearance|top secret/i.test(text)) return "clearance_required";
  if (/no sponsorship|no visa sponsorship|visa sponsorship is not available|sponsorship is not available|do not provide visa sponsorship|unable to sponsor|cannot sponsor|without sponsorship|will not sponsor|requiring visa sponsorship will not be considered/i.test(text)) return "no_sponsorship";
  if (/h-?1b transfer/i.test(text)) return "h1b_transfer_explicit";
  if (/sponsorship.*available|visa sponsorship|will sponsor|sponsor.*visa/i.test(text)) return "sponsorship_available";
  if (/\b(contract|contract-to-hire|c2h|c2c|corp-to-corp|w2)\b/i.test(text)) return "contract_likely";
  return "unknown";
}

function detectRemoteType(text: string) {
  if (/\bremote\b/i.test(text)) return "remote";
  if (/\bhybrid\b/i.test(text)) return "hybrid";
  if (/on[- ]?site|onsite/i.test(text)) return "onsite";
  return null;
}

function detectEmploymentType(text: string) {
  if (/contract-to-hire|contract to hire|c2h/i.test(text)) return "contract-to-hire";
  if (/corp-to-corp|c2c/i.test(text)) return "c2c";
  if (/\bw2\b.*\bcontract\b|\bcontract\b.*\bw2\b/i.test(text)) return "w2-contract";
  if (/\bcontract\b/i.test(text)) return "contract";
  if (/full[- ]?time|permanent/i.test(text)) return "full-time";
  if (/part[- ]?time/i.test(text)) return "part-time";
  return null;
}

function detectSalary(text: string) {
  return text.match(/\$\s?\d{2,3}(?:,\d{3})?(?:\s?[-–]\s?\$?\d{2,3}(?:,\d{3})?)?\s?(?:\/\s?hr|per hour|hourly|k|annually|year|yr)?/i)?.[0] ?? null;
}

function keywordsFromText(text: string) {
  const stack: string[] = [];
  const checks: Array<[string, RegExp]> = [
    [".NET", /\.net\b|asp\.net|dotnet/i],
    ["C#", /c#|c sharp/i],
    ["SQL", /\bsql\b|sql server|t-sql|tsql/i],
    ["Oracle", /\boracle\b|pl\/sql/i],
    ["Azure", /\bazure\b/i],
    ["React", /\breact\b/i],
    ["Angular", /\bangular\b/i],
    ["Production Support", /production support|application support/i],
  ];
  for (const [label, pattern] of checks) if (pattern.test(text)) stack.push(label);
  return Array.from(new Set(stack));
}
