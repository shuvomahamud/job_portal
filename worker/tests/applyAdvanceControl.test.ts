import assert from "node:assert/strict";
import test from "node:test";
import { adapterFor, looksLikeAlreadyApplied } from "../src/apply/applySteps";
import type { FrameLike, PageLike } from "../src/browser/playwrightTypes";

function fakeFrame(
  buttons: Array<{ name: string; ariaLabel?: string; visible?: boolean }>,
): FrameLike {
  return {
    getByRole: (_role: string, options?: { name?: RegExp | string }) => {
      const matcher = options?.name;
      const matched = buttons.filter((button) => {
        const accessible = button.ariaLabel ?? button.name;
        if (!matcher) return true;
        if (typeof matcher === "string") return accessible === matcher;
        return matcher.test(accessible);
      });
      return {
        count: async () => matched.length,
        nth: (index: number) => {
          const button = matched[index];
          return {
            isVisible: async () => button?.visible ?? true,
            getAttribute: async (name: string) =>
              name === "aria-label" ? button?.ariaLabel ?? null : null,
            innerText: async () => button?.name ?? "",
          };
        },
      };
    },
  } as never;
}

const indeed = adapterFor("indeed");
const dice = adapterFor("dice");

test("Indeed's resume carousel Next is not taken instead of Continue", async () => {
  // Live miss: the PDF preview's "Preview next page" matched /next/ and was clicked
  // while Continue sat next to it. The run then stalled on the same resume step.
  const frame = fakeFrame([
    { name: "Preview next page", ariaLabel: "Preview next page" },
    { name: "Continue" },
  ]);
  const advance = await indeed.findAdvanceControl(frame);
  assert.ok(advance);
  assert.equal(advance.isTerminalSubmit, false);
  assert.equal(await advance.locator.innerText(), "Continue");
});

test("a lone Continue button is still the advance control", async () => {
  const frame = fakeFrame([{ name: "Continue" }]);
  const advance = await indeed.findAdvanceControl(frame);
  assert.ok(advance);
  assert.equal(await advance.locator.innerText(), "Continue");
});

test("Indeed Review details is an advance control, not a stall", async () => {
  // Live miss: after the resume step the CTA is "Review details". The adapter only
  // searched Continue / Next, so the run stopped at 63% with the button in plain view.
  const frame = fakeFrame([{ name: "Review details" }]);
  const advance = await indeed.findAdvanceControl(frame);
  assert.ok(advance);
  assert.equal(advance.isTerminalSubmit, false);
  assert.equal(await advance.locator.innerText(), "Review details");
});

test("Proceed is recognized with the same advance labels as the shared classifier", async () => {
  const frame = fakeFrame([{ name: "Proceed" }]);
  const advance = await indeed.findAdvanceControl(frame);
  assert.ok(advance);
  assert.equal(await advance.locator.innerText(), "Proceed");
});

function fakePage(controls: Array<{ name: string; role?: "button" | "link" | "text" }>): PageLike {
  const matching = (matcher: RegExp | string | undefined, role?: string) =>
    controls.filter((control) => {
      if (role === "button" && control.role && control.role !== "button") return false;
      if (!matcher) return true;
      if (typeof matcher === "string") return control.name === matcher;
      return matcher.test(control.name);
    });

  const locatorFor = (items: typeof controls) => ({
    first: () => locatorFor(items.slice(0, 1)),
    count: async () => items.length,
    nth: (index: number) => ({
      isVisible: async () => true,
      innerText: async () => items[index]?.name ?? "",
      getAttribute: async () => null,
      click: async () => undefined,
    }),
  });

  return {
    getByRole: (role: string, options?: { name?: RegExp | string }) =>
      locatorFor(matching(options?.name, role)),
    getByText: (text: RegExp | string) => locatorFor(matching(text)),
    locator: (selector: string) => {
      if (/Apply Now/i.test(selector)) {
        return locatorFor(controls.filter((control) => /apply now/i.test(control.name)));
      }
      return locatorFor([]);
    },
  } as never;
}

test("Dice Continue Application is the entry control for a resumed Easy Apply", async () => {
  const page = fakePage([
    { name: "Continue Application", role: "button" },
    { name: "Easy Apply", role: "text" },
  ]);
  const start = await dice.findApplyButton(page);
  assert.ok(start);
  assert.equal(await start.innerText(), "Continue Application");
});

test("Dice still prefers Easy Apply over Apply Now when nothing is in progress", async () => {
  const page = fakePage([
    { name: "Easy Apply", role: "text" },
    { name: "Apply Now", role: "link" },
  ]);
  const start = await dice.findApplyButton(page);
  assert.ok(start);
  assert.equal(await start.innerText(), "Easy Apply");
});

test("Indeed 'Submit your application' is the terminal submit, not a stall", async () => {
  const frame = fakeFrame([{ name: "Submit your application" }]);
  const advance = await indeed.findAdvanceControl(frame);
  assert.ok(advance);
  assert.equal(advance.isTerminalSubmit, true);
  assert.equal(await advance.locator.innerText(), "Submit your application");
});

test("Dice wizard Next is the advance control", async () => {
  const frame = fakeFrame([{ name: "Back" }, { name: "Next" }]);
  const advance = await dice.findAdvanceControl(frame);
  assert.ok(advance);
  assert.equal(advance.isTerminalSubmit, false);
  assert.equal(await advance.locator.innerText(), "Next");
});

test("Dice's already-applied confirmation is recognised", () => {
  assert.equal(
    looksLikeAlreadyApplied("You've already applied to this job! We have your application on file."),
    true,
  );
  assert.equal(looksLikeAlreadyApplied("Review your application"), false);
});
