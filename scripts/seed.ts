import { config } from "dotenv";
import type { z } from "zod";

config({ path: ".env.local" });
config();

import { eq } from "drizzle-orm";
import { getDb } from "../src/db/connection";
import {
  applications,
  candidateProfiles,
  commandEvents,
  commands,
  commonAnswers,
  followups,
  jobReviews,
  jobs,
  resumeVersions,
  users,
} from "../src/db/schema";
import {
  commandCreateSchema,
  jobImportSchema,
  validateCommandPayload,
} from "../src/lib/validation";

const ids = {
  user: "10000000-0000-4000-8000-000000000001",
  profile: "10000000-0000-4000-8000-000000000002",
  resume: "10000000-0000-4000-8000-000000000003",
  jobs: [
    "20000000-0000-4000-8000-000000000001",
    "20000000-0000-4000-8000-000000000002",
    "20000000-0000-4000-8000-000000000003",
    "20000000-0000-4000-8000-000000000004",
    "20000000-0000-4000-8000-000000000005",
  ],
  application: "30000000-0000-4000-8000-000000000001",
  followup: "30000000-0000-4000-8000-000000000002",
  review: "30000000-0000-4000-8000-000000000003",
  commands: [
    "40000000-0000-4000-8000-000000000001",
    "40000000-0000-4000-8000-000000000002",
    "40000000-0000-4000-8000-000000000003",
  ],
  commandEvents: [
    "50000000-0000-4000-8000-000000000001",
    "50000000-0000-4000-8000-000000000002",
    "50000000-0000-4000-8000-000000000003",
  ],
} as const;

const now = new Date();
const day = 86_400_000;

const sampleJobs: z.infer<typeof jobImportSchema>[] = [
  {
    title: "Senior Product Engineer",
    company: "Northstar Health",
    location: "New York, NY · Hybrid",
    source: "linkedin",
    sourceUrl: "https://example.com/jobs/northstar-product-engineer",
    postedDate: new Date(now.getTime() - day),
    description:
      "Build patient-facing product systems with TypeScript, React, Node.js, and PostgreSQL. Partner closely with design and operations to ship reliable workflows.",
    salaryText: "$165,000–$195,000",
    employmentType: "Full-time",
    remoteType: "Hybrid",
    status: "ready_to_apply",
    fitScore: 91,
    priority: "high",
    visaSignal: "needs_review",
    techStack: ["TypeScript", "React", "Node.js", "PostgreSQL"],
    notes: "Strong product scope and direct ownership.",
  },
  {
    title: "Staff Software Engineer, Platform",
    company: "Fable Cloud",
    location: "Remote · United States",
    source: "company_site",
    sourceUrl: "https://example.com/jobs/fable-staff-platform",
    postedDate: new Date(now.getTime() - day * 2),
    description:
      "Lead platform architecture for a multi-tenant SaaS product. Improve developer velocity, observability, and data reliability across distributed systems.",
    salaryText: "$190,000–$225,000",
    employmentType: "Full-time",
    remoteType: "Remote",
    status: "applied",
    fitScore: 86,
    priority: "high",
    visaSignal: "positive",
    techStack: ["Go", "TypeScript", "Kubernetes", "PostgreSQL"],
    notes: "Application submitted with platform resume.",
  },
  {
    title: "Senior Full-Stack Engineer",
    company: "Harbor Finance",
    location: "Boston, MA · Remote friendly",
    source: "indeed",
    sourceUrl: "https://example.com/jobs/harbor-fullstack",
    postedDate: new Date(now.getTime() - day * 3),
    description:
      "Own customer onboarding and internal risk tooling. The team uses Next.js, Python services, Postgres, and pragmatic event-driven patterns.",
    salaryText: "$155,000–$185,000",
    employmentType: "Full-time",
    remoteType: "Remote friendly",
    status: "needs_review",
    fitScore: 79,
    priority: "normal",
    visaSignal: "unknown",
    techStack: ["Next.js", "Python", "PostgreSQL"],
    notes: null,
  },
  {
    title: "Founding Backend Engineer",
    company: "Morrow AI",
    location: "Brooklyn, NY · On-site",
    source: "dice",
    sourceUrl: "https://example.com/jobs/morrow-backend",
    postedDate: new Date(now.getTime() - day * 4),
    description:
      "Design APIs and data systems for an early-stage applied AI platform. Build reliable queues, ingestion pipelines, and evaluation infrastructure.",
    salaryText: "$170,000–$210,000 + equity",
    employmentType: "Full-time",
    remoteType: "On-site",
    status: "new",
    fitScore: 74,
    priority: "normal",
    visaSignal: "negative",
    techStack: ["Python", "FastAPI", "PostgreSQL", "Redis"],
    notes: "Check commute and sponsorship constraints.",
  },
  {
    title: "Engineering Manager, Growth",
    company: "Parcel Works",
    location: "Remote · EST hours",
    source: "referral",
    sourceUrl: "https://example.com/jobs/parcel-growth-manager",
    postedDate: new Date(now.getTime() - day * 5),
    description:
      "Manage a small full-stack team responsible for acquisition, activation, and experimentation. Balance technical direction with coaching and delivery.",
    salaryText: "$180,000–$205,000",
    employmentType: "Full-time",
    remoteType: "Remote",
    status: "archived",
    fitScore: 58,
    priority: "low",
    visaSignal: "unknown",
    techStack: ["React", "Ruby", "PostgreSQL"],
    notes: "Management-heavy relative to current target.",
  },
];

