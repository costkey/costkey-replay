import { PageRecorder, type AgentAction } from "./recorder.js";
import type { CdpLike } from "./recorder.js";
import { debug, isDisabled } from "./safety.js";
export { detached, captureDetachedScope } from "./scope.js";
import type { Uploader } from "./uploader.js";

/**
 * What the library hooks share: whether recording is allowed right now, how to
 * start a recorder, and the page → recorder map used to tag actions.
 */
export interface ReplaySession {
  uploader: Uploader;
  blockUrls: RegExp[];
  /** Resolves with the project's screen-recording setting (the remote half of the opt-in). */
  allowed(): Promise<boolean>;
  recorders: WeakMap<object, PageRecorder>;
  live: Set<PageRecorder>;
  /** Actions on a page whose recorder isn't up yet (it starts a tick later). */
  pending: WeakMap<object, PendingPage>;
}

interface PendingPage {
  traceId: string | null;
  actions: Array<{ action: AgentAction; at: number }>;
}

const MAX_PENDING_ACTIONS = 50;

/** Start recording a page on a CDP session of our own. Never throws. */
export async function recordPage(
  session: ReplaySession,
  page: object,
  openCdp: () => Promise<CdpLike>,
  traceId: string | null,
  onClose: (stop: () => void) => void,
): Promise<PageRecorder | null> {
  if (isDisabled() || session.uploader.stopped || session.recorders.has(page)) return null;
  if (!(await session.allowed())) return null;
  let cdp: CdpLike;
  try {
    cdp = await openCdp();
  } catch (error) {
    // Not Chromium, or the page closed first.
    debug("no CDP session for page", error instanceof Error ? error.message : error);
    return null;
  }
  const early = session.pending.get(page);
  session.pending.delete(page);
  const recorder = new PageRecorder(cdp, { uploader: session.uploader, blockUrls: session.blockUrls, traceId: early?.traceId ?? traceId });
  for (const { action, at } of early?.actions ?? []) recorder.addAction(action, at);
  session.recorders.set(page, recorder);
  session.live.add(recorder);
  const stop = () => {
    recorder.stop();
    session.live.delete(recorder);
  };
  onClose(stop);
  try {
    await recorder.start();
  } catch (error) {
    debug("page went away while starting the recorder", error instanceof Error ? error.message : error);
    stop();
    return null;
  }
  return recorder;
}

export function noteAction(session: ReplaySession, page: object | null | undefined, traceId: string | null, action?: AgentAction): void {
  if (!page) return;
  const recorder = session.recorders.get(page);
  if (recorder) {
    if (recorder.isStopped) return;
    recorder.setTrace(traceId);
    if (action) recorder.addAction(action);
    return;
  }
  const early = session.pending.get(page) ?? { traceId: null, actions: [] };
  if (traceId) early.traceId = traceId;
  if (action && early.actions.length < MAX_PENDING_ACTIONS) early.actions.push({ action, at: Date.now() });
  session.pending.set(page, early);
}

/** Named keys (Enter, Tab, Control+A) are kept; a single character is typed text, so it isn't. */
export function keyName(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const key = value.split("+").pop() ?? "";
  return key.length > 1 ? clip(value, 40) : undefined;
}

/** Typed text never leaves the process: keep its length only. */
export function maskedLength(value: unknown): number | undefined {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.length;
  return undefined;
}

export function clip(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 10) / 10 : undefined;
}
