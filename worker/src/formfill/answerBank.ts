import { and, eq, inArray, sql } from "drizzle-orm";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as schema from "../../../src/db/schema";
import { getWorkerDb } from "../db";
import { factIsUsable, factLabel, isFactKey } from "../../../src/lib/candidateFacts";
import {
  pickAddressForJob,
  type AddressLike,
  type JobLocationInput,
} from "../../../src/lib/addressPolicy";
import { normalizeQuestion } from "./questionNormalizer";
import { getRiskLevel } from "./riskPolicy";
import { FIELD_CATEGORIES, type DetectedField, type FieldCategory, type SavedAnswer } from "./types";

export type AnswerScope = "global" | "company" | "job";

type AnswerDb = NeonHttpDatabase<typeof schema>;

function dbOrDefault(database?: AnswerDb): AnswerDb {
  return database ?? getWorkerDb();
}

export type AnswerBankProfile = {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  addressLine1?: string | null;
  city?: string | null;
  stateRegion?: string | null;
  postalCode?: string | null;
  country?: string | null;
  linkedinUrl?: string | null;
  githubUrl?: string | null;
  portfolioUrl?: string | null;
};

export type CommonAnswerRow = {
  id: string;
  questionKey: string;
  questionText: string;
  answerText: string;
  category: string;
  createdAt: Date | string;
  updatedAt: Date | string;
};

const IDENTITY_CATEGORIES = new Set<FieldCategory>([
  "first_name",
  "last_name",
  "full_name",
  "email",
  "phone",
  "address",
  "city",
  "state",
  "zip",
  "country",
  "linkedin",
  "github",
  "portfolio",
]);

const FIELD_CATEGORY_SET = new Set<string>(FIELD_CATEGORIES);

function iso(value: Date | string | null | undefined): string {
  if (!value) return new Date(0).toISOString();
  return value instanceof Date ? value.toISOString() : value;
}

function rowToSavedAnswer(row: typeof schema.applicationAnswers.$inferSelect): SavedAnswer {
  return {
    id: row.id,
    normalizedQuestion: row.normalizedQuestion,
    originalQuestion: row.originalQuestion,
    category: (FIELD_CATEGORY_SET.has(row.category)
      ? row.category
      : "custom_short_answer") as FieldCategory,
    answerValue: row.answerValue,
    answerType: row.answerType as SavedAnswer["answerType"],
    optionValue: row.optionValue ?? undefined,
    sitePattern: row.sitePattern ?? "",
    domain: row.domain ?? "",
    usageCount: row.usageCount,
    lastUsedAt: row.lastUsedAt ? iso(row.lastUsedAt) : undefined,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    riskLevel: (row.riskLevel as SavedAnswer["riskLevel"]) || "MEDIUM",
    notes: row.notes ?? "",
    aliases: row.aliases ?? [],
  };
}

function profileEntry(
  category: FieldCategory,
  originalQuestion: string,
  answerValue: string | null | undefined,
): SavedAnswer | null {
  const value = answerValue?.trim();
  if (!value) return null;
  const normalizedQuestion = normalizeQuestion(originalQuestion);
  return {
    id: `profile:${category}`,
    normalizedQuestion,
    originalQuestion,
    category,
    answerValue: value,
    answerType: "text",
    sitePattern: "",
    domain: "",
    usageCount: 0,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    riskLevel: getRiskLevel(category),
    notes: "Derived from candidate profile.",
    aliases: [category.replace(/_/g, " ")],
  };
}

export type CandidateFactRow = {
  id: string;
  factKey: string;
  factValue: string;
  confidence: number;
  verified: boolean;
  createdAt: Date | string;
  updatedAt: Date | string;
};

/**
 * Turns stored resume facts into answer-bank entries. The fact key is already a
 * FieldCategory, so matchSavedAnswer's category rule resolves them with no extra mapping.
 *
 * A low-confidence unverified fact is withheld: it stays visible in the UI for review but
 * must not silently land in a real application. A user-verified fact always counts.
 */
