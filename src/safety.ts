/**
 * The recorder rides the agent's own browser objects, so a bug here must never
 * break the agent. Every hook body runs through `guard`; the first unexpected
 * error turns recording off for the rest of the process and is reported once.
 */

let disabledReason: string | null = null;
let debugEnabled = false;

export function setDebug(enabled: boolean): void {
  debugEnabled = enabled;
}

export function debug(message: string, detail?: unknown): void {
  if (!debugEnabled) return;
  if (detail === undefined) console.debug(`[costkey-replay] ${message}`);
  else console.debug(`[costkey-replay] ${message}`, detail);
}

export function isDisabled(): boolean {
  return disabledReason !== null;
}

export function disabledBecause(): string | null {
  return disabledReason;
}

export function disable(reason: string, error?: unknown): void {
  if (disabledReason !== null) return;
  disabledReason = reason;
  const detail = error instanceof Error ? `: ${error.message}` : "";
  console.warn(`[costkey-replay] Recording stopped (${reason}${detail}). Your agent is unaffected.`);
}

/** Run a hook body; on error, stop recording and return the fallback. */
export function guard<T>(fn: () => T, fallback?: T): T | undefined {
  if (disabledReason !== null) return fallback;
  try {
    return fn();
  } catch (error) {
    disable("internal error", error);
    return fallback;
  }
}

/** Test helper: start over. */
export function resetSafety(): void {
  disabledReason = null;
}
