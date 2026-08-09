import { and, eq, inArray, sql } from "drizzle-orm";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as schema from "../../../src/db/schema";
import { getWorkerDb } from "../db";
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

/** Assemble bank in matchSavedAnswer precedence order (first hit wins). */
export function assembleAnswerBank(parts: {
  jobAnswers: SavedAnswer[];
  companyAnswers: SavedAnswer[];
  profileAnswers: SavedAnswer[];
  globalAnswers: SavedAnswer[];
  commonAnswers: SavedAnswer[];
}): SavedAnswer[] {
  return [
    ...parts.jobAnswers,
    ...parts.companyAnswers,
    ...parts.profileAnswers,
    ...parts.globalAnswers,
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
  },
  database?: AnswerDb,
): Promise<SavedAnswer[]> {
  const db = dbOrDefault(database);
  const companyKey = input.company.trim().toLowerCase();

  const [answerRows, commonRows, profile, user] = await Promise.all([
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

  const profileAnswers = profileToSavedAnswers({
    ...(profile ?? {}),
    email: user?.email ?? null,
  }).filter((answer) => IDENTITY_CATEGORIES.has(answer.category));

  const commonMapped = commonRows.map(commonAnswerToSavedAnswer);

  return assembleAnswerBank({
    jobAnswers,
    companyAnswers,
    profileAnswers,
    globalAnswers,
    commonAnswers: commonMapped,
  });
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
  const realIds = ids.filter((id) => !id.startsWith("profile:") && !id.startsWith("common:"));
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
