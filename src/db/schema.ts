import { relations, sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

export const jobStatusEnum = pgEnum("job_status", [
  "new",
  "needs_review",
  "reviewing",
  "ready_to_apply",
  "applied",
  "interview",
  "offer",
  "rejected",
  "archived",
]);

export const priorityEnum = pgEnum("priority", [
  "low",
  "normal",
  "high",
  "urgent",
]);

export const applicationStatusEnum = pgEnum("application_status", [
  "draft",
  "ready",
  "applied",
  "screening",
  "interview",
  "offer",
  "rejected",
  "withdrawn",
  "filling",
  "awaiting_answer",
  "submitting",
  "submission_unknown",
  "needs_manual",
  "blocked",
  "failed",
]);

export const followupStatusEnum = pgEnum("followup_status", [
  "pending",
  "completed",
  "skipped",
]);

export const commandTypeEnum = pgEnum("command_type", [
  "find_matching_jobs",
  "run_job_search",
  "discover_jobs_browser",
  "import_jobs",
  "run_rule_filter",
  "run_local_llm_extraction",
  "review_top_jobs",
  "review_job",
  "draft_answer",
  "trigger_n8n_summary",
  "sync_n8n_email_events",
  "mark_application_status",
  "reprocess_job",
  "run_apply_cycle",
  "apply_to_jobs",
  "verify_submission",
  "sync_resume_text",
]);

export const commandSourceEnum = pgEnum("command_source", [
  "dashboard",
  "hermes",
  "worker",
  "n8n",
  "system",
]);

export const commandStatusEnum = pgEnum("command_status", [
  "pending",
  "claimed",
  "completed",
  "failed",
  "canceled",
]);

export const reviewerTypeEnum = pgEnum("reviewer_type", [
  "manual",
  "rule_engine",
  "local_llm",
  "codex",
]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull(),
    name: text("name"),
    authProviderId: text("auth_provider_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("users_email_unique").on(table.email),
    uniqueIndex("users_auth_provider_id_unique").on(table.authProviderId),
  ],
);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    title: text("title").notNull(),
    company: text("company").notNull(),
    location: text("location"),
    source: text("source").notNull(),
    sourceUrl: text("source_url").notNull(),
    postedDate: date("posted_date", { mode: "date" }),
    description: text("description").notNull(),
    salaryText: text("salary_text"),
    employmentType: text("employment_type"),
    remoteType: text("remote_type"),
    status: jobStatusEnum("status").default("new").notNull(),
    fitScore: integer("fit_score"),
    priority: priorityEnum("priority").default("normal").notNull(),
    visaSignal: text("visa_signal").default("unknown").notNull(),
    techStack: text("tech_stack")
      .array()
      .default(sql`ARRAY[]::text[]`)
      .notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("jobs_status_idx").on(table.status),
    index("jobs_source_idx").on(table.source),
    index("jobs_fit_score_idx").on(table.fitScore),
    index("jobs_company_idx").on(table.company),
    uniqueIndex("jobs_source_url_unique").on(table.sourceUrl),
  ],
);

