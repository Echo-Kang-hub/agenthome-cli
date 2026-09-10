# 项目级模型配置 + 可视化配置界面设计（2026-09-10）

## 1. 背景与目标

两个真实场景：

1. 全局配置的模型正在别处干活，某个项目想用另一套模型（另一个 baseUrl / key / 模型 ID）。当前做法是手写 `.claude/settings.local.json`，字段多、易错、没有校验，也没有"这个项目现在到底用哪套"的单一事实来源。
2. 用户手里往往已经有一份现成配置（别人给的、从别处导出的、`.claude/settings.local.json` 全文），希望**粘贴一次**就把表单里的 baseUrl / key / 模型等空位填好，而不是逐字段复制。

目标：

- 项目内**多套**模型配置，可**一键切换**；切换后 `avenic claude` / `avenic codex` / `avenic opencode` 与插件直接启动 Agent 时都使用当前配置；
- 插件内提供可视化配置界面（仿 cc-switch 的表单 + 卡片列表），带保存按钮；
- 界面同时提供**粘贴区**：结构化 JSON 粘贴 → 自动补全表单字段（未识别的键原样保留，不丢信息）；自由文本粘贴 → 识别 baseUrl / key / 模型等并给出"识别到什么"的预览再填入；
- 提供**测试连接**（发一个最小真实请求），把"配错了"和"网络不通"区分开；
- 密钥不入 Git、不出现在 CLI 输出与日志中。

## 2. 已确认的选择（2026-09-10 用户逐条确认）

| 决策点 | 选择 | 影响 |
|---|---|---|
| 界面入口 | **编辑器标签页**（`WebviewPanel`） | 表单字段多，需要宽屏；不复用窄侧边栏 |
| 内置预设 | **要，少量** | 预设只做"少填几个字"的起点，不是配置库 |
| 配置套数 | **多套 + 一键切换** | 需要 profile 列表与激活态 |
| 测试连接 | **发一个最小真实请求** | 需要真实流量与配额提示，见 §9 |

## 3. 已验证事实（2026-09-10 本机验证）

