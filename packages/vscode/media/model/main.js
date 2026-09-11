// Avenic 模型配置面板控制器（编辑器标签页 webview）。
// 数据通路（src/model/protocol.ts）：只消费 { type: "data" | "parsed" | "projection" | "testResult" | "error" }；
// 只发送白名单消息 ready/refresh/saveProfile/preview/deleteProfile/duplicateProfile/bindProject/
// clearProject/testConnection/parseJson/parseText/openLibraryFile/openSettingsFile。
//
// 安全铁律（设计 §9.7 / §12.5）：
//  * 一切可影响界面的字符串（路径、端点、掩码、错误消息）只经 createElement + textContent 渲染。
//  * 本文件**只有掩码**：面板从不持有已存密钥的明文。编辑区的密钥输入框永远是空的，
//    空 = 保留库中现有密钥（草稿里 apiKey === null）。用户输入新密钥 → 替换；点「清除密钥」
//    → 草稿 apiKey === ""（明确删除）。掩码只用于展示，绝不写进输入框当值（§7）。
//  * 投影 / 请求地址 / 校验**全部由 host 算**（§9.7 禁止插件侧第二份业务逻辑）：本文件改一个
//    字段就 post 一条 preview，只负责渲染回包。
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

const API_OPTIONS = ["anthropic", "openai-chat", "openai-responses"];
const AGENT_LABELS = { claude: "Claude", codex: "Codex", opencode: "OpenCode" };

let data = null; // 最近一条 data 消息的 payload
let notice = null; // 顶部提示（测试结果 / 错误）
let editing = null; // 编辑区状态 { id, isNew, profile }；null 表示编辑区关闭
let preview = null; // 最近一条 projection 回包（{ entries, content, requestUrl, error, issues }）
let previewBusy = false; // 有一条 preview 在飞（host 侧 handle 是 fire-and-forget，必须自己排队）
let previewQueued = false; // 飞行途中草稿又变了，回包后再发一次
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

/**
 * 掩码（前 3 后 4，与 core 的 maskSecret 同形）。**只用于展示**：粘贴导入时用户自己刚粘进来的
 * 密钥不该整条回显在结果表里。已存密钥的掩码由 host 给出，本文件不自己算。
 */
function maskValue(value) {
  const text = String(value ?? "");
  if (text === "") return "";
  if (text.length <= 8) return "••••";
  return text.slice(0, 3) + "…" + text.slice(-4);
}

function options() {
  return data.options;
}

// ---- 问题定位（§5.5「由 core 判定并在 UI 定位显示」） ----
// host 回的 field 是草稿里的点分路径（name / baseUrl / models.opus.id / env.3.key / …）。
// 这里只做两件事：给出人话标签，以及把有问题的控件标红。

const FIELD_LABELS = { name: "名称", baseUrl: "Base URL", authField: "认证字段", passthrough: "Claude 顶层透传" };

function fieldLabel(field) {
  if (FIELD_LABELS[field] !== undefined) return FIELD_LABELS[field];
  const model = /^models\.([^.]+)\.id$/.exec(field);
  if (model) return `${roleLabel(model[1])} 模型 ID`;
  const env = /^env\.(\d+)\.(key|value)$/.exec(field);
  if (env) return `环境变量第 ${Number(env[1]) + 1} 行`;
  const override = /^overrides\.([^.]+)\.baseUrl$/.exec(field);
  if (override) return `${AGENT_LABELS[override[1]] ?? override[1]} 覆盖 Base URL`;
  const provider = /^([^.]+)\.providerId$/.exec(field);
  if (provider) return `${AGENT_LABELS[provider[1]] ?? provider[1]} providerId`;
  return field;
}

function roleLabel(role) {
  const found = options().roles.find((entry) => entry.id === role);
  return found === undefined ? role : found.label;
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
  for (const [agentId, label] of Object.entries(AGENT_LABELS)) {
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
    ["复制", { type: "duplicateProfile", id: card.id }],
    ["测试", { type: "testConnection", id: card.id }],
    ["删除", { type: "deleteProfile", id: card.id }],
  ]) {
    const button = document.createElement("button");
    button.textContent = label;
    // 只有「用于当前项目」依赖项目上下文；编辑/复制/测试/删除操作的是本机库，与项目无关。
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
    const card = data.cards.find((entry) => entry.id === message.id);
    if (card === undefined) return;
    // 卡片自带完整草稿（含 options）：编辑已有配置永远不会带出明文密钥（profile.apiKey === null）。
    editing = { id: card.id, isNew: false, profile: card.profile };
    resetEditorState();
    renderEditor();
    return;
  }
  vscode.postMessage(message); // 绑定/复制/测试/删除：host 的白名单命令层负责执行与刷新
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
  const openSettings = el("button", "在编辑器中打开项目配置文件");
  if (data.projectRoot === null) {
    openSettings.disabled = true;
    openSettings.title = "未打开项目文件夹";
  }
  openSettings.addEventListener("click", () => vscode.postMessage({ type: "openSettingsFile" }));
  actions.append(openSettings);
  nodes.push(actions);
  projectNode.replaceChildren(...nodes);
}