export function factsToSavedAnswers(rows: CandidateFactRow[]): SavedAnswer[] {
  const answers: SavedAnswer[] = [];
  for (const row of rows) {
    // Only the allowlisted fact keys, never any field category. A sensitive category
    // reaching here would match exactly and satisfy applyPolicy's "exact saved answer"
    // branch, which is meant for answers a human actually gave.
    if (!isFactKey(row.factKey)) continue;
    const value = row.factValue.trim();
    if (!value) continue;
    if (!factIsUsable(row)) continue;

    const category = row.factKey as FieldCategory;
    const label = factLabel(row.factKey);
    answers.push({
      id: `fact:${row.id}`,
      normalizedQuestion: normalizeQuestion(label),
      originalQuestion: label,
      category,
      answerValue: value,
      answerType: "text",
      sitePattern: "",
      domain: "",
      usageCount: 0,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
      riskLevel: getRiskLevel(category),
      notes: row.verified
        ? "Confirmed candidate fact."
        : `Read from resume (confidence ${row.confidence}%).`,
      aliases: [row.factKey.replace(/_/g, " "), label.toLowerCase()],
    });
  }
  return answers;
}

/** Assemble bank in matchSavedAnswer precedence order (first hit wins). */
export function assembleAnswerBank(parts: {
  jobAnswers: SavedAnswer[];
  companyAnswers: SavedAnswer[];
  profileAnswers: SavedAnswer[];
  globalAnswers: SavedAnswer[];
  factAnswers: SavedAnswer[];
  commonAnswers: SavedAnswer[];
}): SavedAnswer[] {
  // Facts sit below anything the user typed or confirmed, above the legacy common answers:
  // a resume reading should never override an answer the user gave for this exact question.
  return [
    ...parts.jobAnswers,
    ...parts.companyAnswers,
    ...parts.profileAnswers,
    ...parts.globalAnswers,
    ...parts.factAnswers,
    ...parts.commonAnswers,
  ];
}

export function profileToSavedAnswers(profile: AnswerBankProfile): SavedAnswer[] {
  const fullName = [profile.firstName, profile.lastName].filter(Boolean).join(" ").trim();
  return [
    profileEntry("first_name", "First name", profile.firstName),
    profileEntry("last_name", "Last name", profile.lastName),
    profileEntry("full_name", "Full name", fullName || null),
    profileEntry("email", "Email", profile.email),
    profileEntry("phone", "Phone", profile.phone),
    profileEntry("address", "Address", profile.addressLine1),
    profileEntry("city", "City", profile.city),
    profileEntry("state", "State", profile.stateRegion),
    profileEntry("zip", "ZIP / postal code", profile.postalCode),
    profileEntry("country", "Country", profile.country),
    profileEntry("linkedin", "LinkedIn", profile.linkedinUrl),
    profileEntry("github", "GitHub", profile.githubUrl),
    profileEntry("portfolio", "Portfolio", profile.portfolioUrl),
  ].filter((entry): entry is SavedAnswer => entry !== null);
}

export type CandidateAddressRow = AddressLike & {
  line1: string;
  line2: string | null;
  postalCode: string;
  country: string;
};

/**
 * Address entries for whichever address is nearest the posting. Uses the same
 * `profile:` id prefix as the other identity fields so applyPolicy treats them
 * identically — this is a location-aware source for the same categories, not a new
 * kind of answer.
 */
export function addressToSavedAnswers(
  addresses: CandidateAddressRow[],
  job: JobLocationInput,
): { answers: SavedAnswer[]; reason: string | null; label: string | null } {
  const choice = pickAddressForJob(addresses, job);
  if (!choice) return { answers: [], reason: null, label: null };

  const address = choice.address;
  const street = [address.line1, address.line2].filter(Boolean).join(", ");
  const answers = [
    profileEntry("address", "Address", street),
    profileEntry("city", "City", address.city),
    profileEntry("state", "State", address.stateRegion),
    profileEntry("zip", "ZIP / postal code", address.postalCode),
    profileEntry("country", "Country", address.country),
  ].filter((entry): entry is SavedAnswer => entry !== null);

  return { answers, reason: choice.reason, label: address.label };
}

