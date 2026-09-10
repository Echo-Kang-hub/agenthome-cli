# Changelog

## 0.1.10

- **扩展图标**：新增 `media/icon.png`（128×128 PNG，Avenic 品牌标记 + 字标）并声明
  `package.json` 顶层 `icon` 字段，Marketplace 与扩展列表不再显示默认占位图。
  侧边栏活动栏图标仍用 `media/icon.svg`（24px 单色，跟随主题着色，二者用途不同）。

## 0.1.9

- **Catalog → Hub 更名**：插件面向用户的标题/文案统一改为 Hub（视图「Catalog」→「Hub」、
  Overview 项目卡片、快捷动作「同步 Hub」、命令标题「添加/选择/默认/同步 Hub」、
  树标签「Hub Packs」及各提示/错误消息），与 SkillsHub 品牌一致。
  命令 ID（`avenic.catalog.*`）、视图 ID、`AVENIC_CATALOG_SPEC` 环境变量与 CLI（`avenic catalog`）
  保持不变；纯标识符（CatalogViewProvider 等）与源码注释中的技术命名未动。
- **Overview Agent 行降级改容器查询**：文字压缩改为按卡片自身宽度（`@container`）逐级降级——
  第一级（≤430px）只隐「已初始化 · global/project」状态行与元信息行，名称「Claude Code」保留显示；
  第二级（≤180px）名称也隐，只剩品牌图标 + 状态点。之前的视口断点（600px/430px）会在文字
  仍可容纳时提前隐藏（文字放得下也显示图标），已废弃；视口 @media 只保留非 agent 内容的降级
  （提示行、技能细节、卡片元信息/提示、字号缩放）。
- **修正 Codex / OpenCode 官方标记**：codex 从「六边形+圆点」改为官方六边形环结+水平短杠
  （路径数据取自 LobeHub 官方静态图标库 codex.svg，单 path fill-rule=evenodd）；
  opencode 从「圆环+圆点」改为官方方形回字框 O（外框镂空 + 偏下半透明内块）。

## 0.1.8

- **CLI 交互（clack 风格）**：`avenic skills install`（无参 + 终端）→ 多选 Packs
  （space 切换 / a 全选 / n 清空，common 预选）→ Yes/No 确认 → 旋转安装指示 →
  ╭╮ 摘要框 + ✓ Done；`avenic skills uninstall`（无参 + 终端）→ Yes/No 确认后清空
  并给摘要；`avenic catalog select` 换 clack 风格单选 picker（◇ ◆ ● ○ ▸ │ ✖ 字符帧）。
  交互仅在 TTY 生效，管道/脚本路径维持原行为（install 默认 common、uninstall 直接执行）。
  配套发布 `avenic@1.0.1`（CLI，仍为零依赖）。
- **Overview 响应式**：面板横向压缩分两级降级——≤600px 隐藏非关键元信息；
  ≤430px 最终态 agent 行只留「品牌图标 + 状态点」（claude 星芒 / codex 六边形 /
  opencode 环形，inline SVG 单色 currentColor，无远程资产），完整信息移入悬停 tooltip。
- **跨平台**：CLI 交互层与新增路径无平台特定假设（win32 的 .cmd/.ps1 shim 由
  core 1.0.4 解析器覆盖；ANSI 帧代码为 VT100 通用集，macOS/Windows/Linux 一致）。

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
