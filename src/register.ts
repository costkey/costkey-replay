/**
 * `node --import @costkey/replay/register app.js` (or `--require`): start
 * recording without code changes. Reads `COSTKEY_DSN`, and optionally
 * `COSTKEY_REPLAY_BLOCK_URLS` (comma-separated URL globs) and
 * `COSTKEY_REPLAY_DEBUG=true`.
 */
import { init } from "./index.js";

void init({
  blockUrls: (process.env["COSTKEY_REPLAY_BLOCK_URLS"] ?? "").split(",").map((pattern) => pattern.trim()).filter(Boolean),
  debug: process.env["COSTKEY_REPLAY_DEBUG"] === "true",
});
