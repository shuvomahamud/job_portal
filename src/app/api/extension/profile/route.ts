import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  candidateProfiles,
  commonAnswers,
  resumeVersions,
} from "@/db/schema";
import { ApiError, handleApi, jsonOk } from "@/lib/api";
import { requireScopedSecret } from "@/lib/security";

export async function GET(request: Request) {
  return handleApi(async () => {
    requireScopedSecret(request, "EXTENSION_API_SECRET");
    const db = getDb();
    const [profile] = await db
      .select()
      .from(candidateProfiles)
      .orderBy(desc(candidateProfiles.updatedAt))
      .limit(1);
    if (!profile) {
      throw new ApiError(404, "NOT_FOUND", "Candidate profile not found.");
    }

    const [answers, resumes] = await Promise.all([
      db
        .select({
          questionKey: commonAnswers.questionKey,
          questionText: commonAnswers.questionText,
          answerText: commonAnswers.answerText,
          category: commonAnswers.category,
        })
        .from(commonAnswers)
        .where(eq(commonAnswers.userId, profile.userId)),
      db
        .select({
          id: resumeVersions.id,
          name: resumeVersions.name,
          storagePath: resumeVersions.storagePath,
          notes: resumeVersions.notes,
          isDefault: resumeVersions.isDefault,
        })
        .from(resumeVersions)
        .where(eq(resumeVersions.userId, profile.userId)),
    ]);

    return jsonOk({
      profile: {
        targetTitles: profile.targetTitles,
        targetLocations: profile.targetLocations,
        workAuthorizationAnswer: profile.workAuthorizationAnswer,
        sponsorshipAnswer: profile.sponsorshipAnswer,
        salaryExpectation: profile.salaryExpectation,
        linkedinUrl: profile.linkedinUrl,
        githubUrl: profile.githubUrl,
        portfolioUrl: profile.portfolioUrl,
        summary: profile.summary,
      },
      commonAnswers: answers,
      resumeVersions: resumes,
    });
  });
}
