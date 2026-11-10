import { describe, expect, it } from "vitest";
import { gunzipSync } from "node:zlib";
import { Uploader, type ReplayChunk } from "../src/uploader.js";
import { parseDsn } from "../src/config.js";

type Call = { method: string; url: string; headers: Record<string, string>; body?: Buffer };

function fakeServer(respond: (call: Call) => number) {
  const calls: Call[] = [];
  const request = async (method: string, url: string, headers: Record<string, string>, body?: Buffer) => {
    const call = { method, url, headers, body };
    calls.push(call);
    return { status: respond(call), body: "" };
  };
  return { calls, request };
}

const dsn = parseDsn("http://key_123@localhost:4110/costkey/proj_1");
const chunk = (seq: number): ReplayChunk => ({ recordingId: "rec", seq, traceId: "trace_1", events: [{ type: 2, timestamp: seq }] });

describe("Uploader", () => {
  it("parses a DSN with a base path", () => {
    expect(dsn).toEqual({ authKey: "key_123", projectId: "proj_1", baseUrl: "http://localhost:4110/costkey" });
  });

  it("posts gzipped chunks with the DSN key", async () => {
    const server = fakeServer(() => 201);
    const uploader = new Uploader(dsn, { request: server.request });
    uploader.enqueueChunk(chunk(0));
    uploader.enqueueChunk(chunk(1));
    await uploader.flush();
    expect(server.calls.map((call) => [call.method, call.url])).toEqual([
      ["POST", "http://localhost:4110/costkey/api/v1/replay/chunks"],
      ["POST", "http://localhost:4110/costkey/api/v1/replay/chunks"],
    ]);
    expect(server.calls[0]!.headers).toMatchObject({ Authorization: "Bearer key_123", "Content-Encoding": "gzip" });
    expect(JSON.parse(gunzipSync(server.calls[1]!.body!).toString())).toEqual(chunk(1));
  });

  it("uploads an asset once: skipped when the project has it, PUT when it doesn't", async () => {
    const server = fakeServer((call) => (call.method === "HEAD" ? (call.url.endsWith("aa".repeat(32)) ? 200 : 404) : 201));
    const uploader = new Uploader(dsn, { request: server.request });
    uploader.enqueueAsset("aa".repeat(32), "image/png", Buffer.from("a"));
    uploader.enqueueAsset("bb".repeat(32), "font/woff2", Buffer.from("b"));
    uploader.enqueueAsset("bb".repeat(32), "font/woff2", Buffer.from("b"));
    await uploader.flush();
    expect(server.calls.map((call) => `${call.method} ${call.url.slice(-6)}`)).toEqual(["HEAD aaaaaa", "HEAD bbbbbb", "PUT bbbbbb"]);
    expect(server.calls[2]!.headers["Content-Type"]).toBe("font/woff2");
  });

  it("stops for good when the project has recordings off", async () => {
    const reasons: string[] = [];
    const server = fakeServer(() => 422);
    const uploader = new Uploader(dsn, { request: server.request, onRejected: (reason) => reasons.push(reason) });
    uploader.enqueueChunk(chunk(0));
    uploader.enqueueChunk(chunk(1));
    await uploader.flush();
    uploader.enqueueChunk(chunk(2));
    await uploader.flush();
    expect(server.calls.length).toBe(1);
    expect(reasons).toEqual(["screen recordings are off for this project"]);
    expect(uploader.stopped).toBe(true);
  });

  it("retries a server error, and flush gives up after one more try", async () => {
    let failures = 1;
    const server = fakeServer(() => (failures-- > 0 ? 503 : 201));
    const uploader = new Uploader(dsn, { request: server.request });
    uploader.enqueueChunk(chunk(0));
    await uploader.flush();
    expect(server.calls.length).toBe(2);
  });

  it("keeps memory bounded: drops queued assets first, then refuses chunks", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    const uploader = new Uploader(dsn, {
      maxQueueBytes: 400,
      request: async (method, url) => { calls.push(`${method} ${url.slice(-5)}`); await gate; return { status: method === "HEAD" ? 404 : 201, body: "" }; },
    });
    uploader.enqueueChunk(chunk(0)); // in flight
    uploader.enqueueAsset("cc".repeat(32), "image/png", Buffer.alloc(300));
    uploader.enqueueChunk({ ...chunk(1), events: [{ type: 3, data: "y".repeat(2000) }] }); // compresses small: fits once the asset goes
    release();
    await uploader.flush();
    expect(calls.filter((call) => call.startsWith("POST")).length).toBe(2);
    expect(calls.some((call) => call.startsWith("PUT"))).toBe(false);
  });
});