const sampleCommands = [
  {
    id: ids.commands[0],
    type: "run_job_search",
    payloadJson: {
      sources: ["linkedin", "indeed"],
      queries: ["senior software engineer"],
      locations: ["New York", "Remote"],
      limit: 40,
    },
    status: "pending",
    priority: "high",
    resultJson: null,
    errorMessage: null,
  },
  {
    id: ids.commands[1],
    type: "review_job",
    payloadJson: {
      jobId: ids.jobs[0],
      reviewerType: "codex",
    },
    status: "completed",
    priority: "high",
    resultJson: { reviewId: ids.review, recommendation: "strong_match" },
    errorMessage: null,
  },
  {
    id: ids.commands[2],
    type: "trigger_n8n_summary",
    payloadJson: { period: "daily" },
    status: "failed",
    priority: "normal",
    resultJson: null,
    errorMessage: "n8n is not connected in Phase 1.",
  },
] as const;

function validateSeed() {
  sampleJobs.forEach((job) => jobImportSchema.parse(job));
  sampleCommands.forEach((command) => {
    const parsed = commandCreateSchema.parse({
      type: command.type,
      payloadJson: command.payloadJson,
      priority: command.priority,
    });
    validateCommandPayload(parsed.type, parsed.payloadJson);
  });
}

