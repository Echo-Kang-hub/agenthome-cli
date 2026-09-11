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
  // 表单控件属性：渲染路径会读/写这几种（密码框、勾选框、下拉项）。
  type = "";
  placeholder = "";
  checked = false;
  selected = false;
  private explicitValue = "";
  private text = "";

  // <select> 的 value 在真实 DOM 里是「选中项的值」，读和写都双向联动：
  // 读 → 命中 selected 的 option；写 → 把 selected 挪到匹配的 option 上。
  // 不模拟这一层的话，面板读 fields.api.value 会拿到空串（真实浏览器里不会）。
  get value(): string {
    if (this.tagName === "SELECT") {
      const chosen = this.children.find((child) => child.tagName === "OPTION" && child.selected);
      if (chosen !== undefined) return chosen.value;
    }
    return this.explicitValue;
  }

  set value(next: string) {
    this.explicitValue = String(next);
    if (this.tagName === "SELECT") {
      for (const child of this.children) {
        if (child.tagName === "OPTION") child.selected = child.value === this.explicitValue;
      }
    }
  }

  // 不用 TS 的「构造器参数属性」（constructor(readonly x: T)）：根目录的 `npm test`
  // 会用 Node 的 strip-only 类型擦除直接执行本文件，而 strip-only 明确不支持该语法
  // （ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX）。vscode 本地套件走 esbuild，能吞下它，
  // 所以这条约束只有根套件看得见——保留显式字段声明与赋值。
  readonly tagName: string;
  private readonly texts: string[];

  constructor(tagName: string, texts: string[]) {
    this.tagName = tagName;
    this.texts = texts;
  }

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

interface Rendered {
  created: StubNode[];
  texts: string[];
  posted: unknown[];
  byId: Map<string, StubNode>;
  // 追加派发一条消息（点击等交互之后 host 的回应走这里）。
  send: (message: unknown) => void;
}

// 每条 data 消息都在全新的 vm 上下文里跑一遍脚本（避免两次渲染的记录互相污染）。
// extra: 数据消息之后依次派发的消息（模拟「点击 → host 回包」的往返）。
function renderDataMessage(payload: unknown, source: string, extra: unknown[] = []): Rendered {
  const created: StubNode[] = [];
  const texts: string[] = [];
  const posted: unknown[] = [];
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
    acquireVsCodeApi: () => ({ postMessage: (message: unknown) => posted.push(message) }),
    console,
  });
  runInContext(source, context, { filename: "media/model/main.js" });
  assert.ok(messageListeners.length > 0, "main.js 必须注册 window message 监听");
  const send = (message: unknown): void => {
    for (const listener of messageListeners) listener({ data: message });
  };
  send({ type: "data", payload });
  for (const message of extra) send(message);
  return { created, texts, posted, byId, send };
}

/** 触发节点上已注册的事件（点击等）。 */
function fire(node: StubNode, type = "click"): void {
  for (const listener of node.listeners.get(type) ?? []) listener({ type });
}

/** 按可见文本找按钮（面板的按钮都没有 id，靠文案定位）。 */
function buttons(rendered: Rendered, text: string): StubNode[] {
  return rendered.created.filter((node) => node.tagName === "BUTTON" && node.textContent === text);
}

