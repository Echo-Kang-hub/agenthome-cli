// Avenic 模型配置面板控制器（编辑器标签页 webview）。
// 数据通路（src/model/protocol.ts）：只消费 { type: "data" | "parsed" | "testResult" | "error" }；
// 只发送白名单消息 ready/refresh/saveProfile/deleteProfile/bindProject/clearProject/
// testConnection/parseJson/parseText/openLibraryFile/openSettingsFile。
// 安全铁律（设计 §9.7 / §12.5）：一切可影响界面的字符串（路径、端点、掩码、错误消息）
// 只经 createElement + textContent 渲染；渲染路径只读 card.apiKeyMasked，
// 密钥输入框的明文只在用户点击保存时原样回传 host，绝不写回界面。
"use strict";

const vscode = acquireVsCodeApi();

const libraryPathNode = document.getElementById("library-path");
const cardsNode = document.getElementById("cards");
const projectNode = document.getElementById("project");
const editorNode = document.getElementById("editor");
const pasteAreaNode = document.getElementById("paste-area");
const pasteInputNode = document.getElementById("paste-input");
const pasteResultNode = document.getElementById("paste-result");
const newButton = document.getElementById("new");
const pasteButton = document.getElementById("paste");
const refreshButton = document.getElementById("refresh");
const tabJsonButton = document.getElementById("tab-json");
const tabTextButton = document.getElementById("tab-text");
const recognizeButton = document.getElementById("recognize");
const fillButton = document.getElementById("fill");

const AGENTS = [["claude", "Claude"], ["codex", "Codex"], ["opencode", "OpenCode"]];
const API_OPTIONS = ["anthropic", "openai-chat", "openai-responses"];

let data = null; // 最近一条 data 消息的 payload
let notice = null; // 顶部提示（测试结果 / 错误）
let editing = null; // 编辑区草稿（卡片对象形态）；null 表示编辑区关闭
let parsedRows = []; // 最近一次识别结果 [{ field, value, checkbox }]
let parsedPayload = null; // 最近一条 parsed 消息的 payload（host 侧包装为 { json } / { text }）
let pasteMode = "json";

/** 安全的元素构造：文本只经 textContent 写入。 */
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 掩码（前 3 后 4，与 core 的 maskSecret 同形）：只用于展示，不改变回传值。 */
function maskValue(value) {
  const text = String(value ?? "");
  if (text === "") return "";
  if (text.length <= 8) return "••••";
  return text.slice(0, 3) + "…" + text.slice(-4);
}

// ---- 卡片 ----

function renderCard(card) {
  const node = document.createElement("article");
  node.className = card.current ? "card current" : "card";
  const title = document.createElement("h2");
  title.textContent = card.name;
  node.append(title);
  if (card.current) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = "当前项目";
    node.append(badge);
  }
  const endpoint = document.createElement("p");
  endpoint.textContent = `${card.baseUrl}  ·  密钥 ${card.apiKeyMasked}`;
  node.append(endpoint);
  const compat = document.createElement("p");
  compat.className = "compat";
  for (const [agentId, label] of AGENTS) {
    const mark = document.createElement("span");
    const state = card.compatibility[agentId];
    mark.textContent = `${label} ${state.ok ? "✓" : "✗"}`;
    if (!state.ok) mark.title = state.reason ?? "";
    compat.append(mark);
  }
  node.append(compat);
  const actions = document.createElement("div");
  actions.className = "card-actions";
  for (const [label, message] of [
    ["用于当前项目", { type: "bindProject", id: card.id }],
    ["编辑", { type: "edit", id: card.id }], // 本地：展开编辑区，不发消息
    ["测试", { type: "testConnection", id: card.id }],
    ["删除", { type: "deleteProfile", id: card.id }],
  ]) {
    const button = document.createElement("button");
    button.textContent = label;
    // 只有「用于当前项目」依赖项目上下文；编辑/测试/删除操作的是本机库，与项目无关。
    if (label === "用于当前项目" && data.projectRoot === null) {
      button.disabled = true;
      button.title = "未打开项目文件夹";
    }
    button.addEventListener("click", () => handle(label, message));
    actions.append(button);
  }
  node.append(actions);
  return node;
}

