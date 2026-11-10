import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type TraceGetter = () => string | undefined;

let getter: TraceGetter | null = null;

/**
 * Find the app's own `costkey` SDK so pages and actions are tagged with the run
 * (trace) they happen in. Resolved from the app first, so it's the same copy
 * whose async context the agent runs in.
 */
export async function loadTraceGetter(): Promise<boolean> {
  if (getter) return true;
  for (const from of [join(process.cwd(), "index.js"), import.meta.url]) {
    try {
      const path = createRequire(from).resolve("costkey");
      const mod = (await import(pathToFileURL(path).href)) as Record<string, any>;
      const fn = mod.CostKey?.getCurrentTraceId ?? mod.getCurrentTraceId ?? mod.default?.getCurrentTraceId;
      if (typeof fn === "function") {
        getter = fn as TraceGetter;
        return true;
      }
    } catch {
      // Not installed there; try the next place.
    }
  }
  return false;
}

export function setTraceGetter(fn: TraceGetter | null): void {
  getter = fn;
}

export function currentTraceId(): string | null {
  if (!getter) return null;
  try {
    return getter() ?? null;
  } catch {
    return null;
  }
}
