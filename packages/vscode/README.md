# Avenic VS Code 扩展

Avenic 的图形界面：在 VS Code 中管理 Avenic Agent 运行时与 Skills，并提供 Hub / Overview 面板。

## 安装

从 Marketplace 安装：搜索 `Avenic Agent Manager`（扩展 ID `EchoKang.avenic-agent-manager`）。

本地打包为 VSIX 后安装：

```bash
npm --prefix packages/vscode run package
code --install-extension packages/vscode/dist/avenic-agent-manager.vsix
```

也可以在 VS Code 中手动安装：「扩展」面板 → 右上角 `...` → 「从 VSIX 安装…」→ 选择
`packages/vscode/dist/avenic-agent-manager.vsix`。首次安装未签名 VSIX 出现信任提示时选择「信任」即可。

## 功能

- **Agents 视图**：查看已安装 Agent 与初始化状态；右键 Agent 可初始化 / 移除、切换认证模式、
  切换会话存储（global / project 双作用域）、导入与写回会话。
- **Hub 视图**：添加 / 选择 / 同步 Hub，设置默认 Hub；当前 spec 在顶部显示。
- **Skills 视图**：浏览 Packs 中的 Skills，一键安装 / 卸载 Packs，添加与移除直装 Skill。
- **Overview 面板**：一屏汇总当前项目的 Agent 状态、Hub spec 与 Skills 安装完成度，
  并可点击项目根直接跳转目录。

所有命令同时在命令面板（`Avenic: ...`）中可用。

## 测试

```bash
npm --prefix packages/vscode test
```

同步执行 `tsc --noEmit` 类型检查与打包后的 `node --test` 测试套件。根仓库亦可通过
`npm run test:vscode` 运行同一套测试。

## 开发宿主（Extension Development Host）启动注意

扩展入口为 `packages/vscode/dist/extension.js`（`package.json` 的 `main` 字段），因此启动开发宿主前
必须先构建：

```bash
npm --prefix packages/vscode run build
```

随后用 VS Code 打开 `packages/vscode` 目录，按 `F5` 并在弹出的提示中生成「扩展开发宿主
(Run Extension)」调试配置（本扩展未随附 `launch.json`）；或使用命令行直接启动开发宿主：

```bash
code --extensionDevelopmentPath packages/vscode <示例项目目录>
```

缺少 `dist/extension.js` 时扩展无法加载——先跑 `npm --prefix packages/vscode run build` 即可。

## 配置与状态说明

- `avenic.projectRoot`：Workspace 状态键（`workspaceState`），由扩展在**多根工作区**下记忆用户
  选定的项目根，单根工作区自动使用唯一文件夹、无需选择。该键由扩展内部管理，无需手动修改；
  移除项目文件夹后记忆自动失效。
- **AVENIC_* 环境变量继承**：扩展运行在 VS Code 宿主进程内，直接继承宿主的 `process.env`，
  因此在启动 VS Code 前设置的环境变量即可生效，例如：

  - `AVENIC_CATALOG_SPEC` / `AGENTHOME_CATALOG_SPEC`：指定 Hub spec（优先 `AVENIC_*`）；
  - `AVENIC_STATE_DIR` / `AGENTHOME_STATE_DIR`：指定 State 目录。

  在 `launch.json` 调试配置中通过 `env` 注入的变量仅在对应调试会话生效，对扩展主体同样继承。

## 截图

> 截图占位空块：Agents 视图、Hub 视图、Skills 视图、Overview 面板的截图待补充。
> 发布前请在此处按上图格式插入 4 张实际截图（`media/screenshots/`）。

## License

[MIT](./LICENSE)
