/**
 * Structural types for the dynamically imported `playwright` module.
 *
 * Playwright is loaded through an indirect-eval dynamic import so bundlers do not
 * try to resolve it, which means we cannot use its real types. These declare only
 * the surface this worker actually calls.
 *
 * Keep this list minimal but honest: every method declared here must exist on the
 * installed Playwright version (currently ^1.62), because TypeScript cannot check
 * that for us.
 */

export type LocatorLike = {
  count(): Promise<number>;
  nth(index: number): LocatorLike;
  first(): LocatorLike;
  filter(options: { hasText?: RegExp | string }): LocatorLike;
  textContent(options?: { timeout?: number }): Promise<string | null>;
  innerText(options?: { timeout?: number }): Promise<string>;
  getAttribute(name: string, options?: { timeout?: number }): Promise<string | null>;
  isVisible(options?: { timeout?: number }): Promise<boolean>;
  isEnabled(options?: { timeout?: number }): Promise<boolean>;
  click(options?: { timeout?: number; force?: boolean }): Promise<void>;
  check(options?: { timeout?: number; force?: boolean }): Promise<void>;
  fill(value: string, options?: { timeout?: number }): Promise<void>;
  inputValue(options?: { timeout?: number }): Promise<string>;
  pressSequentially(value: string, options?: { delay?: number; timeout?: number }): Promise<void>;
  selectOption(
    values: { label?: string; value?: string; index?: number } | string | string[],
    options?: { timeout?: number },
  ): Promise<string[]>;
  setInputFiles(files: string | string[], options?: { timeout?: number }): Promise<void>;
  scrollIntoViewIfNeeded(options?: { timeout?: number }): Promise<void>;
  press(key: string, options?: { timeout?: number }): Promise<void>;
  waitFor(options?: { state?: "attached" | "detached" | "visible" | "hidden"; timeout?: number }): Promise<void>;
};

export type FrameLike = {
  url(): string;
  name(): string;
  locator(selector: string): LocatorLike;
  getByRole(role: string, options?: { name?: RegExp | string; exact?: boolean }): LocatorLike;
  /** Matches on rendered text, for controls that carry no accessible role. */
  getByText(text: RegExp | string, options?: { exact?: boolean }): LocatorLike;
  /** Function or string form — string is required when tsx injects `__name` helpers into nested fns. */
  evaluate<R>(pageFunction: string | (() => R)): Promise<R>;
  content(): Promise<string>;
  isDetached(): boolean;
};

export type PageLike = FrameLike & {
  goto(url: string, options: Record<string, unknown>): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  waitForLoadState(
    state?: "load" | "domcontentloaded" | "networkidle",
    options?: { timeout?: number },
  ): Promise<void>;
  frames(): FrameLike[];
  mainFrame(): FrameLike;
  screenshot(options: { path: string; fullPage?: boolean }): Promise<Buffer>;
  keyboard: { press(key: string): Promise<void> };
  close(options?: { runBeforeUnload?: boolean }): Promise<void>;
};

export type TracingLike = {
  start(options: { screenshots?: boolean; snapshots?: boolean; sources?: boolean }): Promise<void>;
  stop(options?: { path?: string }): Promise<void>;
};

export type BrowserContextLike = {
  newPage(): Promise<PageLike>;
  pages(): PageLike[];
  close(): Promise<void>;
  tracing?: TracingLike;
  setDefaultTimeout?(timeout: number): void;
};

export type BrowserLike = {
  contexts(): BrowserContextLike[];
  newContext(options: Record<string, unknown>): Promise<BrowserContextLike>;
  isConnected?(): boolean;
  close(): Promise<void>;
};

export type PlaywrightModule = {
  chromium: {
    launchPersistentContext(
      userDataDir: string,
      options: Record<string, unknown>,
    ): Promise<BrowserContextLike>;
    connectOverCDP(endpointURL: string, options?: Record<string, unknown>): Promise<BrowserLike>;
  };
};
