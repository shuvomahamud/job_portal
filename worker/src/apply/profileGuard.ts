export type ApplyProfileFields = {
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  city: string | null;
  stateRegion: string | null;
  postalCode: string | null;
  country: string | null;
};

export function assertApplyProfileComplete(profile: ApplyProfileFields): void {
  const missing: string[] = [];
  if (!profile.firstName?.trim()) missing.push("first_name");
  if (!profile.lastName?.trim()) missing.push("last_name");
  if (!profile.phone?.trim()) missing.push("phone");
  if (!profile.city?.trim()) missing.push("city");
  if (!profile.stateRegion?.trim()) missing.push("state_region");
  if (!profile.postalCode?.trim()) missing.push("postal_code");
  if (!profile.country?.trim()) missing.push("country");
  if (missing.length) {
    throw new Error(
      `Apply profile incomplete; fill contact & identity fields first: ${missing.join(", ")}.`,
    );
  }
}

export function isApplyProfileComplete(profile: ApplyProfileFields): boolean {
  try {
    assertApplyProfileComplete(profile);
    return true;
  } catch {
    return false;
  }
}
