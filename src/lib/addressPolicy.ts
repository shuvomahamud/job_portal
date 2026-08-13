/**
 * Picks which of the candidate's addresses to put on an application.
 *
 * Shared with the worker so the dashboard can show the same answer the apply run will use.
 *
 * Deliberately deterministic rather than geocoded: real postings carry explicit city text
 * ("New York, NY, US", "Long Island City, NY, US", "Albany, NY"), so matching city and
 * metro names against that string resolves them without a geocoding service, a network
 * call, or a model. Anything unresolvable (remote roles, bare "USA") falls back to the
 * address marked primary, which is also what a human would do.
 */

export type AddressLike = {
  id: string;
  label: string;
  city: string;
  stateRegion: string;
  isPrimary: boolean;
  matchTerms: string[];
};

export type JobLocationInput = {
  location?: string | null;
  remoteType?: string | null;
};

export type AddressChoice<T extends AddressLike> = {
  address: T;
  /** Why this address won — surfaced in the apply plan and the dashboard preview. */
  reason: string;
  matchedTerm: string | null;
  score: number;
};

/** A city or metro name hit. Strong enough to decide on its own. */
const SCORE_LOCALITY = 3;
/** Only the state matched. Both NY addresses tie here, which correctly defers to primary. */
const SCORE_STATE = 1;

/** Suggested metro terms, offered as UI defaults. Users can edit them per address. */
export const SUGGESTED_MATCH_TERMS: Record<string, string[]> = {
  "new york": [
    "new york", "new york city", "nyc", "manhattan", "brooklyn", "queens", "bronx",
    "staten island", "long island city", "long island", "jersey city", "newark",
    "hoboken", "yonkers", "white plains", "westchester",
  ],
  albany: [
    "albany", "capital region", "schenectady", "troy", "saratoga springs", "colonie",
    "latham", "clifton park", "rensselaer",
  ],
};

export function suggestedTermsForCity(city: string): string[] {
  return SUGGESTED_MATCH_TERMS[city.trim().toLowerCase()] ?? [];
}

/** Lowercase, strip punctuation to spaces, collapse runs. Keeps word boundaries intact. */
export function normalizeLocationText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Whole-word/phrase containment, so "ny" never matches inside "sunny" or "albany". */
export function containsTerm(haystack: string, term: string): boolean {
  const needle = normalizeLocationText(term);
  if (!needle) return false;
  const padded = ` ${haystack} `;
  return padded.includes(` ${needle} `);
}

function scoreAddress(
  address: AddressLike,
  normalizedLocation: string,
): { score: number; matchedTerm: string | null } {
  if (!normalizedLocation) return { score: 0, matchedTerm: null };

  // City first so the reason names the city rather than an incidental alias.
  const localityTerms = [address.city, ...address.matchTerms]
    .map((term) => term?.trim())
    .filter((term): term is string => Boolean(term));

  for (const term of localityTerms) {
    if (containsTerm(normalizedLocation, term)) {
      return { score: SCORE_LOCALITY, matchedTerm: term };
    }
  }

  if (address.stateRegion && containsTerm(normalizedLocation, address.stateRegion)) {
    return { score: SCORE_STATE, matchedTerm: address.stateRegion };
  }

  return { score: 0, matchedTerm: null };
}

function primaryOf<T extends AddressLike>(addresses: T[]): T {
  return addresses.find((address) => address.isPrimary) ?? addresses[0]!;
}

/**
 * Returns the address to apply with, or null when the candidate has none on file
 * (callers then fall back to the single address on candidate_profile).
 */
export function pickAddressForJob<T extends AddressLike>(
  addresses: T[],
  job: JobLocationInput,
): AddressChoice<T> | null {
  if (!addresses.length) return null;
  if (addresses.length === 1) {
    return {
      address: addresses[0]!,
      reason: "Only one address on file.",
      matchedTerm: null,
      score: 0,
    };
  }

  const normalized = normalizeLocationText(job.location ?? "");
  const scored = addresses.map((address) => ({
    address,
    ...scoreAddress(address, normalized),
  }));

  const best = scored.reduce((a, b) => (b.score > a.score ? b : a));
  const tied = scored.filter((item) => item.score === best.score);

  if (best.score === 0 || tied.length > 1) {
    const fallback = primaryOf(addresses);
    const why =
      best.score === 0
        ? job.remoteType === "remote" || !job.location
          ? "Posting has no specific location, so the primary address was used."
          : `Posting location "${job.location}" matched no address, so the primary address was used.`
        : `Posting location "${job.location}" matched more than one address equally, so the primary address was used.`;
    return { address: fallback, reason: why, matchedTerm: null, score: best.score };
  }

  return {
    address: best.address,
    reason: `Posting location "${job.location}" matched "${best.matchedTerm}".`,
    matchedTerm: best.matchedTerm,
    score: best.score,
  };
}
