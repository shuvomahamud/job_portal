import type { FrameLike, PageLike } from "../browser/playwrightTypes";

function looksLikeCoverLetter(blob: string): boolean {
  return /\bcover[\s_-]*letter\b/.test(blob);
}

function looksLikeResume(blob: string): boolean {
  return /\b(resume|cv|curriculum)\b/.test(blob);
}

async function fileInputHint(
  input: ReturnType<FrameLike["locator"]>,
): Promise<string> {
  const [name, accept, aria, id] = await Promise.all([
    input.getAttribute("name"),
    input.getAttribute("accept"),
    input.getAttribute("aria-label"),
    input.getAttribute("id"),
  ]);
  return [name, accept, aria, id].filter(Boolean).join(" ").toLowerCase();
}

type InspectedFileInput = { index: number; blob: string; hasFiles: boolean };

async function inspectFileInputs(frame: FrameLike): Promise<InspectedFileInput[]> {
  const raw = await frame.evaluate(`(() => {
    function nearbyText(el) {
      const parts = [];
      let current = el;
      for (let depth = 0; current && depth < 6; depth += 1) {
        const parent = current.parentElement;
        if (!parent) break;
        for (const child of parent.children) {
          if (child === current) break;
          if (child.tagName === 'INPUT' || child.tagName === 'TEXTAREA' || child.tagName === 'SELECT') continue;
          parts.push(child.innerText || child.getAttribute('aria-label') || '');
        }
        parts.push(parent.getAttribute('aria-label') || '');
        const blob = parts.join(' ').toLowerCase();
        const cover = /\\bcover[\\s_-]*letter\\b/.test(blob);
        const resume = /\\b(resume|cv|curriculum)\\b/.test(blob);
        if (cover !== resume) return parts.join(' ');
        current = parent;
      }
      return parts.join(' ');
    }
    return [...document.querySelectorAll('input[type=file]')].map((el, index) => {
      const blob = [
        el.getAttribute('name'),
        el.id,
        el.getAttribute('aria-label'),
        el.getAttribute('accept'),
        nearbyText(el),
      ]
        .filter(Boolean)
        .join(' ')
        .slice(0, 500)
        .toLowerCase();
      return { index, blob, hasFiles: Boolean(el.files && el.files.length) };
    });
  })()`);
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is InspectedFileInput =>
      Boolean(item) &&
      typeof item === "object" &&
      typeof (item as InspectedFileInput).index === "number" &&
      typeof (item as InspectedFileInput).blob === "string",
  );
}

/**
 * Dice keeps a previous resume on the optional cover-letter input when the resume
 * control is already filled and disabled. Next then does nothing.
 */
export async function clearCoverLetterUploads(frame: FrameLike): Promise<number> {
  const inspected = await inspectFileInputs(frame).catch(() => []);
  const inputs = frame.locator('input[type="file"]');
  let cleared = 0;
  for (const item of inspected) {
    if (!looksLikeCoverLetter(item.blob) || !item.hasFiles) continue;
    try {
      await inputs.nth(item.index).setInputFiles([]);
      cleared += 1;
    } catch {
      // Cover letter is optional; a failed clear must not stop the application.
    }
  }
  if (await removeCoverLetterCard(frame)) cleared += 1;
  return cleared;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Dice replaces the native file input with a card + kebab menu after upload.
 * Clearing the input does not remove that card, and Next then does nothing.
 */
async function removeCoverLetterCard(frame: FrameLike): Promise<boolean> {
  const opened = await frame.evaluate(`(() => {
    function visible(el) {
      if (!(el instanceof Element)) return false;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    }
    function controlName(el) {
      return (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '')
        .replace(/\\s+/g, ' ')
        .trim();
    }
    const nodes = [...document.querySelectorAll('h1,h2,h3,h4,h5,label,legend,p,span,div')];
    const heading = nodes.find((el) => {
      if (!visible(el)) return false;
      const first = ((el.innerText || '').trim().split('\\n')[0] || '').replace(/\\s+/g, ' ');
      return /^cover letter\\b/i.test(first);
    });
    if (!heading) return false;
    const headingBox = heading.getBoundingClientRect();
    const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(visible).filter((button) => {
      const name = controlName(button);
      if (/^(next|continue|back|submit)$/i.test(name)) return false;
      const box = button.getBoundingClientRect();
      return box.top >= headingBox.top - 12 && box.top <= headingBox.top + 140;
    });
    const menu = buttons.find((button) => {
      const name = controlName(button);
      return /more|menu|options|overflow|actions/i.test(name) || name === '...' || name === '•••' || name.length <= 2;
    });
    if (!menu) return false;
    menu.click();
    return true;
  })()`).catch(() => false);
  if (!opened) return false;
  await delay(400);
  const remove = frame.getByRole("button", { name: /^(remove|delete|remove file|remove document)$/i });
  const count = await remove.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const item = remove.nth(index);
    if (!(await item.isVisible({ timeout: 300 }).catch(() => false))) continue;
    await item.click({ timeout: 5_000 }).catch(() => undefined);
    await delay(300);
    return true;
  }
  const byText = frame.getByText(/^(remove|delete)$/i);
  const textCount = await byText.count().catch(() => 0);
  for (let index = 0; index < textCount; index += 1) {
    const item = byText.nth(index);
    if (!(await item.isVisible({ timeout: 300 }).catch(() => false))) continue;
    await item.click({ timeout: 5_000 }).catch(() => undefined);
    await delay(300);
    return true;
  }
  return false;
}

