import { AsyncResource } from "node:async_hooks";

/**
 * Hooks fire inside the agent's own calls (and Playwright's call zones). Work
 * the recorder starts itself runs in the async context captured at init, on a
 * later tick, so none of it is attributed to, or waits on, the agent's call.
 */
let detachedScope: AsyncResource | null = null;

export function captureDetachedScope(): void {
  detachedScope ??= new AsyncResource("costkey-replay");
}

export function detached(fn: () => void): void {
  const run = () => {
    setImmediate(fn);
  };
  if (detachedScope) detachedScope.runInAsyncScope(run);
  else run();
}