// ---- 编辑区（§9.3） ----

function newId() {
  return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * 编辑区里「会被回包改写」的节点。每次 renderEditor 重建 DOM 时一并换新——留着上一轮的节点
 * 等于把标红/文本写到已经脱离文档的树上。
 */
let live = { hint: null, pre: null, status: null, issues: null };
let issueTargets = new Map(); // field → 节点数组（标红 + 列表定位）
let sameAsMain = []; // [{ button, roleId }]：「同主模型」的可用性随主模型输入实时变

function resetEditorState() {
  live = { hint: null, pre: null, status: null, issues: null };
  issueTargets = new Map();
  sameAsMain = [];
  preview = null;
  previewBusy = false;
  previewQueued = false;
}

function profile() {
  return editing.profile;
}

function touchIssue(field, node) {
  const list = issueTargets.get(field) ?? [];
  list.push(node);
  issueTargets.set(field, list);
}

function requestPreview() {
  if (editing === null) return;
  if (previewBusy) {
    previewQueued = true;
    return;
  }
  previewBusy = true;
  vscode.postMessage({ type: "preview", profile: profile() });
}

function onProjection(payload) {
  previewBusy = false;
  preview = payload ?? null;
  renderPreview();
  if (previewQueued) {
    previewQueued = false;
    requestPreview();
  }
}

/** 表单控件上的改动一律先落到草稿，再请求一次 host 预览。 */
function changed() {
  requestPreview();
}

function textField(field, labelText, get, set, placeholder) {
  const input = document.createElement("input");
  input.value = get();
  if (placeholder !== undefined) input.placeholder = placeholder;
  input.addEventListener("input", () => {
    set(input.value);
    changed();
  });
  const wrap = el("label", undefined, "field");
  wrap.append(el("span", labelText));
  wrap.append(input);
  touchIssue(field, wrap);
  return { node: wrap, input };
}

function selectField(field, labelText, values, get, set) {
  const select = document.createElement("select");
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    if (value === get()) option.selected = true;
    select.append(option);
  }
  select.value = get();
  select.addEventListener("change", () => {
    set(select.value);
    changed();
  });
  const wrap = el("label", undefined, "field");
  wrap.append(el("span", labelText));
  wrap.append(select);
  touchIssue(field, wrap);
  return { node: wrap, select };
}

// 预设磁贴：只填 baseUrl / api 这两个「起点」字段，**不动模型映射**——所以点预设永远不会
// 覆盖用户已经填好的模型 ID。也永不自动保存（§9.3）。
function renderPresets(rerender) {
  const section = el("section", undefined, "block");
  section.append(el("h3", "预设"));
  const list = el("div", undefined, "presets");
  for (const preset of options().presets) {
    const tile = document.createElement("button");
    tile.className = "preset";
    tile.type = "button";
    tile.append(el("strong", preset.label));
    tile.append(el("span", preset.baseUrl));
    tile.addEventListener("click", () => {
      profile().baseUrl = preset.baseUrl;
      profile().api = preset.api;
      rerender(); // 重建编辑区以回显新值（也顺带请求一次 host 预览）
    });
    list.append(tile);
  }
  section.append(list);
  section.append(el("p", "预设只是起点，请以服务商文档为准。", "hint"));
  return section;
}

function renderBasics() {
  const section = el("section", undefined, "block");
  section.append(el("h3", "基本信息"));
  section.append(
    textField("name", "名称", () => profile().name, (value) => {
      profile().name = value;
    }).node,
  );
  section.append(
    selectField("api", "API 类型", options().apis, () => profile().api, (value) => {
      profile().api = value;
    }).node,
  );
  return section;
}

