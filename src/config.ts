import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export interface ParsedDsn {
  authKey: string;
  projectId: string;
  /** Scheme, host and any path CostKey is served under, without a trailing slash. */
  baseUrl: string;
}

/** `https://<key>@<host>[/<path>]/<project-id>`, the same DSN the core SDK takes. */
export function parseDsn(dsn: string): ParsedDsn {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    throw new Error(`[costkey-replay] Invalid DSN. Expected https://<key>@<host>/<project-id>, from Settings, Projects.`);
  }
  const authKey = decodeURIComponent(url.username);
  const segments = url.pathname.split("/").filter(Boolean);
  const projectId = segments.pop() ?? "";
  if (!authKey || !projectId) {
    throw new Error(`[costkey-replay] The DSN needs a key and a project ID: https://<key>@<host>/<project-id>.`);
  }
  const basePath = segments.length ? `/${segments.join("/")}` : "";
  return { authKey, projectId, baseUrl: `${url.protocol}//${url.host}${basePath}` };
}

export interface HttpResponse {
  status: number;
  body: string;
}

/**
 * A plain HTTP request on Node's own client. The core SDK patches `fetch`, so
 * the recorder stays off it: its uploads never show up as calls.
 */
export function send(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: Buffer,
  timeoutMs = 15_000,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const requester = target.protocol === "http:" ? httpRequest : httpsRequest;
    const req = requester(
      target,
      { method, headers: body ? { ...headers, "Content-Length": String(body.length) } : headers, timeout: timeoutMs },
      (res) => {
        const parts: Buffer[] = [];
        res.on("data", (part: Buffer) => parts.push(part));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (body) req.end(body);
    else req.end();
  });
}

/**
 * Whether the project allows screen recordings: the second half of the double
 * opt-in. Null when the server can't be reached, so the caller can retry.
 */
export async function fetchScreenCaptureEnabled(dsn: ParsedDsn): Promise<boolean | null> {
  try {
    const res = await send(
      "GET",
      `${dsn.baseUrl}/api/v1/projects/${encodeURIComponent(dsn.projectId)}/config`,
      { Authorization: `Bearer ${dsn.authKey}`, Accept: "application/json" },
    );
    if (res.status === 401 || res.status === 403 || res.status === 404) return false;
    if (res.status < 200 || res.status >= 300) return null;
    const config = JSON.parse(res.body) as { capture?: { screenCaptureEnabled?: unknown } };
    return config.capture?.screenCaptureEnabled === true;
  } catch {
    return null;
  }
}