function handle(label, message) {
  if (label === "编辑") {
    editing = data.cards.find((card) => card.id === message.id) ?? null;
    renderEditor();
    return;
  }
  vscode.postMessage(message); // 绑定/测试/删除：host 的白名单命令层负责执行与刷新
}

function renderCards() {
  const nodes = [];
  if (notice !== null) nodes.push(el("div", notice, "notice"));
  if (data.libraryBroken !== null) {
    nodes.push(el("div", `配置库读取失败：${data.libraryBroken}`, "notice"));
  }
  for (const card of data.cards) nodes.push(renderCard(card));
  if (data.cards.length === 0 && data.libraryBroken === null) {
    nodes.push(el("p", "本机配置库为空：点「+ 新建」或「粘贴导入」开始。", "empty"));
  }
  cardsNode.replaceChildren(...nodes);
}

// ---- 当前项目区（库路径 / 绑定 / 投影 / 说明） ----

function renderProject() {
  const nodes = [];
  const heading = el("div", undefined, "project-head");
  heading.append(el("strong", "当前项目："));
  heading.append(el("span", data.projectRoot ?? "未打开项目文件夹"));
  nodes.push(heading);
  if (data.binding !== null) {
    const binding = el("div", undefined, "project-binding");
    binding.append(el("span", `本项目使用：${data.binding.name}`));
    const clear = el("button", "取消本项目绑定");
    clear.addEventListener("click", () => vscode.postMessage({ type: "clearProject" }));
    binding.append(clear);
    nodes.push(binding);
  }
  if (data.projection !== null) {
    const fingerprint = data.projection.fingerprintMatches ? "指纹一致" : "指纹不一致";
    nodes.push(el("div", `投影：${data.projection.file}（${data.projection.keys} 个键，${fingerprint}）`, "projection"));
  }
  for (const note of data.notes) nodes.push(el("div", note, "note"));
  if (data.message !== null) nodes.push(el("div", data.message, "message"));
  const actions = el("div", undefined, "project-actions");
  const openLibrary = el("button", "打开配置库文件");
  openLibrary.addEventListener("click", () => vscode.postMessage({ type: "openLibraryFile" }));
  actions.append(openLibrary);
  const openSettings = el("button", "打开项目配置文件");
  if (data.projectRoot === null) {
    openSettings.disabled = true;
    openSettings.title = "未打开项目文件夹";
  }
  openSettings.addEventListener("click", () => vscode.postMessage({ type: "openSettingsFile" }));
  actions.append(openSettings);
  nodes.push(actions);
  projectNode.replaceChildren(...nodes);
}

// ---- 编辑区（§9.3：基本信息 / 连接 / 模型 / 掩码投影预览 + 保存/取消） ----