function renderConnection() {
  const section = el("section", undefined, "block");
  section.append(el("h3", "连接"));
  section.append(
    textField("baseUrl", "Base URL", () => profile().baseUrl, (value) => {
      profile().baseUrl = value;
    }, "服务商端点地址").node,
  );
  const hint = el("p", undefined, "hint");
  section.append(hint);
  // 「将请求：<地址>」的真实地址由 core 的 probeUrl 解析后回包（§9.7）；这里只挂节点。
  live.hint = hint;

  section.append(
    selectField("authField", "认证字段", options().authFields, () => profile().authField, (value) => {
      profile().authField = value;
    }).node,
  );

  // §7：输入框永远是空的。空 + 没点清除 = 保留库中现有密钥（apiKey === null）。
  const input = document.createElement("input");
  input.type = "password";
  input.value = "";
  input.placeholder = "留空表示不修改现有密钥";
  const keyNote = el("p", undefined, "hint");
  const syncKey = () => {
    keyNote.textContent =
      profile().apiKey === null
        ? "将保留配置库里已有的密钥。"
        : profile().apiKey === ""
          ? "已标记「清除密钥」：保存后该配置不再有密钥。"
          : `将写入新密钥（${maskValue(profile().apiKey)}）。`;
  };
  // 输入框的**内容**就是唯一状态源：非空 = 替换；清空 = 回到「不修改」。
  input.addEventListener("input", () => {
    profile().apiKey = input.value === "" ? null : input.value;
    syncKey();
    changed();
  });
  const clear = el("button", "清除密钥");
  clear.type = "button";
  clear.addEventListener("click", () => {
    input.value = "";
    profile().apiKey = ""; // 区别于 null：这是「明确删除」
    syncKey();
    changed();
  });
  const keyRow = el("label", undefined, "field");
  keyRow.append(el("span", "API Key"));
  keyRow.append(input);
  keyRow.append(clear);
  syncKey();
  section.append(keyRow, keyNote);

  return section;
}

function mainModelId() {
  return (profile().models.main?.id ?? "").trim();
}

/** 「同主模型」按钮的可用性随主模型实时变（主模型为空时无处可拷）。 */
function syncSameAsMain() {
  for (const entry of sameAsMain) entry.button.disabled = mainModelId() === "";
}

function renderModels() {
  const section = el("section", undefined, "block");
  section.append(el("h3", "模型映射"));
  const table = el("div", undefined, "models");
  for (const role of options().roles) {
    const row = el("div", undefined, "model-row");
    row.append(el("span", role.label, "model-role"));
    const idInput = document.createElement("input");
    idInput.value = profile().models[role.id]?.id ?? "";
    idInput.placeholder = role.id === "main" ? "主模型 ID" : "留空 = 不映射";
    idInput.addEventListener("input", () => {
      const current = profile().models[role.id] ?? {};
      profile().models[role.id] = { ...current, id: idInput.value };
      if (role.id === "main") syncSameAsMain();
      changed();
    });
    row.append(idInput);
    touchIssue(`models.${role.id}.id`, idInput);

    // 「同主模型」：把主模型的 ID 一键拷到本行（只是把值填进输入框，仍需点保存才落盘）。
    if (role.id !== "main") {
      const same = el("button", "同主模型");
      same.type = "button";
      same.disabled = mainModelId() === "";
      same.addEventListener("click", () => {
        if (mainModelId() === "") return;
        const current = profile().models[role.id] ?? {};
        profile().models[role.id] = { ...current, id: mainModelId() };
        idInput.value = mainModelId();
        changed();
      });
      sameAsMain.push({ button: same, roleId: role.id });
      row.append(same);
    } else {
      row.append(el("span", undefined, "spacer"));
    }

    // 显示名只出现在 core 真的会写 `_MODEL_NAME` 的角色上（options.displayRoles 来自 core）。
    if (options().displayRoles.includes(role.id)) {
      const display = document.createElement("input");
      display.value = profile().models[role.id]?.display ?? "";
      display.placeholder = "显示名（可留空）";
      display.addEventListener("input", () => {
        const current = profile().models[role.id] ?? {};
        profile().models[role.id] = { ...current, display: display.value };
        changed();
      });
      row.append(display);
    }

    // 1M 上下文：按设计只给 Opus / Sonnet 提供勾选框。其余角色库里已有的 longContext
    // 由 host 原样保留（草稿里没渲染的字段不会因为一次保存而消失）。
    if (options().longContextRoles.includes(role.id)) {
      const wrap = el("label", undefined, "inline");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = profile().models[role.id]?.longContext === true;
      checkbox.addEventListener("change", () => {
        const current = profile().models[role.id] ?? {};
        profile().models[role.id] = { ...current, longContext: checkbox.checked };
        changed();
      });
      wrap.append(checkbox, el("span", "1M"));
      row.append(wrap);
    }
    table.append(row);
  }
  section.append(table);
  return section;
}

