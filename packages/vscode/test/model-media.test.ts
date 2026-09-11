import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

const mediaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "media", "model");

test("view.html has the CSP placeholders and no remote resources", async () => {
  const html = await readFile(path.join(mediaRoot, "view.html"), "utf8");
  assert.match(html, /\{\{nonce\}\}/);
  assert.match(html, /\{\{cspSource\}\}/);
  assert.match(html, /\{\{mainJs\}\}/);
  assert.match(html, /\{\{style\}\}/);
  assert.equal(/https?:\/\//.test(html.replaceAll("{{cspSource}}", "")), false);
});

test("main.js renders user data with textContent only", async () => {
  const script = await readFile(path.join(mediaRoot, "main.js"), "utf8");
  assert.equal(script.includes("innerHTML"), false);
  assert.equal(/https?:\/\//.test(script), false);
  assert.match(script, /acquireVsCodeApi/);
  assert.match(script, /textContent/);
});

test("style.css uses VS Code theme variables", async () => {
  const style = await readFile(path.join(mediaRoot, "style.css"), "utf8");
  assert.match(style, /--vscode-/);
  assert.equal(/https?:\/\//.test(style), false);
});

// 第 4 条：真正执行 main.js 的渲染路径。前三条只做字符串匹配，一行代码都不跑——
// 渲染函数里的运行时错误（例如引用了块作用域外的变量 → ReferenceError）在它们的盲区里。
// 桩最小化：只实现渲染路径真正调用到的 DOM 表面（createElement/getElementById/append/
// textContent/addEventListener/setAttribute/replaceChildren + window 监听 + acquireVsCodeApi）。
class StubNode {
  readonly children: StubNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  className = "";
  title = "";
  hidden = false;
  disabled = false;
  value = "";
  private text = "";

  constructor(readonly tagName: string, private readonly texts: string[]) {}

  get textContent(): string {
    return this.text;
  }

  set textContent(value: string) {
    this.text = String(value);
    this.texts.push(this.text);
  }

  append(...nodes: StubNode[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: StubNode[]): void {
    this.children.splice(0, this.children.length, ...nodes);
  }

  addEventListener(type: string, listener: (...args: unknown[]) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
}

// 每条 data 消息都在全新的 vm 上下文里跑一遍脚本（避免两次渲染的记录互相污染）。
function renderDataMessage(payload: unknown, source: string): { created: StubNode[]; texts: string[] } {
  const created: StubNode[] = [];
  const texts: string[] = [];
  const byId = new Map<string, StubNode>();
  const make = (tag: string): StubNode => {
    // 真实 DOM 的 HTML 元素 tagName 是大写（document.createElement("button").tagName === "BUTTON"）
    const node = new StubNode(tag.toUpperCase(), texts);
    created.push(node);
    return node;
  };
  const document = {
    createElement: (tag: string) => make(tag),
    getElementById: (id: string) => {
      let node = byId.get(id);
      if (node === undefined) {
        node = make("div");
        byId.set(id, node);
      }
      return node;
    },
  };
  const messageListeners: Array<(event: { data: unknown }) => void> = [];
  const context = createContext({
    document,
    window: {
      addEventListener: (type: string, listener: (event: { data: unknown }) => void) => {
        if (type === "message") messageListeners.push(listener);
      },
    },
    acquireVsCodeApi: () => ({ postMessage: () => undefined }),
    console,
  });
  runInContext(source, context, { filename: "media/model/main.js" });
  assert.ok(messageListeners.length > 0, "main.js 必须注册 window message 监听");
  for (const listener of messageListeners) listener({ data: { type: "data", payload } });
  return { created, texts };
}

function card(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "mimo",
    name: "小米 MiMo",
    baseUrl: "https://token-plan-cn.xiaomimimo.com/anthropic",
    api: "anthropic",
    apiKeyMasked: "sk-…f3a2",
    mainModel: "mimo-v2.5-pro",
    current: false,
    compatibility: {
      claude: { ok: true },
      codex: { ok: false, reason: "需 Responses API" },
      opencode: { ok: true },
    },
    ...overrides,
  };
}

function panelData(projectRoot: string | null): Record<string, unknown> {
  return {
    libraryPath: "C:\\Users\\x\\.config\\avenic\\models.json",
    libraryExists: true,
    libraryBroken: null,
    projectRoot,
    cards: [card({ current: true }), card({ id: "kimi", name: "项目 B 配置（Kimi）" })],
    binding: projectRoot === null ? null : { profileId: "mimo", name: "小米 MiMo" },
    projection: null,
    notes: [],
    message: null,
  };
}

test("main.js renders cards without throwing and gates binding on the project root", async () => {
  const source = await readFile(path.join(mediaRoot, "main.js"), "utf8");

  const bound = renderDataMessage(panelData("/repo/proj-a"), source);
  assert.ok(bound.texts.length > 0, "渲染路径必须发生 textContent 赋值");
  assert.ok(bound.texts.includes("小米 MiMo"), "卡片名称必须被渲染出来");
  assert.ok(bound.texts.includes("项目 B 配置（Kimi）"));
  const enabled = bound.created.filter((node) => node.tagName === "BUTTON" && node.textContent === "用于当前项目");
  assert.equal(enabled.length, 2);
  assert.equal(enabled.every((node) => node.disabled === false), true, "有项目时绑定按钮可用");

  const unbound = renderDataMessage(panelData(null), source);
  const disabled = unbound.created.filter((node) => node.tagName === "BUTTON" && node.textContent === "用于当前项目");
  assert.equal(disabled.length, 2);
  assert.equal(disabled.every((node) => node.disabled === true), true, "无项目时绑定按钮禁用");
  assert.equal(disabled.every((node) => node.title === "未打开项目文件夹"), true);
});
