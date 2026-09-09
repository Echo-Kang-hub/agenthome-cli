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
  // 品牌标记来自官方标记路径数据（LobeHub 官方静态图标库）：
  // codex=六边形环结（CODEX_D 常量）、opencode=回字方框（外框镂空 + 偏下内块）
  assert.match(js, /const CODEX_D = "M8\.086\.457/);
  assert.match(js, /M2 2h20v20H2V2zm5 5h10v10H7V7z/);
  // 连字符属性（fill-rule 等）经 setAttribute 写入——避免被图标名映射正则误捕获
  assert.match(js, /setAttribute\("fill-rule", "evenodd"\)/);
  // 内容驱动的降级：agent 卡片容器查询按自身宽度隐藏文字，视口 @media 不含 agent 规则
  // （600/430 视口断点会在文字仍放得下时提前隐藏——用户反馈的缺陷，已废弃）
  assert.match(css, /container-type: inline-size/);
  assert.match(css, /@container\s*\(max-width: 430px\)/);
  assert.match(css, /@container\s*\(max-width: 180px\)/);
  // 第一级（≤430px 卡片）：只隐「状态 + 元信息」行，名称保留
  assert.match(css, /@container\s*\(max-width: 430px\)\s*\{[\s\S]*?\.agent-status\s*\{\s*display:\s*none\s*;?\s*\}\s*\n\s*\.agent-meta\s*\{\s*display:\s*none/);
  // 第二级（≤180px 卡片）：名称也隐，只剩品牌图标 + 状态点
  assert.match(css, /@container\s*\(max-width: 180px\)\s*\{[\s\S]*?\.agent-name\s*\{\s*display:\s*none/);
  // 每条 agent 形态隐藏规则必须位于最近的 @container 块内，不得挂回视口 @media
  // （每条规则前最近的块开启者必须匹配 @container）
  for (const m of css.matchAll(/\.agent-(?:status|meta|name)\s*\{\s*display:\s*none/g)) {
    const before = css.slice(0, m.index!);
    assert.ok(
      before.lastIndexOf("@container") > before.lastIndexOf("@media"),
      "agent 形态隐藏只能在 @container 中，不得挂回视口 @media",
    );
  }
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
