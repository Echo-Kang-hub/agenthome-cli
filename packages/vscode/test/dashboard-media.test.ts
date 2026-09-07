import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const media = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "media", "dashboard");

test("html has no remote resources and carries CSP nonce placeholder", async () => {
  const html = await readFile(path.join(media, "view.html"), "utf8");
  assert.ok(!/https?:\/\//.test(html)); // 无远程
  assert.match(html, /nonce="[^"]+"/);
  assert.match(html, /content-security-policy/i);
});

test("render code never assigns user data via innerHTML", async () => {
  const js = await readFile(path.join(media, "main.js"), "utf8");
  assert.ok(!/\.innerHTML\s*=/.test(js));
  assert.ok(/textContent/.test(js));
});

test("style uses vscode theme variables and codicon font", async () => {
  const css = await readFile(path.join(media, "style.css"), "utf8");
  assert.ok(/--vscode-/.test(css));
  assert.match(css, /codicon/);
});