/**
 * Attaches the local resume to whichever file input is actually in the DOM.
 *
 * Easy Apply widgets hide the native control and often replace it after a successful
 * upload, so a positional CSS selector from the previous detect pass times out even
 * though another `input[type=file]` is sitting there, attached and enabled.
 */
export async function resumeDropzoneNeedsFile(frame: FrameLike): Promise<boolean> {
  const empty = frame.getByText(/upload your resume/i);
  const count = await empty.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    if (await empty.nth(index).isVisible({ timeout: 300 }).catch(() => false)) return true;
  }
  return false;
}

async function setResumeOnHiddenInputs(
  frame: FrameLike,
  resumePath: string,
): Promise<boolean> {
  const inputs = frame.locator('input[type="file"]');
  const count = await inputs.count().catch(() => 0);
  if (!count) return false;

  const inspected = await inspectFileInputs(frame).catch(() => [] as InspectedFileInput[]);
  const ranked: Array<{ index: number; score: number }> = [];
  for (let index = 0; index < count; index += 1) {
    const nearby = inspected.find((item) => item.index === index)?.blob ?? "";
    const hint = `${await fileInputHint(inputs.nth(index))} ${nearby}`;
    if (looksLikeCoverLetter(hint)) continue;
    ranked.push({
      index,
      score: looksLikeResume(hint) ? 2 : 1,
    });
  }
  ranked.sort((a, b) => b.score - a.score);

  for (const { index } of ranked) {
    const input = inputs.nth(index);
    const attached = await input
      .waitFor({ state: "attached", timeout: 500 })
      .then(() => true)
      .catch(() => false);
    if (!attached) continue;
    try {
      await input.setInputFiles(resumePath, { timeout: 5_000 });
      return true;
    } catch {
      // Try the next file input rather than failing the whole application.
    }
  }
  return false;
}

async function attachResumeViaFileChooser(
  frame: FrameLike,
  resumePath: string,
  page?: PageLike,
): Promise<boolean> {
  if (!page?.waitForEvent) return false;
  const dropzone = frame.getByText(/upload your resume/i);
  if (!(await dropzone.first().isVisible({ timeout: 400 }).catch(() => false))) return false;
  try {
    const chooserPromise = page.waitForEvent("filechooser", { timeout: 4_000 });
    await dropzone.first().click({ timeout: 3_000 });
    const chooser = await chooserPromise;
    await chooser.setFiles(resumePath);
    await delay(250);
    return !(await resumeDropzoneNeedsFile(frame));
  } catch {
    return false;
  }
}

export async function attachResumeFile(
  frame: FrameLike,
  resumePath: string,
  page?: PageLike,
): Promise<boolean> {
  // Do not click the dropzone first. On headed Chrome that opens the OS file
  // picker, after which setInputFiles on the hidden input times out.
  if (await setResumeOnHiddenInputs(frame, resumePath)) return true;
  return attachResumeViaFileChooser(frame, resumePath, page);
}
