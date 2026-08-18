// Ported from BroswerExtension/src/lib/questionNormalizer.ts — keep byte-identical aside from this provenance line.
const SYNONYMS: Array<[RegExp, string]> = [
  [/\bc\s*#|\bc\s*[-.]?\s*sharp\b/gi, "csharp"],
  [/\bdot\s*net\b|\.net\b/gi, "dotnet"],
  [/\blinked\s*in\b/gi, "linkedin"],
  [/\bgit\s*hub\b/gi, "github"],
  [/\be[-\s]?mail\b/gi, "email"],
  [/\btelephone\b|\bmobile\b|\bcell(?: phone)?\b/gi, "phone"],
  [/\bpostal code\b|\bpostcode\b|\bzip code\b/gi, "zip"],
  [/\bcompensation\b|\bpay range\b/gi, "salary"],
  [/\bvisa\b|\bh[-\s]?1b\b|\bwork permit\b/gi, "sponsorship"],
  [/\bauthorised\b/gi, "authorized"],
  [/\bwillingness to relocate\b/gi, "willing to relocate"],
  [/\bcurriculum vitae\b|\bcv\b/gi, "resume"]
];

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "can",
  "do",
  "does",
  "for",
  "have",
  "i",
  "in",
  "is",
  "of",
  "on",
  "or",
  "please",
  "the",
  "to",
  "what",
  "will",
  "you",
  "your"
]);

function canonicalRule(text: string): string | undefined {
  if (/\b(sponsorship|sponsor)\b/.test(text)) return "sponsorship required";
  if (/\b(authorized|authorization|eligible)\b.*\bwork\b|\bwork\b.*\b(authorized|authorization|eligible)\b/.test(text)) {
    return "work authorization";
  }
  // "email notifications" / marketing opt-in must not collapse to the contact-email key.
  if (
    /\bemail\b/.test(text) &&
    !/\b(notification|opt.?in|marketing|subscribe)\b/.test(text)
  ) {
    return "email";
  }
  if (/\b(phone|telephone|mobile)\b/.test(text)) return "phone";
  if (/\blinkedin\b/.test(text)) return "linkedin";
  if (/\bgithub\b/.test(text)) return "github";
  if (/\bresume\b/.test(text)) return "resume upload";
  if (/\byears?\b.*\bcsharp\b|\bcsharp\b.*\byears?\b/.test(text)) {
    return "years csharp";
  }
  if (/\byears?\b.*\bdotnet\b|\bdotnet\b.*\byears?\b/.test(text)) {
    return "years dotnet";
  }
  if (/\byears?\b.*\bsql\b|\bsql\b.*\byears?\b/.test(text)) return "years sql";
  if (/\byears?\b.*\boracle\b|\boracle\b.*\byears?\b/.test(text)) {
    return "years oracle";
  }
  if (/\byears?\b.*\bazure\b|\bazure\b.*\byears?\b/.test(text)) {
    return "years azure";
  }
  return undefined;
}

export function normalizeQuestion(input: string): string {
  let value = input.normalize("NFKC").toLowerCase().trim();
  for (const [pattern, replacement] of SYNONYMS) {
    value = value.replace(pattern, replacement);
  }
  value = value
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const canonical = canonicalRule(value);
  if (canonical) return canonical;

  const seen = new Set<string>();
  return value
    .split(" ")
    .filter((word) => {
      if (!word || STOP_WORDS.has(word) || seen.has(word)) return false;
      seen.add(word);
      return true;
    })
    .join(" ");
}

export function tokenizeQuestion(input: string): Set<string> {
  return new Set(normalizeQuestion(input).split(" ").filter(Boolean));
}

export function questionSimilarity(left: string, right: string): number {
  const a = tokenizeQuestion(left);
  const b = tokenizeQuestion(right);
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  const union = new Set([...a, ...b]).size;
  return intersection / union;
}
