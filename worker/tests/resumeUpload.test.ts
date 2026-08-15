import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { attachResumeFile, clearCoverLetterUploads } from "../src/apply/resumeUpload";
import { loadPlaywright } from "../src/browser/session";

test("attachResumeFile uses a hidden resume input and skips cover letter", async () => {
  const playwright = await loadPlaywright();
  const userDataDir = await mkdtemp(join(tmpdir(), "resume-upload-"));
  const resumePath = join(userDataDir, "resume.pdf");
  await writeFile(resumePath, "%PDF-1.4\n");
  const htmlPath = join(userDataDir, "form.html");
  await writeFile(
    htmlPath,
    `<!doctype html><input type="file" name="coverLetter" aria-label="Cover letter" />
     <input type="file" name="resume" accept=".pdf,.docx" style="opacity:0" />`,
  );
  const context = await playwright.chromium.launchPersistentContext(userDataDir, {
    headless: true,
    viewport: { width: 800, height: 600 },
  });
  try {
    const page = await context.newPage();
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "domcontentloaded" });
    const attached = await attachResumeFile(page, resumePath);
    assert.equal(attached, true);
    const names = await page.evaluate(() => ({
      resume: (document.querySelector('input[name="resume"]') as HTMLInputElement).files?.[0]?.name ?? "",
      cover: (document.querySelector('input[name="coverLetter"]') as HTMLInputElement).files?.[0]?.name ?? "",
    }));
    assert.equal(names.resume, "resume.pdf");
    assert.equal(names.cover, "");
  } finally {
    await context.close();
  }
});

test("attachResumeFile skips a cover letter whose name is only in nearby text", async () => {
  const playwright = await loadPlaywright();
  const userDataDir = await mkdtemp(join(tmpdir(), "resume-upload-nearby-"));
  const resumePath = join(userDataDir, "resume.pdf");
  await writeFile(resumePath, "%PDF-1.4\n");
  const htmlPath = join(userDataDir, "form.html");
  await writeFile(
    htmlPath,
    `<!doctype html>
     <section><h2>Cover letter (Optional)</h2><input type="file" /></section>
     <section><h2>Resume (Required)</h2><input type="file" accept=".pdf,.docx" /></section>`,
  );
  const context = await playwright.chromium.launchPersistentContext(userDataDir, {
    headless: true,
    viewport: { width: 800, height: 600 },
  });
  try {
    const page = await context.newPage();
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "domcontentloaded" });
    const attached = await attachResumeFile(page, resumePath);
    assert.equal(attached, true);
    const names = await page.evaluate(() => {
      const inputs = [...document.querySelectorAll("input[type=file]")] as HTMLInputElement[];
      return {
        cover: inputs[0]?.files?.[0]?.name ?? "",
        resume: inputs[1]?.files?.[0]?.name ?? "",
      };
    });
    assert.equal(names.resume, "resume.pdf");
    assert.equal(names.cover, "");
  } finally {
    await context.close();
  }
});

test("attachResumeFile fills a Dice-style sr-only resume input without clicking the dropzone", async () => {
  const playwright = await loadPlaywright();
  const userDataDir = await mkdtemp(join(tmpdir(), "resume-upload-sr-only-"));
  const resumePath = join(userDataDir, "resume.pdf");
  await writeFile(resumePath, "%PDF-1.4\n");
  const htmlPath = join(userDataDir, "form.html");
  await writeFile(
    htmlPath,
    `<!doctype html>
     <h2>Resume *</h2>
     <div>Upload your resume</div>
     <input class="sr-only" type="file" accept=".pdf, .doc, .docx" aria-describedby="resume-description" />
     <h2>Cover letter</h2>
     <div>Upload your cover letter</div>
     <input class="sr-only" type="file" accept=".pdf, .doc, .docx" aria-describedby="cover letter-description" />
     <style>.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}</style>`,
  );
  const context = await playwright.chromium.launchPersistentContext(userDataDir, {
    headless: true,
    viewport: { width: 800, height: 600 },
  });
  try {
    const page = await context.newPage();
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "domcontentloaded" });
    const attached = await attachResumeFile(page, resumePath);
    assert.equal(attached, true);
    const names = await page.evaluate(() => {
      const inputs = [...document.querySelectorAll("input[type=file]")] as HTMLInputElement[];
      return {
        resume: inputs[0]?.files?.[0]?.name ?? "",
        cover: inputs[1]?.files?.[0]?.name ?? "",
      };
    });
    assert.equal(names.resume, "resume.pdf");
    assert.equal(names.cover, "");
  } finally {
    await context.close();
  }
});

test("clearCoverLetterUploads removes a file from the cover-letter input only", async () => {
  const playwright = await loadPlaywright();
  const userDataDir = await mkdtemp(join(tmpdir(), "resume-clear-cover-"));
  const resumePath = join(userDataDir, "resume.pdf");
  await writeFile(resumePath, "%PDF-1.4\n");
  const htmlPath = join(userDataDir, "form.html");
  await writeFile(
    htmlPath,
    `<!doctype html>
     <section><h2>Resume</h2><input id="resume" type="file" /></section>
     <section><h2>Cover letter</h2><input id="cover" type="file" /></section>`,
  );
  const context = await playwright.chromium.launchPersistentContext(userDataDir, {
    headless: true,
    viewport: { width: 800, height: 600 },
  });
  try {
    const page = await context.newPage();
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "domcontentloaded" });
    await page.locator("#resume").setInputFiles(resumePath);
    await page.locator("#cover").setInputFiles(resumePath);
    assert.equal(await clearCoverLetterUploads(page), 1);
    const names = await page.evaluate(() => ({
      resume: (document.querySelector("#resume") as HTMLInputElement).files?.[0]?.name ?? "",
      cover: (document.querySelector("#cover") as HTMLInputElement).files?.[0]?.name ?? "",
    }));
    assert.equal(names.resume, "resume.pdf");
    assert.equal(names.cover, "");
  } finally {
    await context.close();
  }
});