function newId() {
  return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// 仅显示用：真实请求地址由 core 的 probe 解析（§11）；这里只做「baseUrl 已含 /v1 则不重复追加」的提示。
function testUrlPreview(baseUrl, api) {
  const trimmed = String(baseUrl).trim().replace(/\/+$/, "");
  if (trimmed === "") return "将请求：（待填写 Base URL）";
  const suffix = api === "anthropic" ? "/v1/messages" : api === "openai-responses" ? "/v1/responses" : "/v1/chat/completions";
  return "将请求：" + (/\/v1$/.test(trimmed) ? trimmed + suffix.slice(3) : trimmed + suffix);
}

function maskedProjection(baseUrl, apiKeyMasked, mainModel) {
  const env = {};
  if (baseUrl !== "") env.ANTHROPIC_BASE_URL = baseUrl;
  if (apiKeyMasked !== "") env.ANTHROPIC_AUTH_TOKEN = apiKeyMasked;
  if (mainModel !== "") env.ANTHROPIC_MODEL = mainModel;
  return JSON.stringify({ env }, null, 2);
}

function renderEditor() {
  if (editing === null) {
    editorNode.hidden = true;
    editorNode.replaceChildren();
    return;
  }
  const card = editing;
  editorNode.hidden = false;
  const fields = {
    name: document.createElement("input"),
    baseUrl: document.createElement("input"),
    api: document.createElement("select"),
    apiKey: document.createElement("input"),
    mainModel: document.createElement("input"),
  };
  fields.name.value = card.name;
  fields.baseUrl.value = card.baseUrl;
  for (const api of API_OPTIONS) {
    const option = document.createElement("option");
    option.value = api;
    option.textContent = api;
    if (api === card.api) option.selected = true;
    fields.api.append(option);
  }
  fields.apiKey.type = "password";
  fields.apiKey.value = card.apiKeyPrefill ?? "";
  fields.apiKey.placeholder = card.apiKeyMasked === "" ? "sk-…" : `留空表示不修改（当前 ${card.apiKeyMasked}）`;
  fields.mainModel.value = card.mainModel;

  const field = (labelText, input) => {
    const wrap = el("label", undefined, "field");
    wrap.append(el("span", labelText));
    wrap.append(input);
    return wrap;
  };

  const basics = el("section", undefined, "block");
  basics.append(el("h3", "基本信息"));
  basics.append(field("名称", fields.name));
  basics.append(field("API 类型", fields.api));

  const connection = el("section", undefined, "block");
  connection.append(el("h3", "连接"));
  connection.append(field("Base URL", fields.baseUrl));
  const request = el("p", undefined, "hint");
  connection.append(request);
  connection.append(field("API Key", fields.apiKey));

  const models = el("section", undefined, "block");
  models.append(el("h3", "模型"));
  models.append(field("主模型", fields.mainModel));

  const preview = el("details", undefined, "preview");
  preview.append(el("summary", "最终将写入 .claude/settings.local.json（掩码预览）"));
  const previewBody = el("pre", undefined, "json");
  preview.append(previewBody);

  const refreshPreview = () => {
    request.textContent = testUrlPreview(fields.baseUrl.value, fields.api.value);
    const masked = fields.apiKey.value === "" ? card.apiKeyMasked : maskValue(fields.apiKey.value);
    previewBody.textContent = maskedProjection(fields.baseUrl.value.trim(), masked, fields.mainModel.value.trim());
  };
  for (const input of [fields.name, fields.baseUrl, fields.mainModel]) input.addEventListener("input", refreshPreview);
  fields.api.addEventListener("change", refreshPreview);
  refreshPreview();

  const status = el("p", undefined, "status");
  const actions = el("footer", undefined, "editor-actions");
  const save = el("button", "保存", "primary");
  save.addEventListener("click", () => {
    const name = fields.name.value.trim();
    const baseUrl = fields.baseUrl.value.trim();
    if (name === "" || baseUrl === "") {
      status.textContent = "名称与 Base URL 必填；保存前不会写入任何文件。";
      return;
    }
    const draft = {
      id: card.id === "new" ? newId() : card.id,
      name,
      baseUrl,
      api: fields.api.value,
      // 留空 = 保留库中现有密钥（协议：apiKey === null 表示不修改）
      apiKey: fields.apiKey.value === "" ? null : fields.apiKey.value,
    };
    const mainModel = fields.mainModel.value.trim();
    if (mainModel !== "") draft.mainModel = mainModel;
    vscode.postMessage({ type: "saveProfile", profile: draft });
  });
  const cancel = el("button", "取消");
  cancel.addEventListener("click", () => {
    editing = null;
    renderEditor();
  });
  actions.append(save, cancel, status);

  editorNode.replaceChildren(el("h2", card.id === "new" ? "新建配置" : `编辑：${card.name}`), basics, connection, models, preview, actions);
}

// ---- 粘贴导入（§9.4：识别 → 结果表 → 填入表单；永不自动保存） ----

function parsedResult() {
  const payload = parsedPayload;
  if (payload === null || typeof payload !== "object") return null;
  return payload.json !== undefined ? payload.json : payload.text !== undefined ? payload.text : payload;
}

function renderParsed() {
  parsedRows = [];
  const result = parsedResult();
  const nodes = [];
  if (result === null) {
    nodes.push(el("p", "尚未识别。粘贴内容后点「识别」。", "hint"));
  } else if (result !== null && typeof result === "object" && result.error !== undefined) {
    nodes.push(el("p", `识别失败：${result.error}`, "notice"));
  } else {
    const recognized = Array.isArray(result.recognized) ? result.recognized : [];
    const table = el("div", undefined, "recognized");
    for (const item of recognized) {
      const row = el("label", undefined, "row");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = true;
      const value = item.field === "apiKey" ? maskValue(item.value) : String(item.value);
      row.append(checkbox, el("span", `${item.field}：${value}`));
      table.append(row);
      parsedRows.push({ field: item.field, value: item.value, checkbox });
    }
    if (recognized.length === 0) table.append(el("p", "没有识别到可用字段。", "hint"));
    nodes.push(table);
    if (result.candidates !== undefined) nodes.push(el("p", "多个候选全部列出，默认选中的可取消；未勾选的不写入。", "hint"));
  }
  pasteResultNode.replaceChildren(...nodes);
}

function applyParsedToDraft() {
  const picked = parsedRows.filter((row) => row.checkbox.checked !== false);
  if (picked.length === 0) return;
  const draftCard = { id: "new", name: "", baseUrl: "", api: "anthropic", apiKeyMasked: "", mainModel: "", apiKeyPrefill: "" };
  for (const row of picked) {
    if (row.field === "baseUrl") draftCard.baseUrl = row.value;
    else if (row.field === "apiKey") {
      draftCard.apiKeyPrefill = row.value;
      draftCard.apiKeyMasked = maskValue(row.value);
    } else if (/Model$/.test(row.field) && draftCard.mainModel === "") draftCard.mainModel = row.value;
  }
  editing = draftCard;
  pasteAreaNode.hidden = true;
  renderEditor();
}

function setPasteMode(mode) {
  pasteMode = mode;
  tabJsonButton.className = mode === "json" ? "tab active" : "tab";
  tabTextButton.className = mode === "text" ? "tab active" : "tab";
  parsedPayload = null;
  renderParsed();
}

// ---- 测试结果 / 错误提示 ----

function testResultText(result) {
  if (result === null || typeof result !== "object") return "测试连接：无结果返回。";
  if (result.ok) {
    const parts = [];
    if (result.durationMs !== undefined) parts.push(`${result.durationMs}ms`);
    if (result.model) parts.push(String(result.model));
    return `测试连接成功：${parts.join(" · ")}`;
  }
  const category = result.category === undefined ? "unknown" : result.category;
  return `测试连接失败（${category}）：${result.message ?? ""}连接失败 ≠ 密钥无效。`;
}

// ---- 渲染入口 ----

function render() {
  libraryPathNode.textContent = data.libraryPath;
  renderCards();
  renderProject();
  renderEditor();
}

window.addEventListener("message", (event) => {
  const message = event.data;
  if (message === null || typeof message !== "object") return;
  if (message.type === "data") {
    data = message.payload;
    notice = null;
    if (editing !== null && editing.id !== "new" && !data.cards.some((card) => card.id === editing.id)) editing = null;
    render();
  } else if (message.type === "parsed") {
    parsedPayload = message.payload;
    pasteAreaNode.hidden = false;
    renderParsed();
  } else if (message.type === "testResult") {
    notice = testResultText(message.payload);
    renderCards();
  } else if (message.type === "error") {
    notice = message.message;
    renderCards();
  }
});

newButton.addEventListener("click", () => {
  editing = { id: "new", name: "", baseUrl: "", api: "anthropic", apiKeyMasked: "", mainModel: "" };
  renderEditor();
});
pasteButton.addEventListener("click", () => {
  pasteAreaNode.hidden = !pasteAreaNode.hidden;
});
refreshButton.addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
tabJsonButton.addEventListener("click", () => setPasteMode("json"));
tabTextButton.addEventListener("click", () => setPasteMode("text"));
recognizeButton.addEventListener("click", () => {
  vscode.postMessage({ type: pasteMode === "json" ? "parseJson" : "parseText", text: pasteInputNode.value });
});
fillButton.addEventListener("click", () => applyParsedToDraft());

setPasteMode("json");
// 脚本就绪即宣告：panel 对 resolver 期间的早期发送会被丢弃，ready 后补发一轮
vscode.postMessage({ type: "ready" });
