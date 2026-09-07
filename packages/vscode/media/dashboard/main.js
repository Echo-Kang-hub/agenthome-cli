// Dashboard webview 脚本（T10 骨架：数据渲染通路 + ready/refresh/error 握手；视觉由 T11 完善）。
// 安全：所有数据仅经 createElement/textContent 渲染，绝不使用 innerHTML 拼接用户字符串（设计 §4）。
"use strict";

const vscode = acquireVsCodeApi();
const app = document.getElementById("app");

function el(name, text, className) {
  const node = document.createElement(name);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function section(title, rows) {
  const box = el("section", undefined, "section");
  box.append(el("h2", title));
  for (const row of rows) box.append(row);
  return box;
}

function renderData(data) {
  const projectRows = [el("p", data.projectRoot === null ? "未打开项目" : data.projectRoot)];
  const agentRows = data.agents.map((agent) => {
    const row = el("div", undefined, "agent-row");
    row.append(el("span", agent.label, "agent-label"));
    row.append(el("span", agent.statusText, "agent-status"));
    return row;
  });
  const catalogRows = data.catalog === null
    ? [el("p", "未选择")]
    : [el("p", data.catalog.spec), el("p", "修订：" + data.catalog.revision)];
  const skillRows = data.skillsHealth.map((entry) =>
    el("p", entry.label + " · " + (entry.ok ? "正常" : "异常") + " · " + entry.details));
  app.replaceChildren(
    section("项目", projectRows),
    section("Agents", agentRows),
    section("Catalog", catalogRows),
    section("Skills", skillRows),
  );
}

function renderError(message) {
  app.replaceChildren(section("错误", [el("p", message)]));
}

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg === null || typeof msg !== "object") return;
  if (msg.type === "data") renderData(msg.payload);
  else if (msg.type === "error") renderError(msg.message);
  else if (msg.type === "refresh") vscode.postMessage({ type: "ready" }); // 重载请求：等待 provider 重发数据
});

// 脚本就绪即宣告：provider 对 resolver 期间的早期发送会被丢弃，ready 后补发一轮
vscode.postMessage({ type: "ready" });
