import { AsyncLocalStorage } from "node:async_hooks";
import { currentTraceId } from "./trace.js";
import { clip, detached, finite, keyName, maskedLength, noteAction, recordPage, type ReplaySession } from "./session.js";
import type { AgentAction, CdpLike } from "./recorder.js";
import { debug, guard } from "./safety.js";

/**
 * Puppeteer. Every browser, launched or connected, is created by
 * `CdpBrowser._create`; wrapping it lets us watch the browser's page targets.
 * Each page gets its own CDP session (`page.createCDPSession`). Page, mouse
 * and keyboard methods are wrapped once (on their prototypes) to tag actions
 * with the page and the CostKey run they ran in.
 */

const HOOKED = Symbol.for("costkey.replay.puppeteer");

/**
 * Set while one of the agent's actions runs. `page.type` calls
 * `keyboard.press` once per character, and `page.click` calls `mouse.click`:
 * only the outermost call is the agent's action, and the inner ones would
 * spell out typed text.
 */
const insideAction = new AsyncLocalStorage<true>();

const PAGE_ACTIONS = ["goto", "goBack", "goForward", "reload", "click", "type", "focus", "hover", "select", "tap", "screenshot"] as const;
const MOUSE_ACTIONS = ["click", "wheel"] as const;
const KEYBOARD_ACTIONS = ["type", "press", "sendCharacter"] as const;

export function hookPuppeteer(puppeteer: any, session: ReplaySession): boolean {
  const CdpBrowser = puppeteer?.CdpBrowser;
  if (!CdpBrowser || typeof CdpBrowser._create !== "function") {
    debug("this Puppeteer version has no CdpBrowser._create; not recording it");
    return false;
  }
  if (CdpBrowser[HOOKED]) return false;
  CdpBrowser[HOOKED] = true;

  const owners = new WeakMap<object, object>(); // mouse/keyboard → page
  const original = CdpBrowser._create;
  CdpBrowser._create = async function create(this: unknown, ...args: unknown[]) {
    const browser = await original.apply(this, args);
    guard(() => watchBrowser(browser));
    return browser;
  };

  function watchBrowser(browser: any): void {
    const traceId = currentTraceId();
    const onTarget = (target: any) =>
      guard(() => {
        if (target?.type?.() !== "page") return;
        detached(() => void startTarget(target, traceId));
      });
    for (const target of browser.targets?.() ?? []) onTarget(target);
    browser.on?.("targetcreated", onTarget);
  }

  async function startTarget(target: any, traceId: string | null): Promise<void> {
    let page: any;
    try {
      page = await target.page();
    } catch {
      return;
    }
    if (!page) return;
    guard(() => patchPage(page));
    await recordPage(
      session,
      page,
      async () => adapt(await page.createCDPSession()),
      currentTraceId() ?? traceId,
      (stop) => page.once?.("close", () => guard(stop)),
    );
  }

  function patchPage(page: any): void {
    if (page.mouse) owners.set(page.mouse, page);
    if (page.keyboard) owners.set(page.keyboard, page);
    wrapMethods(Object.getPrototypeOf(page), PAGE_ACTIONS, (self, method, args) => ({ page: self, action: pageAction(method, args) }));
    if (page.mouse) wrapMethods(Object.getPrototypeOf(page.mouse), MOUSE_ACTIONS, (self, method, args) => ({ page: owners.get(self), action: mouseAction(method, args) }));
    if (page.keyboard) wrapMethods(Object.getPrototypeOf(page.keyboard), KEYBOARD_ACTIONS, (self, method, args) => ({ page: owners.get(self), action: keyboardAction(method, args) }));
  }

  function wrapMethods(
    proto: any,
    methods: readonly string[],
    describe: (self: any, method: string, args: unknown[]) => { page: object | undefined; action: AgentAction },
  ): void {
    if (!proto || proto[HOOKED]) return;
    proto[HOOKED] = true;
    for (const method of methods) {
      const holder = findOwner(proto, method);
      if (!holder) continue;
      const original = holder[method];
      // Define on the prototype we were given, so other subclasses stay untouched.
      Object.defineProperty(proto, method, {
        configurable: true,
        writable: true,
        value: function wrapped(this: any, ...args: unknown[]) {
          if (insideAction.getStore()) return original.apply(this, args);
          guard(() => {
            const { page, action } = describe(this, method, args);
            noteAction(session, page, currentTraceId(), action);
          });
          return insideAction.run(true, () => original.apply(this, args));
        },
      });
    }
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

function pageAction(method: string, args: unknown[]): AgentAction {
  const action: AgentAction = { name: `page.${method}` };
  if (method === "goto") {
    const url = clip(args[0], 500);
    if (url) action.url = url;
  } else if (method !== "goBack" && method !== "goForward" && method !== "reload" && method !== "screenshot") {
    const selector = clip(args[0], 300);
    if (selector) action.selector = selector;
    if (method === "type") {
      const length = maskedLength(args[1]);
      if (length !== undefined) action.textLength = length;
    }
  }
  return action;
}

function mouseAction(method: string, args: unknown[]): AgentAction {
  const action: AgentAction = { name: `mouse.${method}` };
  if (method === "click") {
    const x = finite(args[0]);
    const y = finite(args[1]);
    const button = clip((args[2] as { button?: unknown } | undefined)?.button, 10);
    if (x !== undefined) action.x = x;
    if (y !== undefined) action.y = y;
    if (button) action.button = button;
  } else {
    const delta = args[0] as { deltaX?: unknown; deltaY?: unknown } | undefined;
    const x = finite(delta?.deltaX);
    const y = finite(delta?.deltaY);
    if (x !== undefined) action.x = x;
    if (y !== undefined) action.y = y;
  }
  return action;
}

function keyboardAction(method: string, args: unknown[]): AgentAction {
  const action: AgentAction = { name: `keyboard.${method}` };
  if (method === "press") {
    const key = keyName(args[0]);
    if (key) action.key = key;
    else action.textLength = 1;
  } else {
    const length = maskedLength(args[0]);
    if (length !== undefined) action.textLength = length;
  }
  return action;
}

function findOwner(proto: any, method: string): any {
  let current = proto;
  while (current && current !== Object.prototype) {
    if (Object.prototype.hasOwnProperty.call(current, method) && typeof current[method] === "function") return current;
    current = Object.getPrototypeOf(current);
  }
  return null;
}