function renderToggles() {
  const section = el("section", undefined, "block");
  section.append(el("h3", "开关"));
  const list = el("div", undefined, "toggles");
  for (const toggle of options().toggles) {
    const row = el("label", undefined, "toggle");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = profile().toggles.includes(toggle.id);
    checkbox.addEventListener("change", () => {
      const set = new Set(profile().toggles);
      if (checkbox.checked) set.add(toggle.id);
      else set.delete(toggle.id);
      profile().toggles = options().toggles.map((entry) => entry.id).filter((id) => set.has(id));
      changed();
    });
    row.append(checkbox);
    row.append(el("span", toggle.label));
    // 「实际写入的键名」直接来自 core 的 TOGGLE_ENTRIES（§9.3）：面板不维护第二份清单。
    row.append(el("code", toggle.writes, "writes"));
    list.append(row);
  }
  section.append(list);
  return section;
}

function envRowNode(index) {
  const row = profile().env[index];
  const node = el("div", undefined, "env-row");
  const key = document.createElement("input");
  key.value = row.key;
  key.placeholder = "变量名（如 AVENIC_FLAG）";
  key.addEventListener("input", () => {
    row.key = key.value;
    changed();
  });
  const value = document.createElement("input");
  value.value = row.value;
  value.placeholder = "值";
  value.addEventListener("input", () => {
    row.value = value.value;
    changed();
  });
  const remove = el("button", "删除", "danger");
  remove.type = "button";
  remove.addEventListener("click", () => {
    profile().env.splice(index, 1);
    renderEditor(); // 行号即索引，删一行必须重建（否则后面的行会指向错的 index）
  });
  node.append(key, value, remove);
  // 标红整行而不是输入框：重复键 / 受管键冲突说的都是"这一行"，不是"这个输入框的字符"。
  touchIssue(`env.${index}.key`, node);
  return node;
}

function renderAdvanced() {
  const section = el("section", undefined, "block");
  section.append(el("h3", "高级"));

  const envHead = el("div", undefined, "sub-head");
  envHead.append(el("h4", "自定义环境变量"));
  const addEnv = el("button", "添加一行");
  addEnv.type = "button";
  addEnv.addEventListener("click", () => {
    profile().env.push({ key: "", value: "" });
    renderEditor();
  });
  envHead.append(addEnv);
  section.append(envHead);
  const envList = el("div", undefined, "env-list");
  profile().env.forEach((row, index) => envList.append(envRowNode(index)));
  if (profile().env.length === 0) envList.append(el("p", "没有自定义环境变量。", "hint"));
  section.append(envList);

  // Agent 覆盖：core 的 ProfileOverrides 只有 codex / opencode 两项（Claude 用主端点，
  // 没有覆盖字段），所以这里**不造** Claude 的覆盖输入框——以真实 schema 为准（§9.3）。
  section.append(el("h4", "Agent 覆盖"));
  section.append(el("p", "Claude 直接使用上面的主端点；只有 Codex / OpenCode 有独立的覆盖。", "hint"));
  for (const agentId of ["codex", "opencode"]) {
    const override = profile().overrides[agentId] ?? {};
    const row = el("div", undefined, "override-row");
    row.append(el("span", AGENT_LABELS[agentId] ?? agentId, "model-role"));
    const baseUrl = document.createElement("input");
    baseUrl.value = override.baseUrl ?? "";
    baseUrl.placeholder = "Base URL（留空 = 跟随主端点）";
    baseUrl.addEventListener("input", () => {
      profile().overrides[agentId] = { ...(profile().overrides[agentId] ?? {}), baseUrl: baseUrl.value };
      changed();
    });
    const api = document.createElement("select");
    for (const value of options().apis) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      if (value === (override.api ?? profile().api)) option.selected = true;
      api.append(option);
    }
    api.value = override.api ?? profile().api;
    api.addEventListener("change", () => {
      profile().overrides[agentId] = { ...(profile().overrides[agentId] ?? {}), api: api.value };
      changed();
    });
    row.append(baseUrl, api);
    touchIssue(`overrides.${agentId}.baseUrl`, baseUrl);
    section.append(row);
  }

  const codexHead = el("h4", "Codex");
  section.append(codexHead);
  const codex = profile().codex;
  section.append(
    textField("codex.providerId", "providerId", () => codex.providerId, (value) => {
      codex.providerId = value;
    }, "留空 = core 默认 avenic_<id>").node,
  );
  section.append(
    textField("codex.envKey", "envKey", () => codex.envKey, (value) => {
      codex.envKey = value;
    }, "留空 = core 默认 AVENIC_MODEL_KEY").node,
  );
  section.append(
    selectField("codex.reasoningEffort", "reasoningEffort", options().codexEffort, () => codex.reasoningEffort, (value) => {
      codex.reasoningEffort = value;
    }).node,
  );

  section.append(el("h4", "OpenCode"));
  const opencode = profile().opencode;
  section.append(
    textField("opencode.providerId", "providerId", () => opencode.providerId, (value) => {
      opencode.providerId = value;
    }, "留空 = core 默认 <id>").node,
  );
  section.append(
    textField("opencode.npmAdapter", "npmAdapter", () => opencode.npmAdapter, (value) => {
      opencode.npmAdapter = value;
    }, "留空 = core 默认 @ai-sdk/openai-compatible").node,
  );

  // Claude 顶层透传：只读展示（粘贴 claude-settings 形态带进来的未知键）。这里不实现
  // JSON 编辑器（§9.3）——要看/改就在编辑器中打开真实文件。
  const passthrough = profile().passthrough ?? {};
  const keys = Object.keys(passthrough);
  section.append(el("h4", "Claude 顶层透传（只读）"));
  const passthroughPre = el("pre", undefined, "json small");
  passthroughPre.textContent = keys.length === 0 ? "（无）" : JSON.stringify(passthrough, null, 2);
  section.append(passthroughPre);
  touchIssue("passthrough", passthroughPre);
  section.append(el("p", `随配置写入 .claude/settings.local.json 顶层，共 ${keys.length} 个键；保存前可在此确认。`, "hint"));
  const openSettings = el("button", "在编辑器中打开 .claude/settings.local.json");
  openSettings.type = "button";
  if (data.projectRoot === null) {
    openSettings.disabled = true;
    openSettings.title = "未打开项目文件夹";
  }
  openSettings.addEventListener("click", () => vscode.postMessage({ type: "openSettingsFile" }));
  section.append(openSettings);

  return section;
}