export function commonAnswerToSavedAnswer(row: CommonAnswerRow): SavedAnswer {
  const category = (FIELD_CATEGORY_SET.has(row.questionKey)
    ? row.questionKey
    : "custom_short_answer") as FieldCategory;
  return {
    id: `common:${row.id}`,
    normalizedQuestion: normalizeQuestion(row.questionText),
    originalQuestion: row.questionText,
    category,
    answerValue: row.answerText,
    answerType: "text",
    sitePattern: "",
    domain: "",
    usageCount: 0,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    riskLevel: getRiskLevel(category),
    notes: "Imported from common_answers.",
    aliases: [row.questionKey.replace(/_/g, " ")],
  };
}

export function chooseAnswerScope(
  field: DetectedField,
  company: string,
): { scope: AnswerScope; scopeKey: string } {
  const companyName = company.trim();
  const mentionsCompany =
    companyName.length > 0 &&
    field.labelText.toLowerCase().includes(companyName.toLowerCase());
  if (
    field.fieldCategory === "custom_long_answer" ||
    field.fieldCategory === "cover_letter" ||
    mentionsCompany
  ) {
    return { scope: "company", scopeKey: companyName.toLowerCase() || "unknown" };
  }
  return { scope: "global", scopeKey: "" };
}

export async function loadAnswerBank(
  input: {
    userId: string;
    jobId: string;
    company: string;
    domain: string;
    /** Posting location, used to choose the nearest address on file. */
    jobLocation?: string | null;
    remoteType?: string | null;
  },
  database?: AnswerDb,
): Promise<SavedAnswer[]> {
  return (await loadAnswerBankWithContext(input, database)).answers;
}

/** Same as loadAnswerBank, plus why a given address was chosen (for logs and artifacts). */
export async function loadAnswerBankWithContext(
  input: {
    userId: string;
    jobId: string;
    company: string;
    domain: string;
    jobLocation?: string | null;
    remoteType?: string | null;
  },
  database?: AnswerDb,
): Promise<{ answers: SavedAnswer[]; addressLabel: string | null; addressReason: string | null }> {
  const db = dbOrDefault(database);
  const companyKey = input.company.trim().toLowerCase();

  const [answerRows, commonRows, factRows, addressRows, profile, user] = await Promise.all([
    db
      .select()
      .from(schema.applicationAnswers)
      .where(eq(schema.applicationAnswers.userId, input.userId)),
    db
      .select()
      .from(schema.commonAnswers)
      .where(eq(schema.commonAnswers.userId, input.userId)),
    db
      .select()
      .from(schema.candidateFacts)
      .where(eq(schema.candidateFacts.userId, input.userId)),
    db
      .select()
      .from(schema.candidateAddresses)
      .where(eq(schema.candidateAddresses.userId, input.userId)),
    db
      .select()
      .from(schema.candidateProfiles)
      .where(eq(schema.candidateProfiles.userId, input.userId))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, input.userId))
      .limit(1)
      .then((rows) => rows[0] ?? null),
  ]);

  const jobAnswers = answerRows
    .filter((row) => row.scope === "job" && row.scopeKey === input.jobId)
    .map(rowToSavedAnswer);
  const companyAnswers = answerRows
    .filter((row) => row.scope === "company" && row.scopeKey === companyKey)
    .map(rowToSavedAnswer);
  const globalAnswers = answerRows
    .filter((row) => row.scope === "global")
    .map(rowToSavedAnswer);

  const address = addressToSavedAnswers(addressRows, {
    location: input.jobLocation,
    remoteType: input.remoteType,
  });
  const addressCategories = new Set(address.answers.map((answer) => answer.category));

  const profileAnswers = profileToSavedAnswers({
    ...(profile ?? {}),
    email: user?.email ?? null,
  })
    .filter((answer) => IDENTITY_CATEGORIES.has(answer.category))
    // A chosen address wins over the profile's single legacy address. When no addresses
    // are on file the profile still supplies them, so nothing regresses.
    .filter((answer) => !addressCategories.has(answer.category));

  const commonMapped = commonRows.map(commonAnswerToSavedAnswer);
  const factAnswers = factsToSavedAnswers(factRows);

  return {
    answers: assembleAnswerBank({
      jobAnswers,
      companyAnswers,
      profileAnswers: [...address.answers, ...profileAnswers],
      globalAnswers,
      factAnswers,
      commonAnswers: commonMapped,
    }),
    addressLabel: address.label,
    addressReason: address.reason,
  };
}