async function seed() {
  validateSeed();
  if (process.argv.includes("--dry-run")) {
    console.log(
      `Seed validation passed: ${sampleJobs.length} jobs, ${sampleCommands.length} commands.`,
    );
    return;
  }

  const db = getDb();
  const email = process.env.SEED_USER_EMAIL ?? "alex@example.com";
  const name = process.env.SEED_USER_NAME ?? "Alex Morgan";
  const authProviderId =
    process.env.SEED_USER_AUTH_PROVIDER_ID ?? "seed_user";

  await db
    .insert(users)
    .values({
      id: ids.user,
      email,
      name,
      authProviderId,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: { email, name, authProviderId, updatedAt: now },
    });

  await db
    .insert(candidateProfiles)
    .values({
      id: ids.profile,
      userId: ids.user,
      targetTitles: [
        "Senior Software Engineer",
        "Staff Software Engineer",
        "Senior Product Engineer",
      ],
      targetLocations: ["New York", "Remote"],
      workAuthorizationAnswer:
        "I am authorized to work in the United States.",
      sponsorshipAnswer:
        "I do not require current or future employment sponsorship.",
      salaryExpectation:
        "Targeting $165,000–$200,000 base, depending on scope and total compensation.",
      linkedinUrl: "https://www.linkedin.com/in/example-candidate",
      githubUrl: "https://github.com/example-candidate",
      portfolioUrl: "https://example.dev",
      summary:
        "Product-minded software engineer with experience building reliable web platforms, workflow systems, and data-intensive applications.",
    })
    .onConflictDoUpdate({
      target: candidateProfiles.userId,
      set: {
        targetTitles: [
          "Senior Software Engineer",
          "Staff Software Engineer",
          "Senior Product Engineer",
        ],
        targetLocations: ["New York", "Remote"],
        updatedAt: now,
      },
    });

  await db
    .insert(resumeVersions)
    .values({
      id: ids.resume,
      userId: ids.user,
      name: "Product engineering · 2026",
      storagePath: "https://example.com/resumes/product-engineering.pdf",
      notes: "Default resume emphasizing product ownership and platform work.",
      isDefault: true,
    })
    .onConflictDoNothing();

  const answerRows = [
    {
      id: "11000000-0000-4000-8000-000000000001",
      userId: ids.user,
      questionKey: "work_authorization",
      questionText: "Are you authorized to work in the United States?",
      answerText: "Yes, I am authorized to work in the United States.",
      category: "eligibility",
    },
    {
      id: "11000000-0000-4000-8000-000000000002",
      userId: ids.user,
      questionKey: "sponsorship",
      questionText: "Will you now or in the future require sponsorship?",
      answerText:
        "No, I do not require current or future employment sponsorship.",
      category: "eligibility",
    },
    {
      id: "11000000-0000-4000-8000-000000000003",
      userId: ids.user,
      questionKey: "salary_expectation",
      questionText: "What are your salary expectations?",
      answerText:
        "I am targeting a base salary in the $165,000–$200,000 range, depending on the role scope and total compensation.",
      category: "compensation",
    },
  ];
  for (const answer of answerRows) {
    await db
      .insert(commonAnswers)
      .values(answer)
      .onConflictDoUpdate({
        target: [commonAnswers.userId, commonAnswers.questionKey],
        set: {
          questionText: answer.questionText,
          answerText: answer.answerText,
          category: answer.category,
          updatedAt: now,
        },
      });
  }

  for (let index = 0; index < sampleJobs.length; index += 1) {
    const job = sampleJobs[index];
    await db
      .insert(jobs)
      .values({ id: ids.jobs[index], ...job })
      .onConflictDoUpdate({
        target: jobs.id,
        set: { ...job, updatedAt: now },
      });
  }

  await db
    .insert(applications)
    .values({
      id: ids.application,
      jobId: ids.jobs[1],
      userId: ids.user,
      status: "applied",
      resumeVersionId: ids.resume,
      appliedAt: new Date(now.getTime() - day * 4),
      followupAt: new Date(now.getTime() - day),
      recruiterName: "Jamie Lee",
      recruiterEmail: "jamie.lee@example.com",
      applicationNotes: "Applied through the company site.",
    })
    .onConflictDoNothing();

  await db
    .insert(followups)
    .values({
      id: ids.followup,
      jobId: ids.jobs[1],
      applicationId: ids.application,
      dueAt: new Date(now.getTime() - day),
      status: "pending",
      messageTemplate:
        "Thank Jamie for the conversation and reaffirm interest in the platform scope.",
      notes: "Keep the note concise and mention developer experience.",
    })
    .onConflictDoUpdate({
      target: followups.id,
      set: { dueAt: new Date(now.getTime() - day), updatedAt: now },
    });

  await db
    .insert(jobReviews)
    .values({
      id: ids.review,
      jobId: ids.jobs[0],
      reviewerType: "manual",
      score: 91,
      recommendation: "Prioritize and tailor the product engineering resume.",
      strengths: [
        "Direct TypeScript and React alignment",
        "Strong product ownership match",
        "Location matches target",
      ],
      gaps: ["Healthcare domain experience is not explicit"],
      visaNotes: "Confirm the employer policy before applying.",
      resumeAngle:
        "Lead with workflow systems, product partnership, and reliability.",
      rawOutput: { seeded: true },
    })
    .onConflictDoNothing();

  for (let index = 0; index < sampleCommands.length; index += 1) {
    const command = sampleCommands[index];
    await db
      .insert(commands)
      .values({
        ...command,
        source: index === 0 ? "hermes" : "dashboard",
        requestedBy: index === 0 ? "hermes" : ids.user,
        scheduledFor: new Date(now.getTime() - index * 60_000),
        claimedBy: command.status === "completed" ? "seed-worker-1" : null,
        claimedAt:
          command.status === "completed"
            ? new Date(now.getTime() - 120_000)
            : null,
        completedAt:
          command.status === "completed" || command.status === "failed"
            ? new Date(now.getTime() - 60_000)
            : null,
      })
      .onConflictDoUpdate({
        target: commands.id,
        set: {
          status: command.status,
          resultJson: command.resultJson,
          errorMessage: command.errorMessage,
          updatedAt: now,
        },
      });

    await db
      .insert(commandEvents)
      .values({
        id: ids.commandEvents[index],
        commandId: command.id,
        eventType:
          command.status === "pending" ? "created" : command.status,
        message: `Seed command is ${command.status}.`,
        metadataJson: { seeded: true },
      })
      .onConflictDoNothing();
  }

  const [jobCount] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(eq(jobs.id, ids.jobs[0]))
    .limit(1);
  console.log(
    jobCount
      ? "Seed complete: profile, answers, 5 jobs, commands, and follow-up are ready."
      : "Seed completed without confirming sample rows.",
  );
}

seed().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
