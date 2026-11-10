import { gzipSync } from "node:zlib";
import { send, type ParsedDsn, type HttpResponse } from "./config.js";
import { debug } from "./safety.js";

/** One upload of a page's recording: rrweb events, in order, tagged with the run. */
export interface ReplayChunk {
  recordingId: string;
  seq: number;
  traceId: string | null;
  events: unknown[];
}

interface QueuedChunk {
  kind: "chunk";
  body: Buffer;
  bytes: number;
  attempts: number;
}

interface QueuedAsset {
  kind: "asset";
  sha256: string;
  mediaType: string;
  data: Buffer;
  bytes: number;
  attempts: number;
}

type Job = QueuedChunk | QueuedAsset;

export interface UploaderOptions {
  /** Upper bound on bytes waiting to upload. Assets are dropped first, then new chunks. */
  maxQueueBytes?: number;
  /** Called once when the server says recordings can't be accepted (setting off, bad key, no support). */
  onRejected?: (reason: string) => void;
  /** Swappable for tests. */
  request?: (method: string, url: string, headers: Record<string, string>, body?: Buffer) => Promise<HttpResponse>;
}

const DEFAULT_MAX_QUEUE_BYTES = 64 * 1024 * 1024;
const MAX_ATTEMPTS = 4;
/** Hashes this process already uploaded or found on the server. */
const MAX_REMEMBERED_ASSETS = 8192;

/**
 * Sends chunks and assets in the background, one request at a time, so a slow
 * or unreachable server costs memory up to a bound and never time on the
 * agent's side.
 */
export class Uploader {
  private readonly queue: Job[] = [];
  private queuedBytes = 0;
  private readonly knownAssets = new Set<string>();
  private pumping: Promise<void> | null = null;
  private rejected = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private readonly maxQueueBytes: number;
  private readonly request: NonNullable<UploaderOptions["request"]>;

  constructor(private readonly dsn: ParsedDsn, private readonly options: UploaderOptions = {}) {
    this.maxQueueBytes = options.maxQueueBytes ?? DEFAULT_MAX_QUEUE_BYTES;
    this.request = options.request ?? ((method, url, headers, body) => send(method, url, headers, body));
  }

  get stopped(): boolean {
    return this.rejected;
  }

  enqueueChunk(chunk: ReplayChunk): void {
    if (this.rejected || chunk.events.length === 0) return;
    const body = gzipSync(Buffer.from(JSON.stringify(chunk)));
    if (!this.makeRoom(body.length)) {
      debug(`dropped chunk ${chunk.recordingId}#${chunk.seq}: upload queue full`);
      return;
    }
    this.push({ kind: "chunk", body, bytes: body.length, attempts: 0 });
  }

  /** Queue an asset once per process; the server skips it if the project has it already. */
  enqueueAsset(sha256: string, mediaType: string, data: Buffer): void {
    if (this.rejected || this.knownAssets.has(sha256)) return;
    this.remember(sha256);
    if (this.queuedBytes + data.length > this.maxQueueBytes) {
      this.knownAssets.delete(sha256);
      debug(`dropped asset ${sha256}: upload queue full`);
      return;
    }
    this.push({ kind: "asset", sha256, mediaType, data, bytes: data.length, attempts: 0 });
  }

  /** Resolves once everything queued so far has been sent or given up on. */
  async flush(): Promise<void> {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    while (this.queue.length > 0 && !this.rejected) {
      await this.pump();
      if (this.retryTimer) {
        // Everything left is waiting on a retry: try once more now, then stop.
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
        await this.pump(true);
        break;
      }
    }
  }

  private push(job: Job): void {
    this.queue.push(job);
    this.queuedBytes += job.bytes;
    void this.pump();
  }

  /** Free space by dropping queued assets (cheapest to lose) before refusing new data. */
  private makeRoom(bytes: number): boolean {
    if (this.queuedBytes + bytes <= this.maxQueueBytes) return true;
    for (let i = this.queue.length - 1; i >= 0 && this.queuedBytes + bytes > this.maxQueueBytes; i--) {
      const job = this.queue[i]!;
      if (job.kind === "asset") {
        this.queue.splice(i, 1);
        this.queuedBytes -= job.bytes;
        this.knownAssets.delete(job.sha256);
      }
    }
    return this.queuedBytes + bytes <= this.maxQueueBytes;
  }

  private remember(sha256: string): void {
    if (this.knownAssets.size >= MAX_REMEMBERED_ASSETS) {
      const oldest = this.knownAssets.values().next().value;
      if (oldest !== undefined) this.knownAssets.delete(oldest);
    }
    this.knownAssets.add(sha256);
  }

  private pump(final = false): Promise<void> {
    if (this.pumping) return this.pumping;
    // `.finally` runs on a later tick, after the assignment, even when there's nothing to send.
    const pumping = this.drain(final).finally(() => {
      if (this.pumping === pumping) this.pumping = null;
    });
    this.pumping = pumping;
    return pumping;
  }

  private async drain(final: boolean): Promise<void> {
    while (this.queue.length > 0 && !this.rejected) {
      const job = this.queue[0]!;
      const outcome = await this.sendJob(job);
      if (outcome === "retry" && !final && job.attempts < MAX_ATTEMPTS) {
        job.attempts++;
        this.scheduleRetry(job.attempts);
        return;
      }
      this.queue.shift();
      this.queuedBytes -= job.bytes;
      if (outcome !== "done" && job.kind === "asset") this.knownAssets.delete(job.sha256);
    }
  }

  private scheduleRetry(attempt: number): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.pump();
    }, Math.min(30_000, 1000 * 2 ** attempt));
    this.retryTimer.unref?.();
  }

  private headers(extra: Record<string, string>): Record<string, string> {
    return { Authorization: `Bearer ${this.dsn.authKey}`, "User-Agent": "costkey-replay-node", ...extra };
  }

  private async sendJob(job: Job): Promise<"done" | "retry" | "drop"> {
    try {
      if (job.kind === "chunk") {
        const res = await this.request(
          "POST",
          `${this.dsn.baseUrl}/api/v1/replay/chunks`,
          this.headers({ "Content-Type": "application/json", "Content-Encoding": "gzip" }),
          job.body,
        );
        return this.outcome(res, "chunk");
      }
      const url = `${this.dsn.baseUrl}/api/v1/replay/assets/${job.sha256}`;
      const head = await this.request("HEAD", url, this.headers({}));
      if (head.status === 200) return "done";
      if (head.status !== 404) return this.outcome(head, "asset");
      const res = await this.request("PUT", url, this.headers({ "Content-Type": job.mediaType }), job.data);
      return this.outcome(res, "asset");
    } catch (error) {
      debug(`upload failed, will retry`, error instanceof Error ? error.message : error);
      return "retry";
    }
  }

  private outcome(res: HttpResponse, what: string): "done" | "retry" | "drop" {
    if (res.status >= 200 && res.status < 300) return "done";
    if (res.status === 422) return this.reject("screen recordings are off for this project");
    if (res.status === 401 || res.status === 403) return this.reject("the DSN was rejected");
    if (res.status === 404 || res.status === 405 || res.status === 501) return this.reject("this CostKey server doesn't accept replays yet");
    if (res.status === 429 || res.status >= 500) return "retry";
    debug(`server refused ${what} (${res.status}): ${res.body.slice(0, 200)}`);
    return "drop";
  }

  private reject(reason: string): "drop" {
    if (!this.rejected) {
      this.rejected = true;
      this.queue.length = 0;
      this.queuedBytes = 0;
      this.options.onRejected?.(reason);
    }
    return "drop";
  }
}
