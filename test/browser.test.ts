/**
 * End to end against a real Chromium: the app uses Playwright and Puppeteer
 * as usual, and a fake CostKey server receives the recording.
 * Skipped when no Chromium is found (set CHROME_PATH to point at one).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { chromium } from "playwright-core";
import { flush, init } from "../src/index.js";
import { setTraceGetter } from "../src/trace.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const FONT = Buffer.from("d09GMgABAAAAAAfakefontbytes", "utf8");
const SECRET = "hunter2-very-secret";

function chromePath(): string | null {
  if (process.env["CHROME_PATH"] && existsSync(process.env["CHROME_PATH"])) return process.env["CHROME_PATH"];
  const cache = join(homedir(), "Library", "Caches", "ms-playwright");
  if (existsSync(cache)) {
    for (const dir of readdirSync(cache).filter((name) => /^chromium-\d+$/.test(name)).sort().reverse()) {
      const candidate = join(cache, dir, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
      if (existsSync(candidate)) return candidate;
    }
  }
  for (const candidate of ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/chromium", "/usr/bin/google-chrome"]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const executablePath = chromePath();
// Puppeteer 25 targets Node 22.12+; where it doesn't load, only the Playwright test runs.
const puppeteerModule = await import("puppeteer-core").catch(() => null);

interface Received {
  configReads: number;
  chunks: Array<{ recordingId: string; seq: number; traceId: string | null; events: any[] }>;
  assets: Map<string, { mediaType: string; data: Buffer }>;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}

let costkey: Server;
let site: Server;
let sitePort = 0;
const received: Received = { configReads: 0, chunks: [], assets: new Map() };
let trace: string | undefined;

beforeAll(async () => {
  costkey = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (part: Buffer) => parts.push(part));
    req.on("end", () => {
      const body = Buffer.concat(parts);
      if (req.headers.authorization !== "Bearer key_test") { res.writeHead(401).end(); return; }
      if (req.method === "GET" && req.url === "/api/v1/projects/proj_test/config") {
        received.configReads++;
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ capture: { screenCaptureEnabled: true } }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/v1/replay/chunks") {
        received.chunks.push(JSON.parse(gunzipSync(body).toString("utf8")));
        res.writeHead(201).end();
        return;
      }
      const asset = req.url?.match(/^\/api\/v1\/replay\/assets\/([0-9a-f]{64})$/);
      if (asset && req.method === "HEAD") { res.writeHead(received.assets.has(asset[1]!) ? 200 : 404).end(); return; }
      if (asset && req.method === "PUT") {
        received.assets.set(asset[1]!, { mediaType: String(req.headers["content-type"]), data: body });
        res.writeHead(201).end();
        return;
      }
      res.writeHead(404).end();
    });
  });
  site = createServer((req, res) => {
    if (req.url === "/logo.png") { res.writeHead(200, { "Content-Type": "image/png" }).end(PNG); return; }
    if (req.url === "/font.woff2") { res.writeHead(200, { "Content-Type": "font/woff2" }).end(FONT); return; }
    res.writeHead(200, { "Content-Type": "text/html" }).end(`<!doctype html><html><head><title>Shop</title>
<style>@font-face { font-family: Shop; src: url(/font.woff2) format("woff2"); } body { font-family: Shop, sans-serif; }</style></head>
<body><h1>Checkout page ${req.url}</h1><img src="/logo.png" width="20" height="20" alt="">
<input id="name" placeholder="Name"><button id="buy" onclick="document.querySelector('#out').textContent='Bought it'">Buy now</button><p id="out"></p></body></html>`);
  });
  const costkeyPort = await listen(costkey);
  sitePort = await listen(site);
  setTraceGetter(() => trace);
  await init({ dsn: `http://key_test@127.0.0.1:${costkeyPort}/proj_test` });
  setTraceGetter(() => trace); // init looks for the costkey SDK; keep the test's getter
});

afterAll(async () => {
  await new Promise((resolve) => costkey?.close(resolve));
  await new Promise((resolve) => site?.close(resolve));
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const allEvents = (traceId?: string) => received.chunks.filter((chunk) => !traceId || chunk.traceId === traceId).sort((a, b) => a.seq - b.seq).flatMap((chunk) => chunk.events);
const actions = (traceId: string) => allEvents(traceId).filter((event) => event.type === 5 && event.data?.tag === "costkey.action").map((event) => event.data.payload);

describe.skipIf(!executablePath)("recording a real browser", () => {
  it("Playwright: records the page, the agent's actions and assets, split by run", async () => {
    const browser = await chromium.launch({ executablePath: executablePath!, headless: true });
    try {
      trace = "trace_pw_1";
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${sitePort}/pw`);
      await page.locator("#name").fill(SECRET);
      await page.click("#buy");
      await wait(1200);
      trace = "trace_pw_2";
      await page.mouse.click(5, 5);
      await page.keyboard.press("Tab");
      await wait(1200);
      await flush();
    } finally {
      await browser.close();
    }

    const first = allEvents("trace_pw_1");
    const second = allEvents("trace_pw_2");
    expect(first.some((event) => event.type === 2)).toBe(true);
    expect(JSON.stringify(first)).toContain("Checkout page /pw");
    expect(JSON.stringify(first)).toContain("Bought it");
    // The second run starts from a full snapshot of its own.
    expect(second.findIndex((event) => event.type === 2)).toBeGreaterThanOrEqual(0);
    expect(actions("trace_pw_1")).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "page.goto", url: `http://127.0.0.1:${sitePort}/pw` }),
      expect.objectContaining({ name: "locator.fill", selector: "#name", textLength: SECRET.length }),
      expect.objectContaining({ name: "page.click", selector: "#buy" }),
    ]));
    expect(actions("trace_pw_2")).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "mouse.click", x: 5, y: 5 }),
      expect.objectContaining({ name: "keyboard.press", key: "Tab" }),
    ]));
    // Typed text never leaves the process.
    expect(JSON.stringify(received.chunks)).not.toContain(SECRET);
    // The image came from the agent's own browser, uploaded once by hash.
    const pngSha = createHash("sha256").update(PNG).digest("hex");
    expect(received.assets.get(pngSha)?.mediaType).toBe("image/png");
    expect(allEvents().some((event) => event.data?.tag === "costkey.asset" && event.data.payload.url.endsWith("/logo.png"))).toBe(true);
  }, 60_000);

  it.skipIf(!puppeteerModule)("Puppeteer: records pages from launch, tagged with the run", async () => {
    const puppeteer = puppeteerModule!.default;
    const before = received.chunks.length;
    trace = "trace_pp_1";
    const browser = await puppeteer.launch({ executablePath: executablePath!, headless: true, args: ["--no-sandbox"] });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${sitePort}/pp`);
      await page.type("#name", SECRET);
      await page.click("#buy");
      await wait(1200);
      await flush();
    } finally {
      await browser.close();
    }
    const chunks = received.chunks.slice(before).filter((chunk) => chunk.traceId === "trace_pp_1");
    const events = chunks.flatMap((chunk) => chunk.events);
    expect(events.some((event) => event.type === 2)).toBe(true);
    expect(JSON.stringify(events)).toContain("Checkout page /pp");
    expect(JSON.stringify(events)).toContain("Bought it");
    expect(actions("trace_pp_1")).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "page.goto" }),
      expect.objectContaining({ name: "page.type", selector: "#name", textLength: SECRET.length }),
      expect.objectContaining({ name: "page.click", selector: "#buy" }),
    ]));
    expect(JSON.stringify(received.chunks)).not.toContain(SECRET);
    expect(received.configReads).toBe(1);
  }, 60_000);
});