export const candidateProfiles = pgTable(
  "candidate_profile",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    targetTitles: text("target_titles")
      .array()
      .default(sql`ARRAY[]::text[]`)
      .notNull(),
    targetLocations: text("target_locations")
      .array()
      .default(sql`ARRAY[]::text[]`)
      .notNull(),
    workAuthorizationAnswer: text("work_authorization_answer"),
    sponsorshipAnswer: text("sponsorship_answer"),
    salaryExpectation: text("salary_expectation"),
    linkedinUrl: text("linkedin_url"),
    githubUrl: text("github_url"),
    portfolioUrl: text("portfolio_url"),
    summary: text("summary"),
    skills: text("skills")
      .array()
      .default(sql`ARRAY[]::text[]`)
      .notNull(),
    preferredEmploymentTypes: text("preferred_employment_types")
      .array()
      .default(sql`ARRAY[]::text[]`)
      .notNull(),
    dealBreakers: text("deal_breakers")
      .array()
      .default(sql`ARRAY[]::text[]`)
      .notNull(),
    matchingInstructions: text("matching_instructions"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    phone: text("phone"),
    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    city: text("city"),
    stateRegion: text("state_region"),
    postalCode: text("postal_code"),
    country: text("country").default("United States"),
    currentCompany: text("current_company"),
    currentTitle: text("current_title"),
    yearsTotalExperience: integer("years_total_experience"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [uniqueIndex("candidate_profile_user_unique").on(table.userId)],
);

export const resumeVersions = pgTable(
  "resume_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Absolute path in the JobAgent local resume store on the worker machine.
    storagePath: text("storage_path"),
    originalFilename: text("original_filename"),
    mimeType: text("mime_type"),
    sizeBytes: integer("size_bytes"),
    sha256: text("sha256"),
    resumeText: text("resume_text"),
    resumeTextChars: integer("resume_text_chars"),
    textExtractedAt: timestamp("text_extracted_at", { withTimezone: true }),
    extractionError: text("extraction_error"),
    supersededBy: uuid("superseded_by").references(
      (): AnyPgColumn => resumeVersions.id,
      { onDelete: "set null" },
    ),
    notes: text("notes"),
    isDefault: boolean("is_default").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("resume_versions_user_idx").on(table.userId),
    uniqueIndex("resume_versions_user_sha256_unique").on(
      table.userId,
      table.sha256,
    ),
  ],
);

/**
 * Structured facts derived from a resume (or corrected by hand) so both matching and
 * form filling read the same numbers instead of re-reading the resume blob.
 * `factKey` is a formfill FieldCategory, which is what lets a fact answer a form field
 * directly without any extra mapping layer.
 */
export const candidateFacts = pgTable(
  "candidate_facts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Provenance: which resume this was read from. Null once a human edits the value.
    resumeVersionId: uuid("resume_version_id").references(
      () => resumeVersions.id,
      { onDelete: "set null" },
    ),
    factKey: text("fact_key").notNull(),
    factValue: text("fact_value").notNull(),
    /** 0-100. Extraction only auto-fills at or above FACT_MIN_CONFIDENCE. */
    confidence: integer("confidence").default(0).notNull(),
    /** Short quote from the resume supporting the value, for review. */
    evidence: text("evidence").default("").notNull(),
    source: text("source").default("resume").notNull(),
    /** Set when a human confirms or edits. Extraction never overwrites a verified fact. */
    verified: boolean("verified").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("candidate_facts_user_key_unique").on(table.userId, table.factKey),
    index("candidate_facts_user_idx").on(table.userId),
  ],
);

export const targetRoles = pgTable(
  "target_roles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    locations: text("locations")
      .array()
      .default(sql`ARRAY[]::text[]`)
      .notNull(),
    resumeVersionId: uuid("resume_version_id")
      .notNull()
      .references(() => resumeVersions.id, { onDelete: "restrict" }),
    active: boolean("active").default(true).notNull(),
    maxApplicationsPerRun: integer("max_applications_per_run"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("target_roles_user_title_unique").on(table.userId, table.title),
    index("target_roles_user_active_idx").on(table.userId, table.active),
  ],
);

export const automationSettings = pgTable("automation_settings", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  applyPaused: boolean("apply_paused").default(false).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const commonAnswers = pgTable(
  "common_answers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    questionKey: text("question_key").notNull(),
    questionText: text("question_text").notNull(),
    answerText: text("answer_text").notNull(),
    category: text("category").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("common_answers_user_question_unique").on(
      table.userId,
      table.questionKey,
    ),
  ],
);

export const jobRoleMatches = pgTable(
  "job_role_matches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    targetRoleId: uuid("target_role_id")
      .notNull()
      .references(() => targetRoles.id, { onDelete: "cascade" }),
    resumeVersionId: uuid("resume_version_id").references(
      () => resumeVersions.id,
      { onDelete: "restrict" },
    ),
    status: text("status").notNull(),
    score: integer("score"),
    evidenceJson: jsonb("evidence_json").$type<Record<string, unknown>>(),
    reasons: text("reasons")
      .array()
      .default(sql`ARRAY[]::text[]`)
      .notNull(),
    candidateFingerprint: text("candidate_fingerprint"),
    jobFingerprint: text("job_fingerprint"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("job_role_matches_user_job_role_unique").on(
      table.userId,
      table.jobId,
      table.targetRoleId,
    ),
    index("job_role_matches_user_status_score_idx").on(
      table.userId,
      table.status,
      table.score.desc(),
    ),
  ],
);

