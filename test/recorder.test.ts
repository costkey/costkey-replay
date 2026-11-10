import { describe, expect, it, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { ACTION_TAG, ASSET_TAG, PageRecorder, compileBlockList, type CdpLike } from "../src/recorder.js";
import { BINDING_NAME, WORLD_NAME, injectedScript } from "../src/inject.js";
import { resetSafety } from "../src/safety.js";
import type { ReplayChunk, Uploader } from "../src/uploader.js";

class FakeCdp implements CdpLike {
  sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  handlers = new Map<string, Array<(params: any) => void>>();
  bodies = new Map<string, { body: string; base64Encoded: boolean }>();
  resourceTree: unknown = {};
  resourceContent = new Map<string, { content: string; base64Encoded: boolean }>();
  async send(method: string, params?: Record<string, unknown>): Promise<any> {
    this.sent.push({ method, params });
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-1" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
    if (method === "Page.getResourceTree") return this.resourceTree;
    if (method === "Page.getResourceContent") {
      const content = this.resourceContent.get(String(params?.url));
      if (!content) throw new Error("No resource with given URL found");
      return content;
    }
    if (method === "Network.getResponseBody") {
      const body = this.bodies.get(String(params?.requestId));
      if (!body) throw new Error("No resource with given identifier found");
      return body;
    }
    return {};
  }
  on(event: string, handler: (params: any) => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }
  emit(event: string, params: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(params);
  }
}

function fakeUploader() {
  const chunks: ReplayChunk[] = [];
  const assets: Array<{ sha256: string; mediaType: string; data: Buffer }> = [];
  const uploader = {
    stopped: false,
    enqueueChunk: (chunk: ReplayChunk) => chunks.push(chunk),
    enqueueAsset: (sha256: string, mediaType: string, data: Buffer) => assets.push({ sha256, mediaType, data }),
  } as unknown as Uploader;
  return { uploader, chunks, assets };
}

const batch = (href: string, events: unknown[]) => ({ name: BINDING_NAME, executionContextId: 7, payload: JSON.stringify({ href, events }) });
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("PageRecorder", () => {
  beforeEach(() => resetSafety());

  it("injects rrweb into an isolated world for new and current documents", async () => {
    const cdp = new FakeCdp();
    const { uploader } = fakeUploader();
    const recorder = new PageRecorder(cdp, { uploader, script: "/* rrweb */" });
    await recorder.start();
    recorder.stop();
    const methods = cdp.sent.map((call) => call.method);
    expect(methods).toEqual([
      "Runtime.enable",
      "Runtime.addBinding",
      "Page.enable",
      "Network.enable",
      "Page.addScriptToEvaluateOnNewDocument",
      "Page.getFrameTree",
      "Page.createIsolatedWorld",
      "Runtime.evaluate",
      "Page.getResourceTree",
    ]);
    expect(cdp.sent[1]!.params).toEqual({ name: BINDING_NAME, executionContextName: WORLD_NAME });
    expect(cdp.sent[4]!.params).toEqual({ source: "/* rrweb */", worldName: WORLD_NAME });
    expect(cdp.sent[6]!.params).toEqual({ frameId: "frame-1", worldName: WORLD_NAME });
    expect(cdp.sent[7]!.params).toEqual({ expression: "/* rrweb */", contextId: 7 });
  });

  it("chunks events in order, tagged with the run, and starts a new run from a snapshot", async () => {
    const cdp = new FakeCdp();
    const { uploader, chunks } = fakeUploader();
    const recorder = new PageRecorder(cdp, { uploader, script: "", traceId: "trace_a" });
    await recorder.start();
    cdp.emit("Runtime.bindingCalled", batch("https://shop.test/", [{ type: 4, timestamp: 1 }, { type: 2, timestamp: 2 }]));
    cdp.emit("Runtime.bindingCalled", { name: "somethingElse", payload: "{}" });
    recorder.addAction({ name: "locator.click", selector: "text=Buy", x: 10, y: 20 });
    recorder.setTrace("trace_b");
    await tick();
    cdp.emit("Runtime.bindingCalled", batch("https://shop.test/cart", [{ type: 4, timestamp: 3 }, { type: 2, timestamp: 4 }]));
    recorder.stop();

    expect(chunks.map((chunk) => [chunk.seq, chunk.traceId, chunk.events.length])).toEqual([[0, "trace_a", 3], [1, "trace_b", 2]]);
    expect(chunks[0]!.recordingId).toBe(chunks[1]!.recordingId);
    expect(chunks[0]!.events[2]).toMatchObject({ type: 5, data: { tag: ACTION_TAG, payload: { name: "locator.click", selector: "text=Buy" } } });
    // The run change asked the page for a full snapshot in our world.
    const snapshot = cdp.sent.find((call) => call.method === "Runtime.evaluate" && String(call.params?.expression).includes("snapshot"));
    expect(snapshot?.params?.contextId).toBe(7);
  });

  it("drops blocked pages and resumes from a snapshot", async () => {
    const cdp = new FakeCdp();
    const { uploader, chunks } = fakeUploader();
    const recorder = new PageRecorder(cdp, { uploader, script: "", blockUrls: compileBlockList(["*/billing/*"]) });
    await recorder.start();
    cdp.emit("Runtime.bindingCalled", batch("https://app.test/billing/cards", [{ type: 2, timestamp: 1 }]));
    recorder.addAction({ name: "page.click", selector: "#card" });
    cdp.emit("Runtime.bindingCalled", batch("https://app.test/home", [{ type: 3, timestamp: 2 }]));
    await tick();
    cdp.emit("Runtime.bindingCalled", batch("https://app.test/home", [{ type: 4, timestamp: 3 }, { type: 2, timestamp: 4 }]));
    recorder.stop();
    expect(chunks.flatMap((chunk) => chunk.events)).toEqual([{ type: 4, timestamp: 3 }, { type: 2, timestamp: 4 }]);
    expect(cdp.sent.some((call) => String(call.params?.expression ?? "").includes("snapshot"))).toBe(true);
  });

  it("caches images and fonts from the agent's browser, once per URL and body", async () => {
    const cdp = new FakeCdp();
    const { uploader, chunks, assets } = fakeUploader();
    const recorder = new PageRecorder(cdp, { uploader, script: "" });
    await recorder.start();
    const png = Buffer.from("89504e470d0a1a0a0000", "hex");
    cdp.bodies.set("r1", { body: png.toString("base64"), base64Encoded: true });
    cdp.emit("Network.responseReceived", { requestId: "r1", type: "Image", response: { url: "https://cdn.test/logo.png", status: 200, mimeType: "image/png" } });
    cdp.emit("Network.responseReceived", { requestId: "r2", type: "Script", response: { url: "https://cdn.test/app.js", status: 200, mimeType: "text/javascript" } });
    cdp.emit("Network.responseReceived", { requestId: "r3", type: "Image", response: { url: "https://cdn.test/gone.png", status: 200, mimeType: "image/png" } });
    cdp.emit("Network.loadingFinished", { requestId: "r1", encodedDataLength: png.length });
    cdp.emit("Network.loadingFinished", { requestId: "r2", encodedDataLength: 10 });
    cdp.emit("Network.loadingFinished", { requestId: "r3", encodedDataLength: 10 });
    await tick();
    // The same image loaded again doesn't add another reference.
    cdp.emit("Network.responseReceived", { requestId: "r4", type: "Image", response: { url: "https://cdn.test/logo.png", status: 200, mimeType: "image/png" } });
    cdp.bodies.set("r4", { body: png.toString("base64"), base64Encoded: true });
    cdp.emit("Network.loadingFinished", { requestId: "r4", encodedDataLength: png.length });
    await tick();
    recorder.stop();

    const sha256 = createHash("sha256").update(png).digest("hex");
    expect(assets).toEqual([{ sha256, mediaType: "image/png", data: png }]);
    expect(chunks.flatMap((chunk) => chunk.events)).toEqual([
      expect.objectContaining({ type: 5, data: { tag: ASSET_TAG, payload: { url: "https://cdn.test/logo.png", sha256, mediaType: "image/png" } } }),
    ]);
    expect(cdp.sent.filter((call) => call.method === "Network.getResponseBody").map((call) => call.params?.requestId)).toEqual(["r1", "r3", "r4"]);
  });

  it("caches images that loaded before it attached, from the resource tree", async () => {
    const cdp = new FakeCdp();
    const { uploader, assets } = fakeUploader();
    const font = Buffer.from("wOF2-font-bytes");
    cdp.resourceTree = {
      frameTree: {
        frame: { id: "main" },
        resources: [
          { url: "https://cdn.test/font.woff2", type: "Font", mimeType: "font/woff2" },
          { url: "https://cdn.test/app.js", type: "Script", mimeType: "text/javascript" },
          { url: "https://cdn.test/evicted.png", type: "Image", mimeType: "image/png" },
        ],
        childFrames: [{ frame: { id: "child" }, resources: [{ url: "data:image/png;base64,AAAA", type: "Image", mimeType: "image/png" }] }],
      },
    };
    cdp.resourceContent.set("https://cdn.test/font.woff2", { content: font.toString("base64"), base64Encoded: true });
    const recorder = new PageRecorder(cdp, { uploader, script: "" });
    await recorder.start();
    recorder.stop();
    expect(assets.map((asset) => [asset.mediaType, asset.data.toString()])).toEqual([["font/woff2", "wOF2-font-bytes"]]);
    expect(cdp.sent.filter((call) => call.method === "Page.getResourceContent").map((call) => call.params?.url)).toEqual([
      "https://cdn.test/font.woff2",
      "https://cdn.test/evicted.png",
    ]);
  });

  it("flushes early when a chunk gets big", async () => {
    const cdp = new FakeCdp();
    const { uploader, chunks } = fakeUploader();
    const recorder = new PageRecorder(cdp, { uploader, script: "", maxChunkBytes: 1000 });
    await recorder.start();
    const big = { type: 3, timestamp: 1, data: { text: "x".repeat(600) } };
    cdp.emit("Runtime.bindingCalled", batch("https://a.test/", [big]));
    cdp.emit("Runtime.bindingCalled", batch("https://a.test/", [big]));
    expect(chunks.map((chunk) => chunk.events.length)).toEqual([2]);
    cdp.emit("Runtime.bindingCalled", batch("https://a.test/", [{ type: 3, timestamp: 2 }]));
    recorder.stop();
    expect(chunks.map((chunk) => chunk.events.length)).toEqual([2, 1]);
  });

  it("a malformed batch turns recording off instead of throwing into the agent", async () => {
    const cdp = new FakeCdp();
    const { uploader, chunks } = fakeUploader();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const recorder = new PageRecorder(cdp, { uploader, script: "" });
    await recorder.start();
    expect(() => cdp.emit("Runtime.bindingCalled", { name: BINDING_NAME, payload: "{not json" })).not.toThrow();
    cdp.emit("Runtime.bindingCalled", batch("https://a.test/", [{ type: 2, timestamp: 1 }]));
    recorder.stop();
    expect(chunks).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("helpers", () => {
  it("compiles URL globs", () => {
    const [billing] = compileBlockList(["*/billing/*"]);
    expect(billing!.test("https://app.test/billing/cards")).toBe(true);
    expect(billing!.test("https://app.test/home")).toBe(false);
    const [exact] = compileBlockList(["https://accounts.test/*"]);
    expect(exact!.test("https://accounts.test/login?x=1")).toBe(true);
    expect(exact!.test("https://accounts.test.evil/x")).toBe(false);
  });

  it("guards the injected script so it runs once, in the top frame, with the binding", () => {
    const script = injectedScript("/*rrweb*/");
    expect(script.startsWith(`if (!globalThis.__ckReplay && window.top === window && typeof globalThis.${BINDING_NAME} === "function")`)).toBe(true);
    expect(script).toContain("maskAllInputs: true");
    expect(script).toContain("recordCanvas: false");
  });
});
