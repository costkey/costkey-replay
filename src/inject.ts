import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The isolated world the recorder runs in: same DOM as the page, but the page's scripts can't see it. */
export const WORLD_NAME = "__costkey_replay";
/** CDP binding the recorder calls with batches of events; exists only in that world. */
export const BINDING_NAME = "__costkeyReplayEmit";

let bundle: string | null = null;

/** rrweb's recorder: vendored next to the build, or from node_modules when running from source. */
export function recorderBundle(): string {
  if (bundle !== null) return bundle;
  const here = dirname(fileURLToPath(import.meta.url));
  try {
    bundle = readFileSync(join(here, "vendor", "rrweb-record.min.js"), "utf8");
  } catch {
    const require = createRequire(import.meta.url);
    bundle = readFileSync(join(dirname(require.resolve("@rrweb/record")), "record.umd.min.cjs"), "utf8");
  }
  return bundle;
}

/**
 * What runs in each top-level document. rrweb records the DOM and its changes;
 * every 500 ms (and on page hide) the batch goes back over CDP through the
 * binding, so the page itself never makes a request. Inputs are masked,
 * stylesheets inlined, canvas off, and a fresh snapshot is taken every minute
 * so a run that starts mid-session still has a starting point.
 */
export function injectedScript(rrweb: string = recorderBundle()): string {
  return `if (!globalThis.__ckReplay && window.top === window && typeof globalThis.${BINDING_NAME} === "function") {
globalThis.__ckReplay = { pending: true };
${rrweb}
;(function () {
  var emit = globalThis.${BINDING_NAME};
  var api = globalThis.rrwebRecord;
  if (!api || typeof api.record !== "function") return;
  var record = api.record;
  var buffer = [];
  function flush() {
    if (!buffer.length) return;
    var batch = buffer;
    buffer = [];
    try { emit(JSON.stringify({ href: String(location.href), events: batch })); } catch (e) {}
  }
  var stop = record({
    emit: function (event) { buffer.push(event); if (buffer.length >= 100) flush(); },
    maskAllInputs: true,
    inlineStylesheet: true,
    slimDOMOptions: "all",
    recordCanvas: false,
    collectFonts: false,
    checkoutEveryNms: 60000,
    sampling: { mousemove: 100, scroll: 150, media: 800, input: "last" }
  });
  var timer = setInterval(flush, 500);
  addEventListener("pagehide", flush, true);
  globalThis.__ckReplay = {
    snapshot: function () { try { record.takeFullSnapshot(true); } catch (e) {} flush(); },
    flush: flush,
    stop: function () { clearInterval(timer); flush(); if (stop) stop(); }
  };
})();
}`;
}
