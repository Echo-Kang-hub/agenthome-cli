import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const media = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "media", "dashboard");

test("html has no remote resources, carries CSP nonce placeholder and allows local font", async () => {
  const html = await readFile(path.join(media, "view.html"), "utf8");
  assert.ok(!/https?:\/\//.test(html)); // 无远程
  assert.match(html, /nonce="[^"]+"/);
  assert.match(html, /content-security-policy/i);
  assert.match(html, /font-src\s+\{\{cspSource\}\}/); // 随包 codicon.ttf 需 font-src 放行
});

test("render code never assigns user data via innerHTML", async () => {
  const js = await readFile(path.join(media, "main.js"), "utf8");
  assert.ok(!/\.innerHTML\s*=/.test(js));
  assert.ok(/textContent/.test(js));
});

test("style uses vscode theme variables and bundles the codicon font locally", async () => {
  const css = await readFile(path.join(media, "style.css"), "utf8");
  assert.ok(/--vscode-/.test(css));
  assert.match(css, /@font-face/);
  assert.match(css, /url\("\.\/codicon\.ttf"\)/); // 随包字体，不请求远程
  // 回归：不依赖 VS Code 注入 --vscode-icon-*（并非真实机制 → 图标恒不可见 → 按钮文字被挤偏）
  assert.ok(!css.includes("var(--vscode-icon-"), "不得再引用不存在的外部注入图标变量");
  await access(path.join(media, "codicon.ttf"));
});

test("compressed dashboard keeps agent identity via inline SVG marks", async () => {
  const js = await readFile(path.join(media, "main.js"), "utf8");
  const css = await readFile(path.join(media, "style.css"), "utf8");
  // 品牌标记：inline SVG（createElementNS），无远程资源、不经 innerHTML
  assert.match(js, /createElementNS/);
  assert.match(js, /agentMark/);
  assert.ok(js.includes('agentId === "claude"'));
  assert.ok(js.includes('agentId === "codex"'));
  assert.ok(!/\.innerHTML\s*=/.test(js)); // 品牌标记同样不经 innerHTML
  // 响应式分层：中等与最终压缩态都以媒体查询驱动，最终态隐藏 agent 文字
  assert.match(css, /@media\s*\(max-width: 600px\)/);
  assert.match(css, /@media\s*\(max-width: 430px\)/);
  assert.match(css, /\.agent-mark/);
  assert.match(css, /\.agent-name\s*\{\s*display:\s*none/);
});

test("every icon name used by main.js has a style.css glyph mapping", async () => {
  const js = await readFile(path.join(media, "main.js"), "utf8");
  const css = await readFile(path.join(media, "style.css"), "utf8");
  const names = new Set<string>();
  for (const m of js.matchAll(/icon\(\s*"([a-z][a-z0-9-]*)"|iconName:\s*"([a-z][a-z0-9-]*)"|"([a-z][a-z0-9-]*)":\s*"([a-z][a-z0-9-]*)"/g)) {
    names.add(m[1] ?? m[2] ?? m[4]!);
  }
  assert.ok(names.size > 0);
  for (const name of names) {
    assert.ok(
      css.includes(`.icon[data-icon="${name}"]::before`),
      `缺少图标字形映射：data-icon="${name}"`,
    );
  }
});