| 结论 | 依据 |
|---|---|
| Claude Code 2.1.238 中存在本设计用到的全部环境变量键：`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_API_KEY`、`ANTHROPIC_MODEL`、`ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL`、`*_MODEL_NAME`、`CLAUDE_CODE_SUBAGENT_MODEL`、`CLAUDE_CODE_EFFORT_LEVEL`、`CLAUDE_CODE_MAX_OUTPUT_TOKENS`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`、`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`、`ENABLE_TOOL_SEARCH`、`DISABLE_AUTOUPDATER` | 已安装二进制的字符串统计 |
| 配置优先级：managed > CLI/`--settings` > `.claude/settings.local.json` > `.claude/settings.json` > `~/.claude/settings.json`；settings 里的 `env` **覆盖**同名 shell 环境变量 | 隔离环境实测（临时 `CLAUDE_CONFIG_DIR` + 本地假 endpoint 截获请求体） |
| `includeCoAuthoredBy` 已废弃，改用 `attribution: { commit, pr }` | 同上次调研结论 |
| Codex 项目级 `.codex/config.toml` **禁止** `model_provider` / `model_providers`（被忽略并告警）；`-c key=value` 是最高优先级；`wire_api = "responses"` 是唯一支持的协议（**无法指向 Anthropic 风格端点**） | Codex 官方配置文档 + 本机实测 |
| `CODEX_HOME` 重定向有效（avenic 的 project 认证模式已在用：`.agents/local/codex`） | `packages/core/src/runtime/config.mjs:110` |
| OpenCode 支持 `OPENCODE_CONFIG` / `OPENCODE_CONFIG_CONTENT` 做配置注入，优先级高于项目 `opencode.json`；**没有**模型相关的环境变量 | OpenCode 官方配置文档 |
| cc-switch（Tauri + React）是单列滚动式界面：卡片列表 + 全屏编辑面板 + 预设磁贴 + 悬停操作行 + 模型映射表（Sonnet/Opus/Fable/Haiku/Subagent + 主模型兜底）+ `[1M]` 标记 + 健康探测；**没有**粘贴 JSON 自动填充功能（该功能是本设计新增） | 上游仓库源码阅读 |

**实现期必须实测的 3 条**（本机有 Claude Code / Codex，可 5 分钟内验证；失败则走 §11 的降级行）：

1. Codex 的 `-c` 值在三种 shell（cmd / PowerShell / bash）下的引号穿透形态——决定插件集成终端用哪种传参方式（§5.2）；
2. project 认证模式（`CLAUDE_CONFIG_DIR` 重定向）下，Claude Code 是否照常读取项目 `.claude/settings.local.json`（复用上次的隔离探针装置）；
3. OpenCode 用 `provider.<内置 id>.options.baseURL` 覆盖内置 anthropic provider 是否生效（不生效则改为自定义 provider + `@ai-sdk/anthropic`）。

## 4. 数据模型：单一事实来源

**`.agents/model.json`**（项目内，gitignored；CLI 与插件读写同一个文件，避免两套配置漂移）：

```jsonc
{
  "schemaVersion": 1,
  "active": "mimo-project",              // 激活的 profile id；null = 未激活
  "profiles": {
    "mimo-project": {
      "name": "小米 MiMo（项目）",
      "endpoint": { "baseUrl": "https://token-plan-cn.xiaomimimo.com/anthropic", "api": "anthropic",
                    "authField": "ANTHROPIC_AUTH_TOKEN", "apiKey": "sk-…" },
      "overrides": {                      // 可选：按 Agent 覆盖端点（同一提供商的两种协议入口）
        "codex": { "baseUrl": "https://…/v1", "api": "openai-responses" }
      },
      "models": {                          // 主模型 + 五个角色（键名与 Claude 的映射键一一对应）
        "main":     { "id": "mimo-v2.5-pro" },
        "opus":     { "id": "mimo-v2.5-pro", "display": "mimo-v2.5-pro", "longContext": false },
        "sonnet":   { "id": "mimo-v2.5-pro", "display": "mimo-v2.5-pro", "longContext": true },
        "haiku":    { "id": "mimo-v2.5",     "display": "mimo-v2.5" },
        "fable":    { "id": "mimo-v2.5-pro", "display": "mimo-v2.5-pro" },
        "subagent": { "id": "mimo-v2.5" }
      },
      "toggles": { "teams": true, "toolSearch": true, "maxEffort": true,
                   "noNonessentialTraffic": true, "noAutoUpdate": false, "hideAttribution": true },
      "env": { "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "131072" },   // 自定义 env 键值（表单未覆盖的）
      "claude": { "settings": { "theme": "dark", "enabledPlugins": { … } } },  // 顶层透传键
      "codex":  { "providerId": "avenic_mimo_project", "envKey": "AVENIC_MODEL_KEY", "reasoningEffort": "high" },
      "opencode": { "providerId": "mimo", "npmAdapter": "@ai-sdk/openai-compatible" },  // npmAdapter 可选，默认按 api 类型推导
      "applied": { "claude": { "file": ".claude/settings.local.json", "created": false,
                               "keys": ["ANTHROPIC_BASE_URL", "…"], "attribution": true } }
    }
  }
}
```

- `applied` 是**可逆投影的记账**：只记录"我们写过什么"，用于切换 / 清除时精确回滚（§5.4），绝不据此删除用户自己的键。
- 文件权限：POSIX 下 `0o600`；Windows 依赖用户目录 ACL（不做额外处理，明写在文档里）。
- 为什么不是直接以 `.claude/settings.local.json` 为准：CLI 也要读写、要服务三个 Agent、要存多套与激活态，而 settings.local.json 只有 Claude 认识；它在本设计中是**投影产物**，不是事实来源。
- 为什么不用 VS Code 的 `globalState` / `SecretStorage` 存一份：会产生两套事实来源（CLI 读不到），明文文件反而是可解释、可备份、可手工编辑的。

## 5. 三个 Agent 的投影

### 5.1 Claude Code → 写 `.claude/settings.local.json`（合并写）

映射表（表单字段 → 文件内容）：

| 表单 | 写入 |
|---|---|
| Base URL | `env.ANTHROPIC_BASE_URL` |
| API Key | `env.ANTHROPIC_AUTH_TOKEN`（或 `env.ANTHROPIC_API_KEY`，随"认证字段"选择） |
| 主模型 | `env.ANTHROPIC_MODEL` |
| 角色模型（Opus/Sonnet/Haiku/Fable） | `env.ANTHROPIC_DEFAULT_<ROLE>_MODEL` + `env.ANTHROPIC_DEFAULT_<ROLE>_MODEL_NAME`（显示名留空则不写 `_NAME`） |
| 角色模型 · Subagent | `env.CLAUDE_CODE_SUBAGENT_MODEL` |
| 1M 勾选（仅 Opus/Sonnet，文档明确支持） | 该模型 ID 追加 `[1m]` 后缀 |
| Teams 开关 | `env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1"` |
| Tool Search | `env.ENABLE_TOOL_SEARCH = "true"` |
| Max Effort | `env.CLAUDE_CODE_EFFORT_LEVEL = "max"` |
| 禁用非必要流量 | `env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"` |
| 禁用自动更新 | `env.DISABLE_AUTOUPDATER = "1"` |
| 隐藏 AI 署名 | 顶层 `attribution = { "commit": "", "pr": "" }` |
| 自定义 env 键值 | 逐条写入 `env` |
| 顶层透传（`claude.settings`） | 原样写回（`theme`、`enabledPlugins`、`extraKnownMarketplaces`、`autoUpdatesChannel`…） |

规则：

- **合并写**：读取现有文件，只覆盖本 profile 的受管键与表单自有键；用户其他键一律保留（含 `permissions`、`hooks`、`statusLine` 等本设计不认识的键）。
- 1M 勾选只给 Opus / Sonnet：`[1m]` 后缀的官方说明只覆盖这两个映射键。cc-switch 对 Fable / Subagent 也提供该开关，但依据不足，本设计**不提供**（宁缺勿错）。
- 文件已存在 `includeCoAuthoredBy` 时**不删不改**，仅在面板给一次性提示"该字段已废弃，Claude Code 改用 `attribution`"。
- 自定义 env 表中的键与表单受管键冲突 → 保存时拒绝并高亮冲突项（不静默覆盖）。
- 写前把 `env` 中的值统一转成字符串（Claude Code 只接受字符串值）；写前校验 JSON 可解析（自写自读，防止手工编辑损坏后静默丢配置）。
- 写前确保 `.gitignore` 含 `.claude/settings.local.json` 与 `.agents/model.json`（§10）。

### 5.2 Codex → 启动时注入 argv + 环境变量（不落盘）

项目 `.codex/config.toml` 不允许 provider 键（§3），因此只做启动注入：

```
-c model_provider="<providerId>"
-c model_providers.<providerId>.name="<配置名>"
-c model_providers.<providerId>.base_url="<baseUrl>"
-c model_providers.<providerId>.env_key="<envKey>"
-c model_providers.<providerId>.wire_api="responses"
-m "<主模型 id>"
```

- 子进程环境追加 `[envKey] = apiKey`（默认名 `AVENIC_MODEL_KEY`，避免覆盖用户的 `OPENAI_API_KEY`）。
- CLI 路径（`avenic codex`）：`spawn` 直接传 argv 数组，**不经 shell**，`-c` 的值连同 TOML 引号原样到达 Codex（实现期实测项 1 只需覆盖插件路径）。
- 插件路径（集成终端）：优先 `createTerminal({ shellPath: <codex 可执行文件>, shellArgs: [...注入参数, ...用户参数], cwd, env })` 以 argv 直启，不拼命令行 → 无引号问题；实测项 1 若证明 shell 传参也稳定，才允许回退到 `sendText(command)` 形态。
- 注入值先过字符白名单（§10），不合格的配置直接拒绝保存（而不是"存下来但启动失败"）。
- 用户自己带了 `-m/--model` 或 `-c model_provider=…` 时**以用户为准**，本次启动不注入该参数。

### 5.3 OpenCode → 启动时注入 `OPENCODE_CONFIG_CONTENT`

注入 JSON（优先级高于项目 `opencode.json`）：

```json
{
  "model": "<providerId>/<主模型>",
  "small_model": "<providerId>/<haiku 行模型>",
  "provider": {
    "<providerId>": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "<配置名>",
      "options": { "baseURL": "<baseUrl>", "apiKey": "<apiKey>" },
      "models": { "<主模型>": {}, "<haiku 行模型>": {} }
    }
  }
}
```

- `api: "openai-responses"` / `"openai-chat"` → 自定义 provider + `@ai-sdk/openai-compatible`；
  `api: "anthropic"` → 覆盖内置 `anthropic` provider 的 `options.baseURL` / `apiKey`（实测项 3；不生效则退化为自定义 provider + `@ai-sdk/anthropic`，再不行则面板标"OpenCode 暂不支持该端点"）。
- 密钥只存在于子进程环境变量中，不落盘。

### 5.4 切换、清除与回滚

| 操作 | 行为 |
|---|---|
| 切换 profile（`use`） | 按新 profile 重新投影；先按旧 profile 的 `applied` 回滚受管键，再写新的 |
| 未激活（`active: null`） | 启动时**不注入任何模型配置**；`.claude/settings.local.json` 中受管键已按 `applied` 移除 |
| 清除（`clear`） | 移除受管键；若文件因此变空**且** `applied.claude.created` 为真（文件由本功能创建）→ 删除文件；否则保留空对象文件 |
| 删除某 profile | 若它是激活项则先执行 `clear`；仅删该 profile 的数据 |
| 回滚失败（文件被外部改坏） | 保留原文件不动，报错并给出"手工检查 `.claude/settings.local.json`"的提示；不改动 `.agents/model.json` |

### 5.5 与 A（Skills 单副本）的启动补齐共存

两者都在 `dispatchAgent` 的默认分支与插件 `prepareAgentLaunch` 上挂载：A 挂 `ensureSkillLinks`，B 挂模型注入。**B 的注入发生在 A 之后**（先确保技能链接，再决定启动环境），互不依赖；实现时各自独立，不做耦合。

## 6. CLI：`avenic model`

| 命令 | 说明 |
|---|---|
| `avenic model` / `avenic model show` | 显示当前项目配置：文件路径、激活 profile、端点、掩码密钥、模型映射、三个 Agent 的投影状态 |
| `avenic model list` | 列出所有 profile（`>` 标记激活项） |
| `avenic model use <name\|id>` | 激活并投影；无参数且是终端 → clack 风格单选 picker（沿用 `hub select` 的交互件） |
| `avenic model set [--name <n>] [--base-url <u>] [--api-key <k>] [--api <anthropic\|openai-chat\|openai-responses>] [--model <m>] [--json <file\|->]` | 新建或更新；`--json -` 从标准输入读整份配置（脚本可用） |
| `avenic model remove <name\|id>` | 删除（激活项需二次确认） |
| `avenic model test [name\|id]` | 最小真实请求（§9） |
| `avenic model clear` | 取消激活并回滚投影 |

- `set` 省略 `--name` 时更新**当前激活**的 profile；没有激活项则为用法错误（提示补 `--name` 新建），避免"以为改了 A、其实新建了 B"。
- 所有输出**掩码密钥**（`sk-…f3a2`），`--json` 的原始内容只回显识别结果、不回显密钥。
- `avenic model` 必须注册在 `packages/cli/src/cli/dispatcher.mjs:397-438` 的**兜底分支之前**（未知命令会落到 skills 分发器当 Pack id 处理）；`model` 与现有顶层命令、Agent 名均不冲突。
- 退出码：0 成功；1 用法/校验错误；2 测试连接失败（与"配置本身非法"区分，供脚本判断）。

## 7. 插件界面

### 7.1 形态与入口

- 入口命令：`avenic.model.open`（标题「Avenic: 模型配置」）打开**编辑器标签页**（`WebviewPanel`，`ViewColumn.Active`，单例：重复打开聚焦已有标签页）；`avenic.model.switch`（标题「Avenic: 切换模型配置」）= 现有 profile 的 QuickPick + 立即激活，即"一键切换"。
- 另在 Agents 视图标题栏与 Overview 面板各放一个入口（标题栏按钮 + Overview 卡片里的"模型配置"行）。
- 资源与 CSP 约定沿用现有 Dashboard：静态资源放 `media/model/`（`view.html` 模板 + `main.js` + `style.css`），`{{nonce}}` / `{{cspSource}}` 占位符注入，`localResourceRoots` 指向 `media`，**无远程资源、不用 `innerHTML` 渲染用户数据、颜色走 `--vscode-*` 主题变量**；图标用内联 SVG（不引入 codicon 字体，因而不需要 `font-src`）。

### 7.2 面板结构

**列表态**（cc-switch 风格卡片列）：

```
┌ ● 小米 MiMo（项目）              当前生效   [启用] [编辑] [复制] [测试] [删除] ┐
│   https://token-plan-cn.xiaomimimo.com/anthropic                            │
│   Claude ✓（已写入 settings.local.json）  Codex ✗（需 Responses API）  OpenCode ✓ │
└──────────────────────────────────────────────────────────────────────────────┘
```

- 每张卡片：名称（可点击编辑）、端点、密钥掩码、当前生效徽标、三个 Agent 的可用性（✓ / ✗ + 一句话原因）、悬停操作行。
- 顶部：[+ 新建配置] [粘贴导入] [刷新]；未激活时显示一行"当前项目未启用模型配置，`avenic claude` 使用全局配置"。

**编辑态**（占满标签页，分区块，底部固定 [保存] [取消]）：

| 区块 | 控件 |
|---|---|
| 预设 | 6 个磁贴（见下），点击预填端点与 API 类型 |
| 基本信息 | 配置名称、API 类型（anthropic / openai-chat / openai-responses） |
| 连接 | Base URL（含"将请求：`<解析后的测试地址>`"实时预览）、API Key（密码框 + 显示/隐藏 + 掩码回显）、认证字段（`ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` / `Authorization: Bearer` / `x-api-key`，默认随 API 类型） |
| 模型映射 | 6 行表格：主模型、Opus、Sonnet、Haiku、Fable、Subagent；每行"模型 ID + 显示名（Subagent 无）+ 1M 勾选（仅 Opus/Sonnet）"，四个角色行提供"同主模型"一键填充 |
| 开关 | 6 个开关（Teams、Tool Search、Max Effort、禁用非必要流量、禁用自动更新、隐藏 AI 署名），每行下方显示实际写入的键名 |
| 高级 · 自定义 env | 键值表（增删行、重复键校验） |
| 高级 · 按 Agent 覆盖 | Claude / Codex / OpenCode 各自的 baseUrl + API 类型（默认继承） |
| 高级 · 其他 | Claude 顶层透传键（只读 JSON 预览 + "在编辑器中打开"）、Codex（provider id / env 键名 / reasoning effort）、OpenCode（provider id / npm 适配器） |
| 底部预览 | 「最终将写入 `.claude/settings.local.json`」的折叠 JSON 预览（密钥掩码；含"仅预览、实际写入以保存为准"说明） |

预设（仅预填端点和 API 类型；**不预填模型 ID**——服务商的模型 ID 变动频繁，写死会立刻过期）：

| 预设 | API 类型 | 备注 |
|---|---|---|
| Anthropic 官方 | anthropic | |
| DeepSeek | openai-chat | |
| Kimi / Moonshot | anthropic | 官方有 Anthropic 兼容入口 |
| 智谱 GLM | anthropic | |
| OpenRouter | openai-chat | |
| 硅基流动 SiliconFlow | openai-chat | |

（端点 URL 在实现时按各家文档核对一遍再写进代码；磁贴下方标注"预设只是起点，请以服务商文档为准"。）

### 7.3 粘贴区（两种）

面板顶部「粘贴导入」打开一个全屏抽屉，两个标签页：

**① JSON 粘贴**：把整份 JSON 丢进大文本框 → 立刻解析 → 表单字段自动补全。
- 接受三种形态：Claude settings 形态（`{ "env": { … } }`）、扁平形态（`{ baseUrl, apiKey, model, … }`，键名大小写/下划线不敏感：`base_url` / `api_base` / `authToken` 等）、cc-switch 风格（`{ "settingsConfig": { … } }` 等包装字段，实现时按真实导出样例对齐）。
- 未识别的键**原样保留**并落到 `claude.settings` 透传区（保存时写回），不丢信息。仅当粘贴内容是 Claude settings 形态时如此；其他形态（扁平 / 包装字段）的未识别键只在粘贴预览里逐条列出，由用户勾选是否保留——避免把别的工具的私有关键字误写进 Claude 配置。
- 解析失败（不是 JSON）→ 提示并一键切到自由文本标签页。

**② 自由文本粘贴**：把 env 块、`export FOO=bar` 行、别人发的聊天片段整段丢进去，点「识别」，展示识别结果表（字段 / 值（掩码）/ 来源片段 / 勾选框）→ 用户确认后点「填入表单」。
- 识别规则（全部在 core 中实现、可单测）：URL 取首个 `https?://…`；键名行 `ANTHROPIC_BASE_URL|BASE_URL|base_url|api_base` → 端点；`ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|api[_-]?key|auth[_-]?token|token` → 密钥；`*_MODEL*|model|模型` 行 → 对应角色（带角色前缀时直接落位）；`sk-[A-Za-z0-9_-]{8,}` → 密钥候选。
- 同一字段多个候选 → 全部列出，默认选中第一个并标注"另有 N 个候选"，**不静默取第一个**。
- 模型名只在文本中出现明确的模型键时才识别；识别不到就留空并提示"未识别到模型名，请手工填写"（宁可少填，不可乱填）。
- **粘贴不会自动保存**：一律先落到表单，再由用户点 [保存]。

### 7.4 交互反馈

- 保存：走 core 的"校验 → 写 `.agents/model.json` → 投影"三步；成功后面板刷新、通知"已保存并生效"；失败按字段定位报错（端点非法 / 密钥为空 / 模型 ID 非法 / 自定义 env 冲突 / 目标文件不可写）。
- 启用：写 `active` 并投影，列表与三个 Agent 的可用性立即刷新。
- 测试：按钮进入 loading，结果以内联条展示（§9），不弹模态框。
- 所有 mutation 复用现有 `MutationQueue`（避免与 Agent/Skills 操作并发写文件）。

### 7.5 插件侧零 fs 逻辑

面板 JS（`media/model/main.js`）只做 DOM 与消息；**解析、校验、归一化、投影拼装、命令构造全部在 `@avenic/core`**（`.mjs`，有单测）。插件侧仅调用 core 导出的函数与既有服务层。这条与 A（`ensureSkillLinks`）保持一致。

## 8. 粘贴识别（core）

新模块 `packages/core/src/model/parse.mjs`：

- `parseConfigJson(text) → { profile, recognized: [...], unknown: {...} }`
- `parseConfigText(text) → { candidates: [{ field, value, source, confident }], unknown: [...] }`
- `recognizeEnvMap(env) → profile 字段`（安装/导出等场景复用）
- 纯函数、无 IO、无副作用，供 CLI（`--json`）、插件、测试三方复用。

## 9. 测试连接（最小真实请求）

- 目标地址按 API 类型解析（表单实时显示解析结果）：

| API 类型 | 请求 |
|---|---|
| anthropic | `POST <baseUrl>/v1/messages`，头 `x-api-key`（或 `Authorization: Bearer`，随认证字段）+ `anthropic-version: 2023-06-01`，体 `{ "model": <主模型>, "max_tokens": 1, "messages": [{"role":"user","content":"ping"}] }` |
| openai-chat | `POST <baseUrl>/v1/chat/completions`，头 `Authorization: Bearer`，体 `{ "model": …, "max_tokens": 1, "messages": […] }` |
| openai-responses | `POST <baseUrl>/v1/responses`，头 `Authorization: Bearer`，体 `{ "model": …, "input": "ping", "max_output_tokens": 16 }`（部分服务商对下限有要求） |

- baseUrl 以 `/v1` 结尾时按"已含版本段"处理，不再拼一次（表单预览里能直接看到最终地址）。
- 超时 15s；结果分类：`2xx` 成功（显示耗时、服务端返回的模型名、`usage` 若存在）；`401/403` 密钥无效或无权限；`404` 地址路径不对（提示检查 baseUrl 与 API 类型）；`429` 限流/配额；`5xx` 服务端错误；网络/DNS/TLS 失败 → 不可达（与"配置错误"区分）；超时 → 无响应。
- 失败时**同时给出"已确认可用/不可确认"的边界说明**：连接失败 ≠ 密钥无效（例如 404 时不说"密钥错误"）。
- 提示语必须写明：**测试会向该地址发送一次真实请求，消耗极少量额度**；密钥只发往用户填写的地址，avenic 自身没有任何服务端。

## 10. 安全与 Git

1. `.agents/model.json` 与 `.claude/settings.local.json` 含明文密钥。两者都加入项目 `.gitignore`：新增独立规则表 `MODEL_RULES`（`packages/core/src/model/gitignore.mjs`）与 `ensureModelGitignore(projectRoot)`，只在"保存模型配置"时调用（**不并入 `REQUIRED_RULES`**，避免改变 `init` 的既有输出与断言），并把 `.agents/model.json` 加入 `removeRuntimeGitignore` 的可移除集合 —— 但**仅在该文件不存在时**才移除规则（`gitignore.mjs:52-56` 的 guard），防止 deinit 后密钥文件变成"可提交"。
2. 密钥显示一律掩码（前 3 后 4）；CLI 不回显明文；不写日志；错误信息里出现密钥时同样掩码。
3. 注入值的字符白名单（保存时校验，不合格直接拒绝）：
   - baseUrl：`^https?://[A-Za-z0-9._~:/?#\[\]@!+,;=()\-]+$`（排除空格、引号、反引号、`$`、`&`、`%` —— 既避免 shell 语义，也避免插件拼接问题）
   - provider id：`^[a-z0-9_]{1,32}$`；envKey：`^[A-Z][A-Z0-9_]{0,63}$`；模型 ID：`^[A-Za-z0-9._:\-/]{1,128}$`
4. `.claude/settings.local.json` 的写入**只增不删**：仅删除 `applied.claude.keys` 中记录过的键；其余键（含用户自行添加的同名键在 `applied` 之前就存在的场景）不动。
5. 不写任何用户主目录下的全局配置（`~/.claude`、`~/.codex`、`~/.config/opencode` 一律不碰）。

## 11. 降级与错误处理

| 情况 | 处理 |
|---|---|
| Codex `-c` 引号穿透在插件终端不稳定（实测项 1） | 改用 `shellPath/shellArgs` argv 直启；两者都不可行才启用 `.agents/local/codex/config.toml` + `CODEX_HOME` 组合 home 的备选方案（不在 v1 实现，需另立 spec） |
| Claude Code 在 `CLAUDE_CONFIG_DIR` 重定向下不读项目 `.claude/settings.local.json`（实测项 2） | 补一条启动时环境注入（仅 project 认证模式），并在面板标注该模式的差异 |
| OpenCode 内置 anthropic provider 覆盖不生效（实测项 3） | 退化为自定义 provider + `@ai-sdk/anthropic`；仍不生效 → 面板标"OpenCode 暂不支持该端点"，其余两个 Agent 不受影响 |
| 端点协议与 Agent 不兼容（最典型：Anthropic 风格端点 + Codex） | **不静默跳过**：配置列表与 `avenic model show` 明确标 ✗ 与原因，启动该 Agent 时打印一行"该配置不适用于 Codex，本次使用其全局配置" |
| `.claude/settings.local.json` 不可写（只读/被占用） | 保存失败并保留原文件；`.agents/model.json` 也不写入（两次写要么都成功、要么都不动），提示改用"按 Agent 覆盖"或检查目录权限 |
| `.agents/model.json` 被手工改坏 | `model` 命令报可读错误并指向行号；插件面板显示"配置损坏"卡片 + 「在编辑器中打开」，不做自动修复 |
| 无 profile / 未激活 | 所有注入静默跳过；`avenic <agent>` 行为与今天完全一致 |

## 12. 影响面

| 位置 | 改动 |
|---|---|
| `packages/core/src/model/*.mjs` | **新增**：`schema.mjs`（校验/归一化）、`store.mjs`（读写 `.agents/model.json`）、`project-claude.mjs`（settings.local.json 合并/回滚）、`inject.mjs`（codex argv / opencode env / claude env）、`parse.mjs`（§8）、`presets.mjs`、`probe.mjs`（§9）、`gitignore.mjs`（§10.1） |
| `packages/core/src/index.mjs` | 导出新模块 |
| `packages/core/src/runtime/gitignore.mjs` | `removable` 集合加 `.agents/model.json` + "文件仍存在则不删规则" guard |
| `packages/cli/src/cli/dispatcher.mjs` | `model` 顶层命令分发（必须在兜底分支前）；`dispatchAgent` 启动注入接入点（`:243-245` 环境、`:297` argv） |
| `packages/cli/src/cli/model-cli.mjs` | **新增**：`model` 子命令实现与输出 |
| `packages/cli/vendor/core-src/**` | `npm run sync-core` 同步（`test/sync.test.mjs` 守护） |
| `packages/vscode/src/dashboard/model-panel.ts` | **新增**：`WebviewPanel` 薄壳（模板注入、消息白名单守卫、数据回传） |
| `packages/vscode/src/services/model.ts` | **新增**：把 core 的读写/投影/测试包装成服务层 |
| `packages/vscode/src/commands/model-commands.ts` | **新增**：`avenic.model.open` / `avenic.model.switch` |
| `packages/vscode/src/services/agents.ts` | 启动注入（argv + env），与 A 的 `ensureSkillLinks` 相邻 |
| `packages/vscode/media/model/{view.html,main.js,style.css}` | **新增**（Dashboard 同款 CSP/主题约定） |
| `packages/vscode/package.json` | 2 个命令 + 视图标题按钮 + Overview 入口 |
| 文档 | README×2、`docs/development.md`、`packages/vscode/CHANGELOG.md` |

## 13. 测试

新增加：

- core 单测：schema 校验（各字段白名单、冲突键、缺字段）、store 读写与损坏文件、settings.local.json 合并（保留未知键 / 只删受管键 / `created` 语义 / 空文件删除）、codex argv 构造（用户自带 `-m` 时让位）、opencode 注入 JSON、`parse.mjs` 三种 JSON 形态 + 自由文本识别（含多候选、无模型名、非 JSON 输入）、presets 合法性（URL 白名单）、probe 的结果分类（本地 mock server 覆盖 200/401/403/404/429/500/超时/网络失败，**不发真实请求**）。
- CLI：`model` 各子命令输出与退出码、掩码、未激活时 `avenic <agent>` 行为不变、`model` 不落到 Pack 兜底分支。
- 插件：面板 HTML/CSP 无远程资源与 `innerHTML`、消息白名单拒绝未知消息、命令注册与 QuickPick 切换、注入参数在启动定义中的落地。
- gitignore：保存后两条规则存在；`deinit --purge` 后 `.agents/model.json` 仍在且规则仍在（文件存在的场景）。
- 端到端（本机、隔离目录）：`use` → 启动 mock Agent 捕获 env/argv → 断言实际注入值；`clear` → 断言受管键被移除且用户键保留。

需同步的既有断言：`packages/cli/test/cli-surface.test.mjs`（命令清单/帮助输出）、`packages/vscode/test/{manifest,views,agents-commands}.test.ts`（命令数、启动定义）、`packages/core/test/gitignore*.test.mjs`（可移除集合）。

## 14. 发布顺序

1. bump `packages/core`（新增导出 + gitignore guard 行为微调）→ 发布 `@avenic/core`；
2. `npm run sync-core` → bump `packages/cli` → 发布 `avenic`；
3. bump `packages/vscode`（依赖新 core + 新命令 + 面板）→ 打包 VSIX（Marketplace 上传按既有 USER CHECKPOINT 规则）。

与 A 的关系：A 先发（磁盘去重、改动面小、已被用户确认）；B 在其后独立发一版 core 次版本。两者对 `dispatchAgent` / `prepareAgentLaunch` 的改动相邻但独立，**不合并为一个 PR**，以便任一功能出问题时单独回滚。

## 15. 明确不做

- 不做全局（跨项目）模型配置——全局配置是各 Agent 自己的全局设置，avenic 只碰项目；
- 不写 `~/.claude`、`~/.codex`、`~/.config/opencode` 下的任何文件；
- 不改 Codex 项目 `.codex/config.toml`（官方禁用 provider 键）；
- 不做 `.agents/local/codex` 组合 home 方案（仅在 §11 作为最后备选记录）；
- 不预填具体模型 ID（易过期）；不内置在线预设更新（不引入远程请求）；
- 不自动定期测活 / 不在启动时探测（避免每次启动都打真实请求）；
- 不做密钥的加密存储（本机明文文件 + 0600 + gitignore，与现有 `.agents/local/` 凭据策略一致）；
- 不做跨设备同步 / 云同步。

## 16. 开放问题

无未决设计问题；§3 的三条"实现期必须实测"已各自绑定 §11 的降级行，不阻塞本 spec 定稿。
