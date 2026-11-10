import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fetchScreenCaptureEnabled, parseDsn } from "./config.js";
import { hookPlaywright } from "./playwright.js";
import { hookPuppeteer } from "./puppeteer.js";
import { compileBlockList, type PageRecorder } from "./recorder.js";
import { debug, disable, guard, setDebug } from "./safety.js";
import { captureDetachedScope, type ReplaySession } from "./session.js";
import { loadTraceGetter } from "./trace.js";
import { Uploader } from "./uploader.js";

export interface ReplayOptions {
  /** Same DSN as the core SDK. Defaults to `COSTKEY_DSN`. */
  dsn?: string;
  /**
   * Pages not to record, as URL globs: `["*\/billing/*", "https://accounts.example.com/*"]`.
   * While a matching page shows, nothing from it is kept.
   */
  blockUrls?: string[];
  debug?: boolean;
}

interface State {
  session: ReplaySession;
  ready: Promise<void>;
  refresh: NodeJS.Timeout | null;
}

let state: State | null = null;

/**
 * Start recording the browser pages your agent drives.
 *
 * Patches the Playwright and Puppeteer your app has installed (resolved from
 * the working directory) the way the core SDK patches `fetch`: you keep using
 * them as before, and each Chromium page gets an rrweb recording linked to the
 * CostKey run it happens in. Nothing records until the project turns on screen
 * recordings (Settings → Privacy & data). Call it before launching the browser;
 * awaiting it makes sure Puppeteer is patched first.
 */
export function init(options: ReplayOptions = {}): Promise<void> {
  if (state) return state.ready;
  const dsnString = options.dsn ?? process.env["COSTKEY_DSN"];
  if (!dsnString) return Promise.resolve(); // No DSN (tests, local runs): do nothing.
  setDebug(options.debug === true);
  captureDetachedScope();

  const dsn = parseDsn(dsnString);
  let allowed: boolean | null = null;
  let allowedCheck: Promise<boolean> | null = null;
  const checkAllowed = async (): Promise<boolean> => {
    const result = await fetchScreenCaptureEnabled(dsn);
    if (result !== null) allowed = result;
    return allowed === true;
  };

  const live = new Set<PageRecorder>();
  const uploader = new Uploader(dsn, {
    onRejected: (reason) => {
      for (const recorder of live) recorder.stop();
      live.clear();
      disable(reason);
    },
  });
  const session: ReplaySession = {
    uploader,
    blockUrls: compileBlockList(options.blockUrls),
    recorders: new WeakMap(),
    pending: new WeakMap(),
    live,
    allowed: () => {
      if (allowed !== null) return Promise.resolve(allowed);
      allowedCheck ??= checkAllowed().finally(() => { allowedCheck = null; });
      return allowedCheck;
    },
  };

  // Playwright is CommonJS: patch it now, before the app can launch anything.
  for (const playwright of loadPlaywrights()) guard(() => hookPlaywright(playwright, session));

  const ready = (async () => {
    await Promise.all([
      loadTraceGetter().then((found) => { if (!found) debug("costkey SDK not found: recordings won't be linked to runs"); }),
      loadPuppeteers().then((modules) => { for (const puppeteer of modules) guard(() => hookPuppeteer(puppeteer, session)); }),
      session.allowed().then((on) => { if (!on) debug("screen recordings are off for this project; not recording"); }),
    ]);
  })().catch((error) => disable("couldn't start", error));

  // Pick up the project setting changing while the process runs.
  const refresh = setInterval(() => void checkAllowed(), 5 * 60_000);
  refresh.unref?.();
  process.once("beforeExit", () => void flush());
  state = { session, ready, refresh };
  return ready;
}

/** Send everything recorded so far. Await it before a short-lived process exits. */
export async function flush(): Promise<void> {
  if (!state) return;
  for (const recorder of state.session.live) recorder.flush();
  await state.session.uploader.flush();
}

/** Stop recording and send what's left. */
export async function shutdown(): Promise<void> {
  if (!state) return;
  for (const recorder of state.session.live) recorder.stop();
  state.session.live.clear();
  if (state.refresh) clearInterval(state.refresh);
  await state.session.uploader.flush();
  state = null;
}

export const CostKeyReplay = { init, flush, shutdown } as const;
export default CostKeyReplay;

/** Places to resolve the app's packages from: the working directory and the entry script. */
function appRequires(): NodeRequire[] {
  const roots = new Set<string>([join(process.cwd(), "index.js")]);
  if (process.argv[1]) roots.add(join(dirname(process.argv[1]), "index.js"));
  return [...roots].map((root) => createRequire(root));
}

/** Every distinct playwright-core the app can load, directly or through `playwright` / `@playwright/test`. */
function resolveAll(name: string, via: string[]): string[] {
  const found = new Set<string>();
  for (const require of appRequires()) {
    try { found.add(require.resolve(name)); } catch { /* not installed here */ }
    for (const wrapper of via) {
      try {
        const wrapperPath = require.resolve(`${wrapper}/package.json`);
        found.add(createRequire(wrapperPath).resolve(name));
      } catch { /* not installed here */ }
    }
  }
  return [...found];
}

function loadPlaywrights(): unknown[] {
  const modules: unknown[] = [];
  for (const path of resolveAll("playwright-core", ["playwright", "@playwright/test"])) {
    try {
      modules.push(createRequire(path)(path));
    } catch (error) {
      debug(`couldn't load ${path}`, error instanceof Error ? error.message : error);
    }
  }
  return modules;
}

async function loadPuppeteers(): Promise<unknown[]> {
  const modules: unknown[] = [];
  for (const path of resolveAll("puppeteer-core", ["puppeteer"])) {
    try {
      modules.push(await import(pathToFileURL(path).href));
    } catch (error) {
      debug(`couldn't load ${path}`, error instanceof Error ? error.message : error);
    }
  }
  return modules;
}

export type { AgentAction } from "./recorder.js";
