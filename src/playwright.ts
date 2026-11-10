import { currentTraceId } from "./trace.js";
import { clip, detached, finite, keyName, maskedLength, noteAction, recordPage, type ReplaySession } from "./session.js";
import type { AgentAction, CdpLike } from "./recorder.js";
import { debug, guard } from "./safety.js";

/**
 * Playwright (Node, in process). Two hooks, both on Playwright's client:
 *
 * - The client instrumentation (the one @playwright/test uses for tracing)
 *   reports every new browser context: from `newContext`, `newPage`,
 *   `launchPersistentContext`, and the default context of `connectOverCDP`.
 *   Each page in it gets its own CDP session (`context.newCDPSession`).
 * - Every call the agent makes reaches `Connection.sendMessageToServer` with
 *   the object it was made on, so we learn which page an action ran on and
 *   which CostKey run (trace) it ran in. This sits below Playwright's own
 *   call-site capture, so error messages and traces stay exactly as they were.
 *
 * Firefox and WebKit contexts have no CDP, so `newCDPSession` fails and they
 * are skipped.
 */

const HOOKED = Symbol.for("costkey.replay.playwright");

const ACTIONS: Record<string, ReadonlySet<string>> = {
  Frame: new Set(["goto", "click", "dblclick", "tap", "fill", "type", "press", "check", "uncheck", "selectOption", "hover", "setInputFiles", "dragAndDrop", "focus"]),
  ElementHandle: new Set(["click", "dblclick", "tap", "fill", "type", "press", "check", "uncheck", "selectOption", "hover", "setInputFiles", "focus", "screenshot"]),
  Page: new Set(["goBack", "goForward", "reload", "mouseClick", "mouseWheel", "keyboardType", "keyboardPress", "keyboardInsertText", "screenshot", "expectScreenshot"]),
};

interface CallOptions {
  internal?: boolean;
  apiName?: string;
}

export function hookPlaywright(playwright: any, session: ReplaySession): boolean {
  if (!playwright || typeof playwright !== "object" || playwright[HOOKED]) return false;
  const instrumentation = playwright._instrumentation;
  const connection = playwright._connection;
  if (!instrumentation || typeof instrumentation.addListener !== "function" || typeof connection?.sendMessageToServer !== "function") {
    debug("this Playwright version has no client instrumentation; not recording it");
    return false;
  }
  playwright[HOOKED] = true;

  const contextTraces = new WeakMap<object, string>();
  const watched = new WeakSet<object>();

  const send = connection.sendMessageToServer;
  connection.sendMessageToServer = function sendMessageToServer(this: unknown, object: any, method: string, params: Record<string, unknown>, options?: CallOptions) {
    guard(() => {
      if (options?.internal) return;
      const traceId = currentTraceId();
      if (traceId && watched.has(object)) contextTraces.set(object, traceId);
      const methods = ACTIONS[object?._type];
      const action = methods?.has(method) ? actionFrom(options?.apiName, object._type, method, params ?? {}) : undefined;
      if (traceId || action) noteAction(session, pageOf(object), traceId, action);
    });
    return send.call(this, object, method, params, options);
  };

  instrumentation.addListener({
    // Return nothing: Playwright awaits listeners, and the agent must not wait on us.
    runAfterCreateBrowserContext(context: any) {
      guard(() => watchContext(context));
    },
  });

  function watchContext(context: any): void {
    if (!context || watched.has(context) || typeof context.newCDPSession !== "function") return;
    watched.add(context);
    const traceId = currentTraceId();
    if (traceId) contextTraces.set(context, traceId);
    const onPage = (page: any) => guard(() => detached(() => void startPage(context, page)));
    for (const page of context.pages?.() ?? []) onPage(page);
    context.on?.("page", onPage);
  }

  async function startPage(context: any, page: any): Promise<void> {
    await recordPage(
      session,
      page,
      async () => adapt(await context.newCDPSession(page)),
      contextTraces.get(context) ?? null,
      (stop) => page.once?.("close", () => guard(stop)),
    );
  }

  return true;
}

function adapt(cdpSession: any): CdpLike {
  return {
    send: (method, params) => cdpSession.send(method, params),
    on: (event, handler) => cdpSession.on(event, handler),
    detach: () => cdpSession.detach(),
  };
}

/** Page for an API call owner: the page itself, a frame, or an element handle. */
function pageOf(owner: any): object | null {
  if (!owner || typeof owner !== "object") return null;
  if (typeof owner.mainFrame === "function" && typeof owner.context === "function") return owner;
  if (owner._page && typeof owner._page === "object") return owner._page;
  if (owner._frame?._page) return owner._frame._page;
  return null;
}

function actionFrom(apiName: unknown, type: string, method: string, params: Record<string, unknown>): AgentAction {
  const name = typeof apiName === "string" && apiName && !apiName.includes("<anonymous>") ? apiName : `${type.toLowerCase()}.${method}`;
  const position = params.position as { x?: unknown; y?: unknown } | undefined;
  const action: AgentAction = { name };
  const selector = clip(params.selector, 300);
  const url = clip(params.url, 500);
  const key = keyName(params.key);
  const button = clip(params.button, 10);
  const x = finite(params.x ?? position?.x ?? params.deltaX);
  const y = finite(params.y ?? position?.y ?? params.deltaY);
  const textLength = maskedLength(params.text ?? params.value ?? params.values) ?? (typeof params.key === "string" && !key ? 1 : undefined);
  if (selector) action.selector = selector;
  if (url) action.url = url;
  if (key) action.key = key;
  if (button) action.button = button;
  if (x !== undefined) action.x = x;
  if (y !== undefined) action.y = y;
  if (textLength !== undefined) action.textLength = textLength;
  return action;
}