export async function learnAnswer(
  input: {
    userId: string;
    scope: AnswerScope;
    scopeKey: string;
    field: DetectedField;
    answerValue: string;
    domain: string;
    source: "user_reply" | "dashboard";
  },
  database?: AnswerDb,
): Promise<void> {
  const db = dbOrDefault(database);
  const now = new Date();
  const normalizedQuestion = input.field.normalizedQuestion || normalizeQuestion(input.field.labelText);
  const answerType =
    input.field.inputType === "textarea"
      ? "textarea"
      : input.field.inputType === "select"
        ? "select"
        : input.field.inputType === "radio"
          ? "radio"
          : input.field.inputType === "checkbox"
            ? "checkbox"
            : "text";

  const upsert = db
    .insert(schema.applicationAnswers)
    .values({
      userId: input.userId,
      scope: input.scope,
      scopeKey: input.scopeKey,
      normalizedQuestion,
      originalQuestion: input.field.labelText,
      category: input.field.fieldCategory,
      answerValue: input.answerValue,
      answerType,
      optionValue: input.field.options.length ? input.answerValue : null,
      sitePattern: "",
      domain: input.domain,
      aliases: [],
      riskLevel: input.field.riskLevel,
      source: input.source,
      usageCount: 0,
      notes: "",
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        schema.applicationAnswers.userId,
        schema.applicationAnswers.scope,
        schema.applicationAnswers.scopeKey,
        schema.applicationAnswers.normalizedQuestion,
        schema.applicationAnswers.category,
      ],
      set: {
        answerValue: input.answerValue,
        answerType,
        optionValue: input.field.options.length ? input.answerValue : null,
        originalQuestion: input.field.labelText,
        domain: input.domain,
        riskLevel: input.field.riskLevel,
        source: input.source,
        updatedAt: now,
      },
    });

  const markPending = db
    .update(schema.pendingQuestions)
    .set({
      status: "answered",
      answerValue: input.answerValue,
      answeredBy: input.source,
      answeredAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.pendingQuestions.userId, input.userId),
        eq(schema.pendingQuestions.normalizedQuestion, normalizedQuestion),
        eq(schema.pendingQuestions.category, input.field.fieldCategory),
        eq(schema.pendingQuestions.status, "open"),
      ),
    );

  await db.batch([upsert, markPending]);
}

export async function markAnswersUsed(ids: string[], database?: AnswerDb): Promise<void> {
  // Synthesized entries (profile, common, fact) have no application_answers row to count.
  const realIds = ids.filter(
    (id) => !id.startsWith("profile:") && !id.startsWith("common:") && !id.startsWith("fact:"),
  );
  if (!realIds.length) return;
  const db = dbOrDefault(database);
  const now = new Date();
  await db
    .update(schema.applicationAnswers)
    .set({
      usageCount: sql`${schema.applicationAnswers.usageCount} + 1`,
      lastUsedAt: now,
      updatedAt: now,
    })
    .where(inArray(schema.applicationAnswers.id, realIds));
}
