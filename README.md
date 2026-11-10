# @costkey/replay

Session replay for browser agents. Watch what your agent did on each page, as smooth video, lined up with the LLM call that chose each action and what the run had cost by then.

```bash
npm install @costkey/replay
```

```ts
import { CostKey } from "costkey";
import { CostKeyReplay } from "@costkey/replay";
import { chromium } from "playwright";

CostKey.init({ dsn: process.env.COSTKEY_DSN });
await CostKeyReplay.init(); // same DSN, from COSTKEY_DSN

await CostKey.startTrace({ name: "checkout-agent" }, async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  // ...your agent, unchanged
});
```

Or with no code changes:

```bash
COSTKEY_DSN=... node --import @costkey/replay/register agent.js
```

## How it works

There's nothing to wrap. `@costkey/replay` hooks the Playwright or Puppeteer your app already uses, the same way the `costkey` SDK hooks `fetch`:

- **Every Chromium page gets an rrweb recording.** The recorder runs on its own CDP session, in an isolated world. The page's scripts can't see it, the page's CSP doesn't apply to it, and the page never makes a request for it. Events come back over CDP and upload in the background.
- **The agent's actions are kept**, for example `locator.click("#buy")`, `page.goto(url)` or `mouse.click(412, 230)`, with their selectors, URLs and coordinates. Typed text is never kept, only its length. rrweb masks every input field.
- **Images and fonts** come from the agent's own browser over CDP. That includes pages behind a login. Each one is uploaded once per project, so a replay never loads anything from the original site.
- **Runs:** each page is tied to the CostKey run (trace) its actions happen in. When the same page moves to another run, the recording starts that run from a fresh snapshot.

## Privacy

Recording is off until **both** sides opt in:

1. Your app calls `CostKeyReplay.init()` or uses the register hook.
2. An admin turns on **Screen recordings** for the project, under Settings → Privacy & data. While it's off, nothing is recorded or sent.

Keep pages out of recordings with URL patterns:

```ts
await CostKeyReplay.init({ blockUrls: ["*/billing/*", "https://accounts.example.com/*"] });
```

The register hook reads the same patterns from `COSTKEY_REPLAY_BLOCK_URLS`, comma-separated.

Replays follow the project's body retention and are only visible to members who can read captured content.

## Safety

The recorder runs inside your agent's process, so:

- It never makes the agent wait. Copying is cheap and uploads happen in the background, with bounded memory.
- Any unexpected error switches recording off for the rest of the process, logs one warning and leaves the agent alone.
- If the server says recordings are off, or the DSN is wrong, it stops for good.

Call `await CostKeyReplay.flush()` before a short-lived script exits.

## Supported

| | |
|---|---|
| Playwright (Node) | 1.40 and later, Chromium (`launch`, `launchPersistentContext`, `connectOverCDP`) |
| Puppeteer | 22 and later (`launch`, `connect`) |
| Node | 20 and later |

Not yet: Playwright from Python, Java or .NET, Firefox and WebKit, and desktop (VNC) recording.

## Options

| Option | Default | |
|---|---|---|
| `dsn` | `COSTKEY_DSN` | Your project's DSN |
| `blockUrls` | `[]` | URL globs never recorded |
| `debug` | `false` | Log what the recorder skips |