export const applications = pgTable(
  "applications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: applicationStatusEnum("status").default("draft").notNull(),
    targetRoleId: uuid("target_role_id").references(() => targetRoles.id, {
      onDelete: "set null",
    }),
    jobRoleMatchId: uuid("job_role_match_id").references(
      () => jobRoleMatches.id,
      { onDelete: "set null" },
    ),
    resumeVersionId: uuid("resume_version_id").references(
      () => resumeVersions.id,
      { onDelete: "set null" },
    ),
    applyUrl: text("apply_url"),
    stopReason: text("stop_reason"),
    confirmationEvidence: jsonb("confirmation_evidence").$type<
      Record<string, unknown>
    >(),
    workerCommandId: uuid("worker_command_id"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    followupAt: timestamp("followup_at", { withTimezone: true }),
    recruiterName: text("recruiter_name"),
    recruiterEmail: text("recruiter_email"),
    applicationNotes: text("application_notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("applications_user_idx").on(table.userId),
    index("applications_job_idx").on(table.jobId),
    index("applications_status_idx").on(table.status),
    uniqueIndex("applications_job_user_unique").on(table.jobId, table.userId),
  ],
);

export const applicationAnswers = pgTable(
  "application_answers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scope: text("scope").default("global").notNull(),
    scopeKey: text("scope_key").default("").notNull(),
    normalizedQuestion: text("normalized_question").notNull(),
    originalQuestion: text("original_question").notNull(),
    category: text("category").notNull(),
    answerValue: text("answer_value").notNull(),
    answerType: text("answer_type").notNull(),
    optionValue: text("option_value"),
    sitePattern: text("site_pattern").default(""),
    domain: text("domain").default(""),
    aliases: text("aliases")
      .array()
      .default(sql`ARRAY[]::text[]`)
      .notNull(),
    riskLevel: text("risk_level").default("MEDIUM").notNull(),
    source: text("source").default("user_reply").notNull(),
    usageCount: integer("usage_count").default(0).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    notes: text("notes").default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("application_answers_user_scope_question_unique").on(
      table.userId,
      table.scope,
      table.scopeKey,
      table.normalizedQuestion,
      table.category,
    ),
    index("application_answers_user_category_idx").on(
      table.userId,
      table.category,
    ),
    index("application_answers_user_scope_idx").on(
      table.userId,
      table.scope,
      table.scopeKey,
    ),
  ],
);

export const jobReviews = pgTable(
  "job_reviews",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    reviewerType: reviewerTypeEnum("reviewer_type").notNull(),
    score: integer("score"),
    recommendation: text("recommendation"),
    strengths: text("strengths")
      .array()
      .default(sql`ARRAY[]::text[]`)
      .notNull(),
    gaps: text("gaps")
      .array()
      .default(sql`ARRAY[]::text[]`)
      .notNull(),
    visaNotes: text("visa_notes"),
    resumeAngle: text("resume_angle"),
    rawOutput: jsonb("raw_output").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("job_reviews_job_idx").on(table.jobId)],
);

export const followups = pgTable(
  "followups",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    applicationId: uuid("application_id").references(() => applications.id, {
      onDelete: "cascade",
    }),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    status: followupStatusEnum("status").default("pending").notNull(),
    messageTemplate: text("message_template"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("followups_due_idx").on(table.dueAt),
    index("followups_status_idx").on(table.status),
  ],
);

export const commands = pgTable(
  "commands",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    parentCommandId: uuid("parent_command_id").references(
      (): AnyPgColumn => commands.id,
      { onDelete: "set null" },
    ),
    type: commandTypeEnum("type").notNull(),
    source: commandSourceEnum("source").notNull(),
    requestedBy: text("requested_by").notNull(),
    payloadJson: jsonb("payload_json")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    status: commandStatusEnum("status").default("pending").notNull(),
    priority: priorityEnum("priority").default("normal").notNull(),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true })
      .defaultNow()
      .notNull(),
    claimedBy: text("claimed_by"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    resultJson: jsonb("result_json").$type<Record<string, unknown>>(),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("commands_queue_idx").on(
      table.status,
      table.scheduledFor,
      table.priority,
    ),
    index("commands_type_idx").on(table.type),
    index("commands_parent_idx").on(table.parentCommandId),
  ],
);

export const pendingQuestions = pgTable(
  "pending_questions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    shortId: text("short_id").notNull(),
    commandId: uuid("command_id")
      .notNull()
      .references(() => commands.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    applicationId: uuid("application_id").references(() => applications.id, {
      onDelete: "set null",
    }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    fieldId: text("field_id"),
    fieldSelector: text("field_selector"),
    questionText: text("question_text").notNull(),
    normalizedQuestion: text("normalized_question").notNull(),
    category: text("category").notNull(),
    answerType: text("answer_type").notNull(),
    optionsJson: jsonb("options_json")
      .$type<unknown[]>()
      .default([])
      .notNull(),
    required: boolean("required").default(false).notNull(),
    riskLevel: text("risk_level").default("HIGH").notNull(),
    status: text("status").default("open").notNull(),
    channel: text("channel").default("dashboard").notNull(),
    channelMessageId: text("channel_message_id"),
    answerValue: text("answer_value"),
    answeredBy: text("answered_by"),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    contextJson: jsonb("context_json")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("pending_questions_short_id_unique").on(table.shortId),
    index("pending_questions_user_status_idx").on(table.userId, table.status),
    index("pending_questions_command_idx").on(table.commandId),
  ],
);

export const commandEvents = pgTable(
  "command_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    commandId: uuid("command_id")
      .notNull()
      .references(() => commands.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    message: text("message").notNull(),
    metadataJson: jsonb("metadata_json").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("command_events_command_idx").on(table.commandId)],
);

export const integrationEvents = pgTable(
  "integration_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    source: text("source").notNull(),
    eventType: text("event_type").notNull(),
    payloadJson: jsonb("payload_json")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    processed: boolean("processed").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("integration_events_source_idx").on(table.source),
    index("integration_events_processed_idx").on(table.processed),
  ],
);

