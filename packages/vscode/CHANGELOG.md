# Changelog

## 0.1.7

- **启动 Agent**：已初始化行新增「启动」键位，插件直接在集成终端运行官方 CLI，
  无需安装 @avenic/cli npm 包；项目会话快照/回收与 `avenic claude` 同机制。
- **初始化只选一次作用域**：四象限作用域组合合并为一次 QuickPick，去掉重复提问。
- **安装 / 升级 Agent CLI（图标键）**：未安装 → cloud-download 键一键执行
  `npm install --global <pkg>@latest`；本机 `--version` 与 npm registry 对比出现
  「可升级」状态（arrow-up 键），探测结果 10 分钟缓存。Windows 下 npm 生成
  `.cmd` shim（如 opencode.cmd）由 core 1.0.4 修正为可探测，不再误报「可执行文件缺失」。
- **SkillsHub**：Catalog 默认源更名为 `Echo-Kang-hub/SkillsHub`。

## 0.1.0

首版发布。功能一览：

- **Agents**：初始化 / 移除 Agent，切换认证模式与会话存储（global / project 双作用域），
  会话导入与写回。
- **Catalog**：添加 / 选择 / 设置默认 / 同步 Catalog。
- **Skills**：浏览 Packs 并一键安装 / 卸载，添加与移除直装 Skill。
- **Overview**：项目级的 Agents / Catalog / Skills 状态汇总面板。
