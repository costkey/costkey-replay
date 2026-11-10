#!/usr/bin/env node
/**
 * Copy rrweb's recorder bundle into dist/vendor so the published package has
 * no runtime dependencies. The bundle is injected into the agent's pages as
 * text; it never runs in Node.
 */
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const entry = require.resolve("@rrweb/record");
const bundle = join(dirname(entry), "record.umd.min.cjs");
const out = join(root, "dist", "vendor");
await mkdir(out, { recursive: true });
await copyFile(bundle, join(out, "rrweb-record.min.js"));

const rrwebPackage = JSON.parse(await readFile(join(dirname(entry), "..", "package.json"), "utf8"));
await writeFile(
  join(out, "THIRD_PARTY_NOTICES.txt"),
  `dist/vendor/rrweb-record.min.js is @rrweb/record ${rrwebPackage.version} (https://github.com/rrweb-io/rrweb), under the following license:

MIT License

Copyright (c) 2018 Contributors (https://github.com/rrweb-io/rrweb/graphs/contributors) and SmartX Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`,
);
console.log(`vendored @rrweb/record ${rrwebPackage.version}`);
