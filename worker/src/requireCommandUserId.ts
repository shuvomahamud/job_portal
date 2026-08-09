import { z } from "zod";

const userIdSchema = z.string().uuid();

/** Commands created by Hermes use requestedBy="hermes"; apply paths need a real users.id. */
export function requireCommandUserId(requestedBy: string): string {
  const parsed = userIdSchema.safeParse(requestedBy);
  if (!parsed.success) {
    throw new Error(
      `Command requestedBy must be a user UUID before writing applications; got "${requestedBy}".`,
    );
  }
  return parsed.data;
}