/** 面板自己贴出的所有文本（断言「界面上出现过什么」用这个，而不是只找某个节点）。 */
function allText(rendered: Rendered): string {
  return rendered.texts.join("\n");
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

/** 打开卡片编辑区（点击卡片上的「编辑」）。 */
function openEditor(rendered: Rendered): void {
  const edit = buttons(rendered, "编辑")[0];
  assert.ok(edit, "卡片上必须有「编辑」按钮");
  fire(edit);
}

function requestHint(rendered: Rendered): StubNode | undefined {
  return rendered.created.filter((node) => node.className === "hint" && node.textContent.startsWith("将请求：")).at(-1);
}

function projectionPre(rendered: Rendered): StubNode | undefined {
  return rendered.created.filter((node) => node.tagName === "PRE" && node.className === "json").at(-1);
}

// 回归钉子（设计 §9.3）：这两个特性**已经存在**，下面的重写不得把它们弄丢。
// 两条都写成「先编辑、再喂一条 host 回包、然后断言界面」，所以在新旧两种机制下都成立：
// 旧实现自己算预览（那条回包是未知类型，被忽略）；新实现由 host 算（回包就是数据来源）。
test("the editor keeps a live request-URL preview that follows Base URL and API type", async () => {
  const source = await readFile(path.join(mediaRoot, "main.js"), "utf8");
  const rendered = renderDataMessage(panelData("/repo/proj-a"), source);
  openEditor(rendered);

  // 1. 打开即显示解析后的测试地址（anthropic → /v1/messages）。
  assert.equal(
    requestHint(rendered)?.textContent,
    "将请求：https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages",
  );

  // 2. Base URL 已含 /v1 时不重复追加。
  const baseUrlInput = rendered.created.filter((node) => node.tagName === "INPUT" && node.value === "https://token-plan-cn.xiaomimimo.com/anthropic").at(-1);
  assert.ok(baseUrlInput, "编辑区必须有 Base URL 输入框，且回显卡片当前值");
  baseUrlInput.value = "https://token-plan-cn.xiaomimimo.com/anthropic/v1";
  fire(baseUrlInput, "input");
  rendered.send({ type: "projection", payload: { entries: [], requestUrl: "https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages", error: null } });
  assert.equal(
    requestHint(rendered)?.textContent,
    "将请求：https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages",
  );

  // 3. 切换 API 类型换后缀。
  const apiSelect = rendered.created.filter((node) => node.tagName === "SELECT").at(-1);
  assert.ok(apiSelect, "编辑区必须有 API 类型下拉框");
  apiSelect.value = "openai-responses";
  fire(apiSelect, "change");
  rendered.send({ type: "projection", payload: { entries: [], requestUrl: "https://token-plan-cn.xiaomimimo.com/anthropic/v1/responses", error: null } });
  assert.equal(
    requestHint(rendered)?.textContent,
    "将请求：https://token-plan-cn.xiaomimimo.com/anthropic/v1/responses",
  );
});

test("the editor keeps a folded, masked projection preview", async () => {
  const source = await readFile(path.join(mediaRoot, "main.js"), "utf8");
  const rendered = renderDataMessage(panelData("/repo/proj-a"), source);
  openEditor(rendered);

  const details = rendered.created.filter((node) => node.tagName === "DETAILS" && node.className === "preview").at(-1);
  assert.ok(details, "投影预览必须是可折叠的 <details class=\"preview\">");
  const summary = details.children.find((child) => child.tagName === "SUMMARY");
  assert.match(summary?.textContent ?? "", /\.claude\/settings\.local\.json/);
  assert.equal(details.children.some((child) => child.tagName === "PRE"), true, "折叠区里必须是 <pre>");

  // host 回包里的密钥值本来就是掩码——面板拿到什么就渲染什么。
  rendered.send({
    type: "projection",
    payload: {
      entries: [
        { path: ["env", "ANTHROPIC_BASE_URL"], value: "https://token-plan-cn.xiaomimimo.com/anthropic" },
        { path: ["env", "ANTHROPIC_AUTH_TOKEN"], value: "sk-…f3a2", secret: true },
        { path: ["env", "ANTHROPIC_MODEL"], value: "mimo-v2.5-pro" },
      ],
      requestUrl: null,
      error: null,
    },
  });
  const json = projectionPre(rendered)?.textContent ?? "";
  assert.match(json, /ANTHROPIC_BASE_URL/);
  assert.match(json, /sk-…f3a2/, "预览里出现的是掩码");
  assert.equal(/sk-[A-Za-z0-9_-]{8,}/.test(json), false, "预览里绝不能出现完整密钥");
});

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
