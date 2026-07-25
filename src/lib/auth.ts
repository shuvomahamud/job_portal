import "server-only";
import { auth, currentUser } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { ApiError } from "./api";

export async function requireDashboardUser() {
  const session = await auth();
  if (!session.userId) {
    throw new ApiError(401, "UNAUTHORIZED", "Dashboard login is required.");
  }

  const clerkUser = await currentUser();
  const email =
    clerkUser?.emailAddresses.find(
      (address) => address.id === clerkUser.primaryEmailAddressId,
    )?.emailAddress ??
    clerkUser?.emailAddresses[0]?.emailAddress ??
    null;

  if (!email) {
    throw new ApiError(
      403,
      "EMAIL_REQUIRED",
      "The signed-in account must have an email address.",
    );
  }

  const name =
    clerkUser?.fullName ??
    clerkUser?.firstName ??
    email.slice(0, email.indexOf("@"));
  const db = getDb();

  await db
    .insert(users)
    .values({
      email,
      name,
      authProviderId: session.userId,
    })
    .onConflictDoUpdate({
      target: users.authProviderId,
      set: { email, name, updatedAt: new Date() },
    });

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.authProviderId, session.userId))
    .limit(1);

  if (!user) {
    throw new ApiError(500, "USER_SYNC_FAILED", "Could not sync user record.");
  }

  return user;
}