export const usersRelations = relations(users, ({ one, many }) => ({
  candidateProfile: one(candidateProfiles),
  automationSettings: one(automationSettings),
  resumes: many(resumeVersions),
  candidateFacts: many(candidateFacts),
  commonAnswers: many(commonAnswers),
  applications: many(applications),
  targetRoles: many(targetRoles),
  applicationAnswers: many(applicationAnswers),
  pendingQuestions: many(pendingQuestions),
  jobRoleMatches: many(jobRoleMatches),
}));

export const jobsRelations = relations(jobs, ({ many }) => ({
  applications: many(applications),
  reviews: many(jobReviews),
  followups: many(followups),
  jobRoleMatches: many(jobRoleMatches),
  pendingQuestions: many(pendingQuestions),
}));

export const resumeVersionsRelations = relations(
  resumeVersions,
  ({ one, many }) => ({
    user: one(users, {
      fields: [resumeVersions.userId],
      references: [users.id],
    }),
    supersededByResume: one(resumeVersions, {
      fields: [resumeVersions.supersededBy],
      references: [resumeVersions.id],
      relationName: "resume_superseded",
    }),
    targetRoles: many(targetRoles),
  }),
);

export const targetRolesRelations = relations(targetRoles, ({ one, many }) => ({
  user: one(users, {
    fields: [targetRoles.userId],
    references: [users.id],
  }),
  resumeVersion: one(resumeVersions, {
    fields: [targetRoles.resumeVersionId],
    references: [resumeVersions.id],
  }),
  jobRoleMatches: many(jobRoleMatches),
  applications: many(applications),
}));

export const jobRoleMatchesRelations = relations(
  jobRoleMatches,
  ({ one }) => ({
    user: one(users, {
      fields: [jobRoleMatches.userId],
      references: [users.id],
    }),
    job: one(jobs, {
      fields: [jobRoleMatches.jobId],
      references: [jobs.id],
    }),
    targetRole: one(targetRoles, {
      fields: [jobRoleMatches.targetRoleId],
      references: [targetRoles.id],
    }),
    resumeVersion: one(resumeVersions, {
      fields: [jobRoleMatches.resumeVersionId],
      references: [resumeVersions.id],
    }),
  }),
);

export const applicationsRelations = relations(applications, ({ one }) => ({
  job: one(jobs, {
    fields: [applications.jobId],
    references: [jobs.id],
  }),
  user: one(users, {
    fields: [applications.userId],
    references: [users.id],
  }),
  targetRole: one(targetRoles, {
    fields: [applications.targetRoleId],
    references: [targetRoles.id],
  }),
  jobRoleMatch: one(jobRoleMatches, {
    fields: [applications.jobRoleMatchId],
    references: [jobRoleMatches.id],
  }),
  resumeVersion: one(resumeVersions, {
    fields: [applications.resumeVersionId],
    references: [resumeVersions.id],
  }),
}));

export const commandsRelations = relations(commands, ({ one, many }) => ({
  parent: one(commands, {
    fields: [commands.parentCommandId],
    references: [commands.id],
    relationName: "command_parent",
  }),
  children: many(commands, { relationName: "command_parent" }),
  events: many(commandEvents),
  pendingQuestions: many(pendingQuestions),
}));

export const candidateFactsRelations = relations(candidateFacts, ({ one }) => ({
  user: one(users, {
    fields: [candidateFacts.userId],
    references: [users.id],
  }),
  resumeVersion: one(resumeVersions, {
    fields: [candidateFacts.resumeVersionId],
    references: [resumeVersions.id],
  }),
}));

export type Job = typeof jobs.$inferSelect;
export type CandidateFact = typeof candidateFacts.$inferSelect;
export type Command = typeof commands.$inferSelect;
export type TargetRole = typeof targetRoles.$inferSelect;
export type JobRoleMatch = typeof jobRoleMatches.$inferSelect;
export type ApplicationAnswer = typeof applicationAnswers.$inferSelect;
export type PendingQuestion = typeof pendingQuestions.$inferSelect;