/** 把 host 回的预览/问题渲染到已有的节点上（不重建 DOM，避免输入焦点被吃掉）。 */
function renderPreview() {
  const { hint, pre, status, issues } = live;
  if (hint === null || pre === null || status === null || issues === null) return;
  if (preview === null) {
    hint.textContent = "将请求：（正在计算…）";
    pre.textContent = "";
    issues.replaceChildren();
    status.className = "status";
    status.textContent = "";
    return;
  }
  hint.textContent =
    preview.requestUrl === null ? "将请求：（Base URL 无效，无法解析请求地址）" : `将请求：${preview.requestUrl}`;
  pre.textContent = JSON.stringify(preview.content ?? {}, null, 2);

  // 先清掉上一轮的标红，再按本轮 issues 重新标（问题集合会随编辑变化）。
  for (const nodes of issueTargets.values()) {
    for (const node of nodes) node.className = node.className.replace(/ ?invalid/g, "");
  }
  const lines = [];
  for (const issue of preview.issues ?? []) {
    lines.push(el("li", `${fieldLabel(issue.field)}：${issue.message}`));
    for (const node of issueTargets.get(issue.field) ?? []) {
      if (!node.className.includes("invalid")) node.className = `${node.className} invalid`;
    }
  }
  if (preview.error !== null && preview.error !== undefined) lines.push(el("li", preview.error));
  issues.replaceChildren(...lines);
  status.className = lines.length > 0 ? "status error" : "status";
  status.textContent =
    lines.length > 0 ? `有 ${lines.length} 个问题需要先修正，保存不会写入任何文件。` : "没有问题，可以保存。";
}

