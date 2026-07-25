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
]);

export const followupStatusEnum = pgEnum("followup_status", [
  "pending",
  "completed",
  "skipped",
]);

export const commandTypeEnum = pgEnum("command_type", [
  "run_job_search",
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
    storagePath: text("storage_path").notNull(),
    notes: text("notes"),
    isDefault: boolean("is_default").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("resume_versions_user_idx").on(table.userId)],
);

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
    resumeVersionId: uuid("resume_version_id").references(
      () => resumeVersions.id,
      { onDelete: "set null" },
    ),
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
  resumes: many(resumeVersions),
  commonAnswers: many(commonAnswers),
  applications: many(applications),
}));

export const jobsRelations = relations(jobs, ({ many }) => ({
  applications: many(applications),
  reviews: many(jobReviews),
  followups: many(followups),
}));

export const commandsRelations = relations(commands, ({ many }) => ({
  events: many(commandEvents),
}));

export type Job = typeof jobs.$inferSelect;
export type Command = typeof commands.$inferSelect;
