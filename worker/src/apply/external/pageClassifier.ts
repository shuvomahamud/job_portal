/**
 * What kind of page an employer's site has just put in front of us.
 *
 * On Indeed and Dice the flow is rehearsed, so the runner can assume it is looking at an
 * application form. An employer's own site can hand back anything: a login wall, an
 * account signup, a coding assessment, a confirmation page, or a form. Acting on the wrong
 * assumption is how an agent ends up typing a home address into a password field.
 *
 * Deliberately deterministic and checked before any model is consulted. These signals are
 * unambiguous and free, and a page confidently identified here costs nothing; only genuine
 * ambiguity is worth an inference call.
 */

export type PageKind =
  | "form"
  | "login"
  | "signup"
  | "assessment"
  | "confirmation"
  | "unknown";

export type PageSignals = {
  url: string;
  /** Visible page text, already collapsed to single spaces. */
  text: string;
  /** True when the page has a password input. */
  hasPasswordField: boolean;
  /** How many fillable fields the detector found. */
  fieldCount: number;
};

const CONFIRMATION =
  /application (?:has been )?(?:submitted|received)|thanks? (?:you )?for applying|we(?:'| ha)ve received your application|your application is complete/i;

const ASSESSMENT =
  /coding (?:challenge|assessment|test)|technical assessment|timed (?:test|assessment)|hackerrank|codility|karat|take-home|proctored/i;

/** Wording that means "make an account", as opposed to "sign in to one you have". */
const SIGNUP =
  /create (?:an )?account|sign up|register(?: now| an account)?|set (?:up )?(?:a )?password|confirm password/i;

const LOGIN =
  /sign in|log ?in|welcome back|forgot (?:your )?password|existing (?:user|account)/i;

const LOGIN_URL = /\/(?:login|signin|sign-in|auth|register|signup|sign-up)(?:[/?#]|$)/i;

/**
 * Classifies a page from signals alone, or returns "unknown" when they conflict.
 *
 * Order matters and encodes cost. Confirmation is checked first because mistaking a
 * finished application for a form would make the agent try to apply again. Assessment
 * comes next: it is the one kind no amount of form-filling can get past, so recognising it
 * early avoids wasting a browser on it.
 */
export function classifyPage(signals: PageSignals): PageKind {
  const { text, url, hasPasswordField, fieldCount } = signals;

  if (CONFIRMATION.test(text)) return "confirmation";
  if (ASSESSMENT.test(text)) return "assessment";

  // A password field is the only reliable divider between the two account pages, and the
  // difference matters: signing up needs a stored credential, signing in needs one we
  // already have. Text alone confuses them constantly — nearly every signup page also
  // links to "sign in".
  if (hasPasswordField) {
    // "Confirm password" only ever appears when creating a credential.
    if (SIGNUP.test(text)) return "signup";
    if (LOGIN.test(text)) return "login";
    return "signup";
  }

  // Without a password field, account wording in the URL still counts: some sites collect
  // an email first and ask for the password on the following step.
  if (LOGIN_URL.test(url)) {
    return SIGNUP.test(text) ? "signup" : "login";
  }

  if (fieldCount > 0) return "form";
  return "unknown";
}

/** True when the page needs a person and no amount of filling will move it along. */
export function needsHuman(kind: PageKind): boolean {
  return kind === "login" || kind === "signup" || kind === "assessment";
}