function renderEditor() {
  if (editing === null) {
    editorNode.hidden = true;
    editorNode.replaceChildren();
    return;
  }
  editorNode.hidden = false;
  // 整棵 DOM 即将重建：上一轮的节点引用（标红表 / 回包目标）全部作废。
  issueTargets = new Map();
  sameAsMain = [];
  live = { hint: null, pre: null, status: null, issues: null };
  const rerender = () => renderEditor();
  const basics = renderBasics();
  const connection = renderConnection();
  const models = renderModels();
  const toggles = renderToggles();
  const advanced = renderAdvanced();

  const details = document.createElement("details");
  details.className = "preview";
  details.open = true;
  details.append(el("summary", "最终将写入 .claude/settings.local.json（掩码预览）"));
  const previewBody = el("pre", undefined, "json");
  details.append(previewBody);

  const issues = el("ul", undefined, "issues");
  const status = el("p", undefined, "status");
  const actions = el("footer", undefined, "editor-actions");
  const save = el("button", "保存", "primary");
  save.addEventListener("click", () => {
    // 草稿直接原样回传：host 侧再校验一次（isDraft + draftIssues），界面上的红字只是提示。
    vscode.postMessage({ type: "saveProfile", profile: profile() });
  });
  const cancel = el("button", "取消");
  cancel.addEventListener("click", () => {
    editing = null;
    resetEditorState();
    renderEditor();
  });
  actions.append(save, cancel, status);

  editorNode.replaceChildren(
    el("h2", editing.isNew ? "新建配置" : `编辑：${profile().name}`),
    renderPresets(rerender),
    basics,
    connection,
    models,
    toggles,
    advanced,
    details,
    issues,
    actions,
  );

  live.pre = previewBody;
  live.status = status;
  live.issues = issues;
  syncSameAsMain();
  renderPreview();
  requestPreview();
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
    for (const warning of result.warnings ?? []) nodes.push(el("p", warning, "hint"));
  }
  pasteResultNode.replaceChildren(...nodes);
}

/** 识别结果 → 一份**新草稿**：角色按 `${role}Model` 落到各自的映射行，不再全塞进主模型。 */
function applyParsedToDraft() {
  const picked = parsedRows.filter((row) => row.checkbox.checked !== false);
  if (picked.length === 0) return;
  const fresh = options().newProfile;
  const draft = {
    ...fresh,
    id: fresh.id === "" || fresh.id === "new" ? newId() : fresh.id,
    models: { ...fresh.models },
    toggles: [...fresh.toggles],
    env: [...fresh.env],
    overrides: { ...fresh.overrides },
    codex: { ...fresh.codex },
    opencode: { ...fresh.opencode },
  };
  const result = parsedResult();
  if (result !== null && typeof result === "object" && result.passthrough !== undefined && Object.keys(result.passthrough).length > 0) {
    draft.passthrough = result.passthrough;
  }
  for (const row of picked) {
    if (row.field === "baseUrl") draft.baseUrl = row.value;
    else if (row.field === "apiKey") {
      // 用户自己刚粘贴的明文密钥：直接作为「新密钥」进草稿，**不做掩码回填**（§7）。
      draft.apiKey = row.value;
    } else if (/Model$/.test(row.field)) {
      const role = row.field.slice(0, -"Model".length);
      // 只认 core 的角色清单（解析器给出的是 `${role}Model`，main/opus/sonnet/haiku/fable/subagent）。
      if (!options().roles.some((entry) => entry.id === role)) continue;
      draft.models[role] = { ...(draft.models[role] ?? {}), id: row.value };
    }
  }
  editing = { id: draft.id, isNew: true, profile: draft };
  resetEditorState();
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
    // 编辑中的配置被删掉了 → 关掉编辑区，避免对着空气保存。
    if (editing !== null && !editing.isNew && !data.cards.some((card) => card.id === editing.id)) {
      editing = null;
      resetEditorState();
    }
    render();
  } else if (message.type === "parsed") {
    parsedPayload = message.payload;
    pasteAreaNode.hidden = false;
    renderParsed();
  } else if (message.type === "projection") {
    onProjection(message.payload);
  } else if (message.type === "testResult") {
    notice = testResultText(message.payload);
    renderCards();
  } else if (message.type === "error") {
    notice = message.message;
    renderCards();
  }
});

newButton.addEventListener("click", () => {
  const fresh = options().newProfile;
  // 新建时就把 id 定下来：预览与保存用的是同一份 id（避免 "new" 这个哨兵值落到库里）。
  // 深拷贝一层数组/对象：newProfile 是**模板**，直接改它会把默认值污染给下一次新建。
  const id = newId();
  const draft = {
    ...fresh,
    id,
    models: { ...fresh.models },
    toggles: [...fresh.toggles],
    env: [...fresh.env],
    overrides: { ...fresh.overrides },
    codex: { ...fresh.codex },
    opencode: { ...fresh.opencode },
  };
  editing = { id, isNew: true, profile: draft };
  resetEditorState();
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
