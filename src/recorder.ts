import { createHash, randomUUID } from "node:crypto";
import { BINDING_NAME, WORLD_NAME, injectedScript } from "./inject.js";
import { debug, guard, isDisabled } from "./safety.js";
import { detached } from "./scope.js";
import type { Uploader } from "./uploader.js";

/**
 * The slice of a CDP session the recorder needs. Playwright's and Puppeteer's
 * CDPSession both fit; the recorder always gets its own session on the page,
 * so the agent's session never sees our commands or events.
 */
export interface CdpLike {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  on(event: string, handler: (params: any) => void): unknown;
  detach?(): Promise<unknown>;
}

/** An agent action noted from the automation library, kept in the replay as a custom event. */
export interface AgentAction {
  name: string;
  selector?: string;
  url?: string;
  x?: number;
  y?: number;
  key?: string;
  button?: string;
  /** Typed text is never kept, only how long it was. */
  textLength?: number;
}

export interface RecorderOptions {
  uploader: Uploader;
  /** Pages whose URL matches are not recorded (glob patterns turned into RegExps). */
  blockUrls?: RegExp[];
  traceId?: string | null;
  /** Flush at least this often. */
  flushIntervalMs?: number;
  /** Flush early once a chunk holds this many bytes of events. */
  maxChunkBytes?: number;
  /** Total image and font bytes taken from one page. */
  maxAssetBytes?: number;
  /** Tests inject the script. */
  script?: string;
}

interface ResourceFrame {
  frame?: { id?: string };
  resources?: Array<{ url?: string; type?: string; mimeType?: string; failed?: boolean }>;
  childFrames?: ResourceFrame[];
}

/** rrweb custom event tags the console understands. */
export const ACTION_TAG = "costkey.action";
export const ASSET_TAG = "costkey.asset";

const RRWEB_CUSTOM = 5;
const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const ASSET_TYPES = new Set(["Image", "Font"]);
const ASSET_MEDIA = /^(image\/(png|jpeg|gif|webp|avif|svg\+xml|x-icon|vnd\.microsoft\.icon)|font\/(woff2?|ttf|otf|sfnt)|application\/(font-woff2?|x-font-(woff|ttf|otf)|vnd\.ms-fontobject))$/;

/** One page's recording: our own CDP session, rrweb in an isolated world, chunks to the uploader. */
export class PageRecorder {
  readonly recordingId = randomUUID();
  traceId: string | null;
  private events: unknown[] = [];
  private bytes = 0;
  private seq = 0;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private blocked = false;
  private contextId: number | null = null;
  private assetBytes = 0;
  private readonly pendingAssets = new Map<string, { url: string; mediaType: string }>();
  private readonly assetRefs = new Set<string>();
  private readonly blockUrls: RegExp[];
  private readonly maxChunkBytes: number;
  private readonly maxAssetBytes: number;

  constructor(private readonly cdp: CdpLike, private readonly options: RecorderOptions) {
    this.traceId = options.traceId ?? null;
    this.blockUrls = options.blockUrls ?? [];
    this.maxChunkBytes = options.maxChunkBytes ?? 1024 * 1024;
    this.maxAssetBytes = options.maxAssetBytes ?? 50 * 1024 * 1024;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  /** Inject the recorder into new documents and the one already loaded. Throws if the page went away. */
  async start(): Promise<void> {
    const { cdp } = this;
    cdp.on("Runtime.bindingCalled", (event) => guard(() => this.onBinding(event)));
    cdp.on("Network.responseReceived", (event) => guard(() => this.onResponse(event)));
    cdp.on("Network.loadingFinished", (event) => guard(() => this.onLoaded(event)));
    cdp.on("Network.loadingFailed", (event) => guard(() => this.pendingAssets.delete(String(event?.requestId))));

    const script = this.options.script ?? injectedScript();
    await cdp.send("Runtime.enable");
    await cdp.send("Runtime.addBinding", { name: BINDING_NAME, executionContextName: WORLD_NAME });
    await cdp.send("Page.enable");
    await cdp.send("Network.enable", { maxResourceBufferSize: 4 * 1024 * 1024, maxTotalBufferSize: 32 * 1024 * 1024 });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: script, worldName: WORLD_NAME });

    // The document already showing when we attached.
    const tree = await cdp.send("Page.getFrameTree");
    const frameId = tree?.frameTree?.frame?.id;
    if (typeof frameId === "string") {
      try {
        const world = await cdp.send("Page.createIsolatedWorld", { frameId, worldName: WORLD_NAME });
        await cdp.send("Runtime.evaluate", { expression: script, contextId: world.executionContextId });
      } catch (error) {
        // It navigated meanwhile; the new document gets the script anyway.
        debug("couldn't record the current document", error instanceof Error ? error.message : error);
      }
    }

    this.timer = setInterval(() => guard(() => this.flush()), this.options.flushIntervalMs ?? 2000);
    this.timer.unref?.();
    await this.cacheLoadedAssets();
  }

  /**
   * Images and fonts that finished loading before our Network events were on
   * (the agent usually navigates right after opening the page) are still in
   * the page's resource tree; read them from there.
   */
  private async cacheLoadedAssets(): Promise<void> {
    let tree: { frameTree?: ResourceFrame } | undefined;
    try {
      tree = await this.cdp.send("Page.getResourceTree");
    } catch {
      return;
    }
    const wanted: Array<{ frameId: string; url: string; mediaType: string }> = [];
    const walk = (node: ResourceFrame | undefined) => {
      if (!node?.frame?.id) return;
      for (const resource of node.resources ?? []) {
        const mediaType = String(resource.mimeType ?? "").toLowerCase();
        if (ASSET_TYPES.has(String(resource.type)) && /^https?:\/\//.test(String(resource.url)) && ASSET_MEDIA.test(mediaType) && !resource.failed) {
          wanted.push({ frameId: node.frame.id, url: String(resource.url), mediaType });
        }
      }
      for (const child of node.childFrames ?? []) walk(child);
    };
    walk(tree?.frameTree);
    for (const asset of wanted.slice(0, 200)) {
      if (this.stopped || this.assetBytes >= this.maxAssetBytes) return;
      try {
        const content = await this.cdp.send("Page.getResourceContent", { frameId: asset.frameId, url: asset.url });
        guard(() => this.keepAsset(asset, { body: content?.content, base64Encoded: content?.base64Encoded }));
      } catch {
        // Gone from the cache: blank in the replay.
      }
    }
  }

  /** A later action ran under another run: close this run's chunk and start the next with a full snapshot. */
  setTrace(traceId: string | null): void {
    if (!traceId || traceId === this.traceId || this.stopped) return;
    this.flush();
    this.traceId = traceId;
    this.requestSnapshot();
  }

  addAction(action: AgentAction, at = Date.now()): void {
    if (this.stopped || this.blocked) return;
    this.push({ type: RRWEB_CUSTOM, timestamp: at, data: { tag: ACTION_TAG, payload: action } });
  }

  /** Send what's buffered as the next chunk. */
  flush(): void {
    if (this.events.length === 0) return;
    const events = this.events;
    this.events = [];
    this.bytes = 0;
    this.options.uploader.enqueueChunk({ recordingId: this.recordingId, seq: this.seq++, traceId: this.traceId, events });
  }

  stop(): void {
    if (this.stopped) return;
    this.flush();
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private push(event: unknown, size = 200): void {
    this.events.push(event);
    this.bytes += size;
    if (this.bytes >= this.maxChunkBytes) this.flush();
  }

  private requestSnapshot(): void {
    if (this.contextId === null) return;
    const contextId = this.contextId;
    detached(() => void this.cdp
      .send("Runtime.evaluate", { expression: "globalThis.__ckReplay && globalThis.__ckReplay.snapshot && globalThis.__ckReplay.snapshot()", contextId })
      .catch(() => undefined));
  }

  private onBinding(event: { name?: string; payload?: string; executionContextId?: number }): void {
    if (event?.name !== BINDING_NAME || this.stopped || isDisabled()) return;
    if (typeof event.executionContextId === "number") this.contextId = event.executionContextId;
    const payload = typeof event.payload === "string" ? event.payload : "";
    const batch = JSON.parse(payload) as { href?: unknown; events?: unknown };
    const href = typeof batch.href === "string" ? batch.href : "";
    if (this.blockUrls.some((pattern) => pattern.test(href))) {
      this.blocked = true;
      return;
    }
    if (this.blocked) {
      // Left a blocked page without a new document: start again from a snapshot.
      this.blocked = false;
      this.requestSnapshot();
      return;
    }
    if (!Array.isArray(batch.events)) return;
    const share = Math.ceil(payload.length / Math.max(1, batch.events.length));
    for (const item of batch.events) this.push(item, share);
  }

  private onResponse(event: { requestId?: string; type?: string; response?: { url?: string; status?: number; mimeType?: string } }): void {
    if (this.stopped || !event?.requestId || !ASSET_TYPES.has(String(event.type))) return;
    const url = String(event.response?.url ?? "");
    const mediaType = String(event.response?.mimeType ?? "").split(";")[0]!.trim().toLowerCase();
    if (event.response?.status !== 200 || !/^https?:\/\//.test(url) || !ASSET_MEDIA.test(mediaType)) return;
    if (this.blocked || this.assetBytes >= this.maxAssetBytes) return;
    this.pendingAssets.set(event.requestId, { url, mediaType });
  }

  private onLoaded(event: { requestId?: string; encodedDataLength?: number }): void {
    const requestId = String(event?.requestId ?? "");
    const pending = this.pendingAssets.get(requestId);
    if (!pending) return;
    this.pendingAssets.delete(requestId);
    if ((event.encodedDataLength ?? 0) > MAX_ASSET_BYTES * 2) return;
    this.cdp
      .send("Network.getResponseBody", { requestId })
      .then((result: { body?: string; base64Encoded?: boolean }) => guard(() => this.keepAsset(pending, result)))
      .catch(() => undefined); // Evicted already: that spot shows blank in the replay.
  }

  private keepAsset(asset: { url: string; mediaType: string }, result: { body?: string; base64Encoded?: boolean }): void {
    if (this.stopped || typeof result?.body !== "string") return;
    const data = result.base64Encoded ? Buffer.from(result.body, "base64") : Buffer.from(result.body, "utf8");
    if (data.length === 0 || data.length > MAX_ASSET_BYTES || this.assetBytes + data.length > this.maxAssetBytes) return;
    const sha256 = createHash("sha256").update(data).digest("hex");
    const ref = `${asset.url} ${sha256}`;
    if (this.assetRefs.has(ref)) return;
    this.assetRefs.add(ref);
    this.assetBytes += data.length;
    this.options.uploader.enqueueAsset(sha256, asset.mediaType, data);
    this.push({ type: RRWEB_CUSTOM, timestamp: Date.now(), data: { tag: ASSET_TAG, payload: { url: asset.url, sha256, mediaType: asset.mediaType } } });
  }
}

/** `["*\/billing/*"]` → RegExps matched against the whole URL. */
export function compileBlockList(patterns: readonly string[] | undefined): RegExp[] {
  return (patterns ?? [])
    .filter((pattern) => typeof pattern === "string" && pattern.length > 0)
    .map((pattern) => new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`));
}
