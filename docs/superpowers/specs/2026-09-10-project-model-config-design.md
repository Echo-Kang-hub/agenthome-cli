# 本机模型配置库 + 项目绑定 + 可视化配置界面设计（2026-09-10，修订版 2）

> 修订记录：v2 按用户复审意见重构为**两层模型**（本机 profile library + per-project binding，§4）、重写回滚记账（§6）、新增事务与并发（§5.5）、dangling 引用（§7）、multi-root/远程语义（§9.5/§9.6）。v1 中"Claude 写项目 settings.local.json / Codex 启动注入 / OpenCode 注入 / 粘贴识别 / 测试连接"等结论保留（§10、§11）。

## 1. 背景与目标

需求（用户 2026-09-10 最终明确）：

> Avenic 应该像 cc-switch 一样，在一台机器上保存多套模型/Provider 配置，然后每个项目可以从这些已经保存的配置中一键选择当前配置。项目 A 可以用 MiMo，项目 B 可以同时用 Kimi，项目 C 可以不选择 Avenic profile 而继续使用 Agent 自己的全局配置。Avenic 没有服务器、没有账号，这些数据全部只存在当前设备本地。

目标：

- **本机（设备级）**：一份 Avenic 自有的 profile 库，保存多套 endpoint / key / 模型映射，CLI 与 VS Code 插件读同一份文件；
- **项目级**：每个项目单独选择"用哪一套"（或不选）；项目之间互不影响；选择的是一次绑定，改库即对所有项目生效（下次应用）；
- 切换后 `avenic claude` / `avenic codex` / `avenic opencode` 与插件直接启动 Agent 都使用该配置；
- 插件里像 cc-switch 一样可视化增删改查 + 一键"用于当前项目"，带保存按钮；
- 粘贴区：结构化 JSON → 自动补全表单（未识别键保留）；自由文本 → 识别并预览后填入，不静默保存；
- 测试连接：发一个最小真实请求，区分"配错"与"网络不通"；
- 本机库与项目文件都不进 Git；密钥在所有输出中掩码。

## 2. 已确认的选择

| 决策点 | 选择 | 来源 |
|---|---|---|
| 界面入口 | 编辑器标签页（`WebviewPanel`） | 用户 2026-09-10 |
| 内置预设 | 要，少量（只预填端点与 API 类型） | 用户 2026-09-10 |
| 配置套数 | 多套 + 一键切换 | 用户 2026-09-10 |
| 测试连接 | 发一个最小真实请求 | 用户 2026-09-10 |
| 库/绑定的分层 | 本机库 + 项目绑定 | 用户修订 B1 |
| 删除 profile 后的项目引用 | 安全回滚 + 提示 + 清空绑定 | 用户修订 B4 |
| 事务与并发 | 原子替换 + 版本戳 + 重读重放（§5.5） | 用户修订 B5 |

## 3. 已验证事实

### 3.1 Agent 侧（2026-09-10 本机验证）

| 结论 | 依据 |
|---|---|
| Claude Code 2.1.238 存在本设计用到的全部 env 键：`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_API_KEY`、`ANTHROPIC_MODEL`、`ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL`、`*_MODEL_NAME`、`CLAUDE_CODE_SUBAGENT_MODEL`、`CLAUDE_CODE_EFFORT_LEVEL`、`CLAUDE_CODE_MAX_OUTPUT_TOKENS`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`、`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`、`ENABLE_TOOL_SEARCH`、`DISABLE_AUTOUPDATER` | 已安装二进制字符串统计 |
| 配置优先级：managed > CLI/`--settings` > `.claude/settings.local.json` > `.claude/settings.json` > `~/.claude/settings.json`；settings 的 `env` **覆盖**同名 shell 环境变量 | 隔离环境实测 |
| `includeCoAuthoredBy` 已废弃，改用 `attribution: { commit, pr }` | 同上 |
| Codex 项目级 `.codex/config.toml` **禁止** `model_provider` / `model_providers`（忽略并告警）；`-c key=value` 最高优先级；`wire_api = "responses"` 仅支持（**无法指向 Anthropic 风格端点**） | Codex 配置文档 + 本机实测 |
| Codex `-c` 的值先按 TOML 解析，**解析失败则按原始字符串**（并剥掉首尾引号）——所以 `-c key=https://x/v1` **不需要加引号** | openai/codex `codex-rs/utils/cli/src/config_override.rs`（`splitn(2,'=')` + raw-string 回退） |
| Codex 内置 provider id（如 `openai`）**不可覆盖**；要换 base URL 必须用自定义 id | `config-reference` 文档 + 本机 `codex -c model_providers.openai.base_url=…` 实测报 `reserved built-in provider IDs` |
| `codex --version` **完全不解析配置**（非法 TOML 也 exit 0）→ 探针不能用它；用只读不联网的 `codex mcp list` | 本机 0.150.1 实测（`-c 'mcp_servers=[['` + `--version` 仍 exit 0） |
| Windows `.cmd/.bat` 链路上，含 `& ^ \|` 且**未被引号包裹**的参数会被 cmd 破坏（`A&B` → 报错、`A^B` → 变成 `AB`）；`%VAR%` 连引号内也会展开 | 本机经 `codex.cmd` 实测 |
| Windows 上引号**不会**被 cmd 吃掉（`-c x="4"` 到达 Codex 的是带字面引号的字符串 `"4"`，POSIX 下同样的命令得到整数 `4`）→ 不能靠引号区分类型 | 本机实测（`-c mcp_servers=42` → integer，`-c mcp_servers="42"` → string） |
| 本机 `where codex` 首选项是 `codex.exe`（不是 `.cmd`），仓库 `resolveOnPath` 的扩展名优先级也会先命中 `.exe`；只有纯 npm/bun 安装（仅 `codex.cmd`）才走 cmd 拼接路径 | 本机 `where codex` + `process.mjs:21-39` |
| `CODEX_HOME` 重定向有效 | `packages/core/src/runtime/config.mjs:110` |
| OpenCode 支持 `OPENCODE_CONFIG` / `OPENCODE_CONFIG_CONTENT` 注入，优先级高于项目 `opencode.json`；**没有**模型相关的环境变量（`{env:VAR}` 只能在配置值里做替换，未设置时替换为空串） | OpenCode `config.mdx` 优先级列表 + `packages/core/src/flag/flag.ts` 环境变量登记表 |
| OpenCode **可以覆盖内置 provider 的 `options.baseURL` / `options.apiKey`**（官方文档示例就是内置 `anthropic`），provider 解析走 `mergeDeep(existing.options, provider.options)`、`resolveSDK` 里 `options.baseURL` 优先于 `model.api.url`、`options.apiKey` 优先于 auth.json/env；内置 anthropic 仍用 `@ai-sdk/anthropic` | anomalyco/opencode 文档 + `provider.ts`（mergeProvider/resolveSDK/BUNDLED_PROVIDERS） |
| cc-switch 是"卡片列表 + 全屏编辑面板 + 预设磁贴 + 悬停操作行 + 模型映射表 + 健康探测"；**没有**粘贴 JSON 自动填充（本设计新增） | 上游仓库源码阅读 |

### 3.2 仓库侧（本次修订读取的真实代码）

| 结论 | 依据 |
|---|---|
| 机器级 Avenic 状态根**已存在**：`stateRoot(env)` = `AVENIC_STATE_DIR` → 否则 `XDG_CONFIG_HOME` → 否则 `~/.config`，加 `avenic`；已有 `catalog.json`/`catalogs.json`/`config.json`/`lock.json`/`catalog/` 同住于此 | `packages/core/src/skills/paths.mjs:43-100` |
| 文件级事务原语**已存在**：`replaceStagedFiles(replacements, tempDirectory)` —— 先 `rename(target, backup)`、再 `rename(staged, target)`，任一步失败则回滚已完成的替换并抛出 | `packages/core/src/skills/vendor.mjs:26-57`（core 已导出） |
| 同卷 rename 语义、备份/回滚目录模式可参照 `replaceDirectory` | `packages/core/src/runtime/sessions.mjs:67-101` |
| 路径比较与哈希原语**已存在**：`samePath`（win32 大小写不敏感）、`hashContent`（sha256） | `sessions.mjs:18-27`、`:166-168` |
| `writeJson` 是**普通** `writeFile`（无原子性），`readJson` 解析失败直接 `fail` | `packages/core/src/util/json.mjs:4-14` |
| 插件侧 `MutationQueue` 只做**进程内**串行（promise 链），不跨窗口、不跨进程；无文件锁 | `packages/vscode/src/ui/mutation-queue.ts:1-23` |
| 项目根解析：单根直接返回，**0 根或多根都返回 null**；多根走 `pickProjectRoot`（有效的"上次记住的根" → 否则 QuickPick），**从不静默取 `folders[0]`** | `packages/vscode/src/project.ts:12-16`、`src/ui/flows.ts:33-46` |
| 插件**没有任何编辑器标签页 WebviewPanel**（现有 webview 只有侧边栏 Overview），且测试**没有 vscode stub** → 面板宿主类无法单测，数据组装必须放在 vscode-free 模块 | `src/dashboard/overview.ts:9-62`、`test/build-tests.mjs` |
| 插件通过**已发布的** `@avenic/core`（当前 `^1.0.4`）调用 core，不使用 vendor 副本；`packages/cli/vendor/core-src` 只服务 CLI | `packages/vscode/package.json:404`、`scripts/sync-core.mjs` |
| CLI 启动注入点：`environment` 构造与 `launchExecutable(executable, argumentsList, {cwd, environment})` | `packages/cli/src/cli/dispatcher.mjs:243-245`、`:295-297` |
| Windows 下 npm 全局安装的 Agent CLI 是 `.cmd` shim，会被 `invocation()` 拼成 **shell 命令行**（`/[\s"]/` 时用双引号包裹），即 **argv 会在 cmd.exe 里被二次解析** | `packages/core/src/runtime/process.mjs:21-39` |
| 全局作用域测试被明确禁止写真实用户目录；测试统一用 `testEnv()`（剥离 `AVENIC_*`、可注入 `AVENIC_STATE_DIR`） | `packages/vscode/test/helpers.ts:7-15`、`test/skills-commands.test.ts:72-74` |

### 3.3 实测项（原 3 条，已结清 2 条）

1. ~~Codex `-c` 值在 Windows 的传递形态~~ → **已结清**（§3.1）：不加引号即可（raw-string 回退），但含 `& ^ |` 的值在 `.cmd` 链路上必须被引号包裹，`%` 无论如何都会展开。设计结论写进 §5.2 与 §12.6：值一律不加引号 + 通过白名单拒绝 `%`、引号、反引号与 cmd 元字符；同时**加固 `process.mjs` 的 cmd 行拼接**（把 `&|^<>()` 纳入"需要引号包裹"的触发条件），使带查询串的 URL（`?api-version=…&x=y`）在 `.cmd` 路径上安全。
2. **project 认证模式（`CLAUDE_CONFIG_DIR` 重定向，`config.mjs:108`）下 Claude Code 是否仍读取项目 `.claude/settings.local.json`** —— 仍需实现期实测（这是本机隔离探针，无法从文档判定）。**降级**：§13。2026-09-11 探针尝试：隔离临时目录 + `CLAUDE_CONFIG_DIR` 重定向 + 占位 token，`claude -p "hi" --output-format json` 在 90s 硬超时内 stdout/stderr 全空（ETIMEDOUT/SIGTERM），未取得可判定证据，该条仍未结清（列入残留风险）。
3. ~~OpenCode 覆盖内置 anthropic provider 是否生效~~ → **已结清**（§3.1）：官方支持，内置 anthropic 的 `options.baseURL`/`options.apiKey` 直接生效，因此 §5.3 首选"覆盖内置 provider"，"自定义 provider + `@ai-sdk/anthropic`"只作为兜底（社区报告该组合有丢 apiKey 的已知问题）。

## 4. 数据模型：两层

### 4.1 本机 profile 库（设备级 SSOT）

**路径**：`modelsFile(environment) = path.join(stateRoot(environment), "models.json")`

- 复用既有的 Avenic 机器级状态根（§3.2），因此**不是** `~/.avenic/models.json`：仓库已有 `~/.config/avenic`（Windows 为 `%USERPROFILE%\.config\avenic`）作为"avenic 自己拥有、CLI 与插件共用、不属于任何 Agent"的目录，并已支持 `AVENIC_STATE_DIR` 覆盖（测试隔离）与历史目录迁移。新增第二个根会制造两套事实来源。
- 该路径落在 **CLI / VS Code Extension Host 实际运行的环境**（本地 Windows → Windows 家目录；WSL → WSL 家目录；Remote SSH → 远端家目录），彼此独立（§9.6）。

```jsonc
{
  "schemaVersion": 1,
  "revision": 7,                       // 每次写入 +1；并发写保护（§5.5）
  "profiles": {
    "mimo": {
      "id": "mimo",
      "name": "小米 MiMo",
      "endpoint": { "baseUrl": "https://token-plan-cn.xiaomimimo.com/anthropic", "api": "anthropic", "authField": "ANTHROPIC_AUTH_TOKEN", "apiKey": "sk-…" },
      "overrides": { "codex": { "baseUrl": "https://…/v1", "api": "openai-responses" } },
      "models": {
        "main": { "id": "mimo-v2.5-pro" },
        "opus": { "id": "mimo-v2.5-pro", "display": "mimo-v2.5-pro", "longContext": false },
        "sonnet": { "id": "mimo-v2.5-pro", "display": "mimo-v2.5-pro", "longContext": true },
        "haiku": { "id": "mimo-v2.5", "display": "mimo-v2.5" },
        "fable": { "id": "mimo-v2.5-pro", "display": "mimo-v2.5-pro" },
        "subagent": { "id": "mimo-v2.5" }
      },
      "toggles": { "teams": true, "toolSearch": true, "maxEffort": true, "noNonessentialTraffic": true, "noAutoUpdate": false, "hideAttribution": true },
      "env": { "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "131072" },
      "claude": { "settings": { "theme": "dark", "enabledPlugins": {} } },
      "codex": { "providerId": "avenic_mimo", "envKey": "AVENIC_MODEL_KEY", "reasoningEffort": "high" },
      "opencode": { "providerId": "mimo", "npmAdapter": "@ai-sdk/openai-compatible" },
      "createdAt": "2026-09-10T00:00:00.000Z",
      "updatedAt": "2026-09-10T00:00:00.000Z"
    }
  }
}
```

- **库不含任何项目信息**，也不含"当前激活"概念——激活是项目侧的。
- 密钥只在这一个文件里（v1 明文的取舍见 §12）。

### 4.2 项目绑定（per-project）

**路径**：`.agents/model.json`（项目内，gitignored；不含 profiles、不含 apiKey）

```jsonc
{
  "schemaVersion": 1,
  "revision": 3,
  "activeProfileId": "mimo",           // null = 本项目不使用 Avenic 模型配置
  "overrides": {},                     // 可选：本项目对库中 profile 的字段级覆盖（如换模型 ID）
  "projection": {                      // 投影记账（Claude 投影 = 项目内物化产物）
    "claude": {
      "file": ".claude/settings.local.json",
      "fingerprint": "sha256:…",       // 生成该投影时的 profile 指纹（§5.4）
      "created": false,                // 文件是否由本功能创建
      "entries": [                      // 精确回滚账本（§6）
        { "path": ["env", "ANTHROPIC_MODEL"], "before": { "exists": true, "value": "original-model" }, "written": "mimo-v2.5-pro" },
        { "path": ["env", "ANTHROPIC_AUTH_TOKEN"], "before": { "exists": false }, "written": "sk-…" },
        { "path": ["attribution"], "before": { "exists": true, "value": { "commit": "", "pr": "" } }, "written": { "commit": "", "pr": "" } }
      ]
    }
  }
}
```

- Codex / OpenCode 是**启动时注入**，不写项目文件，因此没有 `projection` 条目（只有 Claude 需要记账）。
- 该文件含 `before` 原值（可能包含用户此前手工写入的密钥）——这是精确回滚的必要代价，安全策略见 §12。

## 5. 投影（apply）

### 5.1 Claude Code → 写项目 `.claude/settings.local.json`（合并）

| 表单/库字段 | 写入 |
|---|---|
| Base URL | `env.ANTHROPIC_BASE_URL` |
| API Key | `env.ANTHROPIC_AUTH_TOKEN`（或 `env.ANTHROPIC_API_KEY`，随 `authField`） |
| 主模型 | `env.ANTHROPIC_MODEL` |
| Opus/Sonnet/Haiku/Fable | `env.ANTHROPIC_DEFAULT_<ROLE>_MODEL` +（display 非空时）`env.ANTHROPIC_DEFAULT_<ROLE>_MODEL_NAME` |
| Subagent | `env.CLAUDE_CODE_SUBAGENT_MODEL` |
| `longContext`（仅 Opus/Sonnet） | 模型 ID 追加 `[1m]` 后缀 |
| toggles | `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS="1"`、`ENABLE_TOOL_SEARCH="true"`、`CLAUDE_CODE_EFFORT_LEVEL="max"`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1"`、`DISABLE_AUTOUPDATER="1"`、`attribution={"commit":"","pr":""}` |
| `env`（自定义） | 逐条写入 `env` |
| `claude.settings`（透传） | 原样写回（`theme`、`enabledPlugins`、`extraKnownMarketplaces`、`autoUpdatesChannel`…） |

- **合并写**：现有文件里不属于本次受管集合的键一律保留（含 `permissions`、`hooks`、`statusLine` 等本设计不认识的键）。
- 已存在的 `includeCoAuthoredBy` **不删不改**，仅在面板提示一次"该字段已废弃，Claude Code 改用 `attribution`"。
- 自定义 `env` 与受管键冲突 → 保存时拒绝并高亮（不静默覆盖）。
- 所有值转字符串（Claude Code 只接受字符串）；写入前校验生成的 JSON 可解析。
- 生成受管 entries 前，`env` 中每个受管键的**当前值**被记录为 `before`（§6）。

### 5.2 Codex → 启动注入（不落盘）

```
-c model_provider=<providerId>
-c model_providers.<providerId>.name=<name>
-c model_providers.<providerId>.base_url=<baseUrl>
-c model_providers.<providerId>.env_key=<envKey>
-c model_providers.<providerId>.wire_api=responses
-m <主模型>
```

- 子进程环境追加 `envKey → apiKey`（默认 `AVENIC_MODEL_KEY`，避免覆盖用户的 `OPENAI_API_KEY`）。
- CLI 路径：`dispatchAgent` 里构造 `launchArguments` / `launchEnvironment`，**只传给 `launchExecutable`**，不污染 `adapter.*` 用的 `environment`（后者只承载 `CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`XDG_CONFIG_HOME` 等重定向）。
- 值一律**不加引号**（Codex 对无法按 TOML 解析的值回退为原始字符串，加了引号反而在 Windows 上变成带引号的字面量、在 POSIX 上才有类型含义——两端语义不一致）。测试断言"生成的 argv 元素里不含 `"`"。
- **同时加固 `process.mjs:33-37` 的 cmd 行拼接**：把 `& | ^ < > ( )` 一并纳入"需要双引号包裹"的触发条件（今天是 `/[\s"]/`），否则带 `&` 的 URL（`?api-version=…&x=y`）在仅装了 `codex.cmd` 的机器上会被 cmd 在 `&` 处切断。这是 core 里一个独立、可单测的小改动，随本设计一起发布；`%` 在 cmd 中无法转义（引号内也会展开变量），因此交由 §12.6 白名单拒绝。
- 用户自带 `-m/--model` 或 `-c model_provider=` 时以用户为准，本次不注入相应参数。
- 插件路径：优先 `createTerminal({ shellPath: <可执行文件>, shellArgs: [...注入参数, ...], cwd, env })` 以 argv 直启（无 shell 二次解析）；不可行时退回 `command` 字符串 + §13 的降级行。

### 5.3 OpenCode → 启动注入 `OPENCODE_CONFIG_CONTENT`

注入 JSON（优先级高于项目 `opencode.json`）：

```json
{
  "model": "<providerId>/<主模型>",
  "small_model": "<providerId>/<haiku 行模型>",
  "provider": { "<providerId>": { "npm": "<适配器>", "name": "<配置名>",
    "options": { "baseURL": "<baseUrl>", "apiKey": "<apiKey>" },
    "models": { "<主模型>": {}, "<haiku 行模型>": {} } } }
}
```

- `api: openai-responses` / `openai-chat` → 自定义 provider + `@ai-sdk/openai-compatible`（`/v1/responses` 用 `@ai-sdk/openai`）；`api: anthropic` → **覆盖内置 `anthropic` provider 的 `options.baseURL` / `options.apiKey`**（已实测支持，§3.1）。兜底：自定义 provider + `@ai-sdk/anthropic`（该组合有社区报告的丢 apiKey 问题，仅在覆盖内置 provider 不生效时使用）。
- 模型 ID 走注入配置的 `"model": "<provider>/<模型>"`（OpenCode 没有模型相关环境变量，§3.1）；自定义 provider 时同时给出 `models` 条目，内置 provider 覆盖端点时不需要。
- 密钥只在子进程环境变量里，不落盘。

### 5.4 投影刷新（库改了，项目如何跟上）

- **Codex / OpenCode**：每次启动都从库实时生成 → 改库即生效。
- **Claude**：投影是项目内物化文件，启动与 `avenic model use|apply|show` 时比较 `projection.claude.fingerprint` 与库中当前 profile 的指纹；不一致 → 自动重新投影（事务写，§5.5）后继续。指纹 = `hashContent(JSON.stringify(用于投影的字段, 键排序))`（`hashContent` 已有，§3.2）。
- 指纹一致 → 不做任何写入（避免每次启动都改文件时间戳）。

### 5.5 事务与并发

**写入必须走事务**（不允许两个裸 `writeFile`）：

1. 读取现有 `~/.avenic/models.json`（不存在则空库）与 `.agents/model.json`、`.claude/settings.local.json`；
2. 校验 + 生成两份新内容（库、项目文件/投影文件）；
3. 生成内容再校验（JSON 可解析、受管键与 entries 一一对应）；
4. 把新内容写到**与目标同目录**的临时文件（同卷才能 rename）：`<target>.tmp-<pid>-<ts>`；
5. 用既有 `replaceStagedFiles(replacements, tempDirectory)` 完成"备份 → rename → 失败回滚"（§3.2）；备份目录用项目内 `.agents/tmp/model-<pid>-<ts>/`（已被 gitignore，deinit --purge 会清理）；
6. 成功后 `revision += 1` 写回两边（revision 属于第 2 步生成的内容）。

并发：

- **进程内**：VS Code 侧复用现有 `MutationQueue`（§3.2）；
- **跨进程 / 跨窗口**：采用 **原子替换 + revision 戳 + 重读重放**：写入前比对读到的 `revision` 与磁盘现值，不一致则重读并把同一变异重放（最多 3 次），仍失败则报错"配置被其他窗口或进程修改，请重试"。不引入新的文件锁：仓库现有的锁实现（`withLaunchLock`，`sessions.mjs:222-253`）是会话启动专用且未导出，抽出它会改动已测试的会话代码；对"整文件替换 + 版本戳"的配置场景，重读重放已能杜绝静默丢失更新。
- 崩溃/断电：因为最终是 `rename` 覆盖，任何时刻磁盘上要么是旧内容要么是新内容，不会出现半截 JSON。

## 6. 回滚记账（B3）

`projection.claude.entries[]` 逐条记录 `{ path, before, written }`：

- `before.exists === false` 表示该键此前不存在；`true` 则保存原值（深拷贝）。
- 回滚（`clear`、切换 profile、dangling 清理）逐条执行：

| 当前值 vs `written` | 动作 |
|---|---|
| 深相等 | `before.exists` → 写回原值；否则删除该键 |
| 不相等 | **不动**，记为 `conflict` 并报告（键路径 + 掩码后的当前值），提示用户手工处理 |

- 收尾：所有 entries 处理完后，若 `env` 变成空对象且 `created === false`，保留空 `env`（不删用户可能有意留下的结构）；若 `created === true` 且文件为空对象 → 删除该文件。
- 顶层 `attribution`、`env.*` 全部走同一逻辑，不做特例。
- 回滚同样走 §5.5 的事务；回滚完成后清空 `projection.claude`（保留 `file`/`created` 供诊断）并把 `activeProfileId` 置 `null`。

## 7. dangling 引用（B4）

`activeProfileId` 指向的 profile 在库中不存在时：

1. 触发点：任何 `avenic model …` 命令、`avenic <agent>` 启动前、插件面板加载/启动前、状态查询；
2. 行为：按 §6 **安全回滚**旧投影（用户手改过的键不动）→ 清空 `projection.claude.entries`、把 `activeProfileId` 置 `null` → 本次启动不注入任何模型配置；
3. 输出固定文案：`Profile "foo" no longer exists; Avenic configuration disabled for this project.`
4. 幂等：清理后 `activeProfileId === null`，后续不再重复报错（不会每次启动都失败）。若回滚中发现 `conflict`，文案追加一行冲突键提示。

## 8. CLI：`avenic model`

| 命令 | 语义 |
|---|---|
| `avenic model` / `show` | 库路径、项目文件路径、当前项目绑定的 profile、掩码密钥、三 Agent 兼容性/投影状态；dangling 时按 §7 处理 |
| `avenic model list` | 列出**本机库**的 profile，并标记当前项目用的是哪一个（无项目上下文时只列库） |
| `avenic model add` / `set [--name <n>] …` | 管理**本机库**的 profile（`--base-url`/`--api-key`/`--api`/`--model`/`--json <file\|->`）；省略 `--name` 时更新项目当前绑定的 profile，没有绑定则要求显式 `--name` |
| `avenic model edit <id>` | 打开编辑流程（终端交互，与 `add` 同一套字段） |
| `avenic model use <id>` | 把库中 profile **绑定到当前项目**并投影（无参数且 TTY → clack 单选 picker，沿用 `hub select` 交互件） |
| `avenic model clear` | 取消当前项目绑定并按 §6 安全回滚 |
| `avenic model remove <id>` | 删除**本机库**中的 profile（提示会影响的项目无法枚举，按 §7 处理） |
| `avenic model test <id>` | 最小真实请求（§11）；不指定 id 时测当前绑定 |

- 所有输出掩码密钥；`--json` 只回显识别结果。
- `model` 必须注册在 `dispatcher.mjs:397-439` 的**兜底分支之前**（未知命令会落到 skills 分发器当 Pack id 处理）；与现有顶层命令、Agent 名均不冲突。
- 退出码：0 成功；1 用法/校验错误；2 测试连接失败。
- 保留 `--scope`-less 语义：**没有 `-g/全局` 概念**——库永远是设备级，绑定永远是项目级。

## 9. 插件界面

### 9.1 形态与入口

- `avenic.model.open`（「Avenic: 模型配置」）打开**编辑器标签页** `WebviewPanel`（`ViewColumn.Active`，单例，重复打开聚焦已有面板）；`avenic.model.switch`（「Avenic: 切换本项目模型配置」）= 库中 profile 的 QuickPick + 绑定当前项目（"一键切换"）。
- 入口：命令面板 + Agents 视图标题按钮 + Overview 面板内的"模型配置"行。

### 9.2 面板内容（两层）

```
本机配置库（~/.config/avenic/models.json）               [+ 新建] [粘贴导入] [刷新]
┌ ● 小米 MiMo                            [用于当前项目] [编辑] [复制] [测试] [删除] ┐
│   https://token-plan-cn.xiaomimimo.com/anthropic     密钥 sk-…f3a2                │
│   主模型 mimo-v2.5-pro    Claude ✓   Codex ✗ (需 Responses API)   OpenCode ✓      │
└──────────────────────────────────────────────────────────────────────────────────┘
┌   项目 B 配置（Kimi）                   [用于当前项目] [编辑] [复制] [测试] [删除] ┐
└──────────────────────────────────────────────────────────────────────────────────┘

当前项目：C:\work\proj-a
   本项目使用：小米 MiMo      [取消本项目绑定]
   投影：.claude/settings.local.json（14 个键，指纹一致）    Codex/OpenCode：启动时注入
```

- 卡片上的按钮是 **"用于当前项目"**（绑定），不是"启用/设为全局"——不修改任何 Agent 的全局配置。
- 当前项目绑定的那张卡片显示 `当前项目` 徽标。
- **没有 workspace 时**：库的增删改查照常可用，"用于当前项目"禁用并显示"未打开项目文件夹"（与现有 `resolveRoot() === null` 的处理一致，§3.2）。

### 9.3 编辑面板

分区块（占满标签页，底部固定 [保存] [取消]）：预设磁贴（6 个，只预填端点与 API 类型）→ 基本信息（名称、API 类型）→ 连接（Base URL + "将请求：`<解析后的测试地址>`"实时预览、API Key 密码框、认证字段）→ 模型映射表（主模型/Opus/Sonnet/Haiku/Fable/Subagent；模型 ID + 显示名 + 1M 勾选仅 Opus/Sonnet）→ 6 个开关（Teams/Tool Search/Max Effort/禁用非必要流量/禁用自动更新/隐藏 AI 署名，每行显示实际写入的键名）→ 高级（自定义 env 键值表；按 Agent 覆盖端点/API 类型；Codex provider id / env 键名 / reasoning effort；OpenCode provider id / npm 适配器；Claude 顶层透传键只读预览 + 「在编辑器中打开」）→ 底部"最终将写入 `.claude/settings.local.json`"的折叠 JSON 预览（掩码）。

- 预设端点 URL 实现时按各家文档核对；磁贴下方标注"预设只是起点，请以服务商文档为准"。
- **不预填模型 ID**（服务商模型 ID 变动频繁，写死会立刻过期）。

### 9.4 粘贴区

**① JSON 粘贴**：接受 Claude settings 形态（`{"env":{…}}`）、扁平形态（`baseUrl`/`api_key`/`authToken`…大小写与下划线不敏感）、cc-switch 风格包装（`{"settingsConfig":{…}}`，实现时按真实导出样例对齐）；未识别键：Claude settings 形态落到 `claude.settings` 透传区，其他形态只在预览里逐条列出由用户勾选，**不写入**；解析失败 → 提示并引导到自由文本标签页。

**② 自由文本粘贴**：整段 env 块 / `export FOO=bar` / 聊天片段 → 「识别」→ 结果表（字段 / 掩码值 / 来源片段 / 勾选框）→ 「填入表单」。
- 规则：首个 `https?://…` → 端点；键名命中 `ANTHROPIC_BASE_URL|BASE_URL|base_url|api_base` → 端点；`ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|api[_-]?key|auth[_-]?token|token` 或 `sk-[A-Za-z0-9_-]{8,}` → 密钥；`*_MODEL*|model|模型` 行按角色前缀落位（无前缀 → 主模型）。
- 多候选全部列出，默认选第一个并标注"另有 N 个候选"，**不静默取第一个**；模型名只在出现明确模型键时才识别，否则留空并提示手工填写。
- 粘贴永不自动保存，必须点 [保存]。

### 9.5 multi-root 与无 workspace（B6）

- 复用现有语义：单根 → 直接用；多根 → **优先 active editor 所属的 workspace folder**（本次新增：纯函数 `projectRootForActiveEditor(folders, activeUri)` 放进 `src/project.ts`，由 `extension.ts` 传入 `activeTextEditor?.document.uri`），否则沿用"上次记住的合法根" → 否则 QuickPick；**任何路径都不允许静默取 `folders[0]`**。
- 库的管理不依赖 projectRoot；只有"用于当前项目 / 取消绑定 / 项目状态"需要，且为 null 时按钮禁用并给出提示。

### 9.6 远程 / WSL（B7）

- 库文件落在 **CLI / Extension Host 实际运行的环境**（本地 Windows → Windows 家目录；WSL 窗口 → WSL home；Remote SSH → 远端 home），彼此独立。
- 本版不做云同步 / 跨设备同步 / Windows↔WSL 同步 / Avenic 账号或服务端。
- 面板在"当前项目"区显示库文件路径，便于用户确认自己在哪个环境。

### 9.7 消息与资源约定

- 复用 Dashboard 约定：`media/model/{view.html,main.js,style.css}`，`{{nonce}}`/`{{cspSource}}` 注入、`localResourceRoots` 指向 `media`、无远程资源、不用 `innerHTML` 渲染用户数据、颜色走 `--vscode-*`；图标用内联 SVG（不引入 codicon 字体）。
- 消息协议放 vscode-free 模块（`src/model/protocol.ts`，仿 `dashboard/protocol.ts` 的白名单校验），面板数据组装放 vscode-free 的 `src/model/state.ts`（因为测试没有 vscode stub，§3.2）。
- **插件侧零业务逻辑**：解析、校验、归一化、投影、命令构造、测试请求全部在 `@avenic/core`；面板 JS 只做 DOM 与消息。

## 10. 粘贴识别（core）

`packages/core/src/model/parse.mjs`：`parseConfigJson(text)`、`parseConfigText(text)`、`recognizeEnvMap(env)` —— 纯函数、无 IO，供 CLI（`--json`）、插件、测试共用。

## 11. 测试连接（最小真实请求）

| API 类型 | 请求 |
|---|---|
| anthropic | `POST <baseUrl>/v1/messages`，`x-api-key`（或 `Authorization: Bearer`）+ `anthropic-version: 2023-06-01`，体 `{model, max_tokens: 1, messages:[{role:"user",content:"ping"}]}` |
| openai-chat | `POST <baseUrl>/v1/chat/completions`，`Authorization: Bearer`，体 `{model, max_tokens: 1, messages:[…]}` |
| openai-responses | `POST <baseUrl>/v1/responses`，`Authorization: Bearer`，体 `{model, input: "ping", max_output_tokens: 16}` |

- baseUrl 以 `/v1` 结尾时按"已含版本段"处理；表单实时显示解析后的最终地址。
- 超时 15s；分类：2xx 成功（耗时 + 服务端返回模型名 + `usage`）、401/403 密钥无效或无权限、404 路径不对、429 限流/配额、5xx 服务端错误、网络/DNS/TLS 不可达、超时无响应。失败时说明"连接失败 ≠ 密钥无效"。
- 提示语必须写明：会向该地址发送一次真实请求、消耗极少量额度；密钥只发往用户填写的地址；avenic 自身没有服务端。

## 12. 安全与 Git

1. **库文件**（`stateRoot/models.json`）：POSIX `0600`；Windows 依赖用户目录 ACL（文档写明）。
2. **项目文件**（`.agents/model.json`）：含 `before` 原值（可能包含用户此前手工写入的密钥）——精确回滚的必要代价；gitignored + 0600 + 所有输出掩码。**不接受**用"只存哈希"替代：那会在 `clear` 时丢失用户原值，违反 B3。
3. **投影文件**（`.claude/settings.local.json`）：写入时确保项目 `.gitignore` 含该路径（新增独立规则表 `MODEL_RULES` + `ensureModelGitignore(projectRoot)`，只在保存模型配置时调用，**不并入 `REQUIRED_RULES`**，避免改变 `init` 的既有输出与断言）。
4. 两条规则（`.agents/model.json`、`.claude/settings.local.json`）在 `removeRuntimeGitignore`（`gitignore.mjs:52-56`）的可移除集合内，但**仅当对应路径已不存在**才可移除——防止 deinit 之后密钥文件变成可提交。
5. 密钥掩码（前 3 后 4）覆盖 CLI、通知、日志、错误信息；**不写日志**；不参与 Git；不上传；无 telemetry。
6. 注入值白名单（保存即校验，不合格拒绝保存）：
   - baseUrl：`^https?://[A-Za-z0-9._~:/?#\[\]@+,;=\-]+$` —— 允许 `? # [ ] @ + , ; =`（带查询串的网关地址可用），拒绝空白、`"` `'`、反引号、`$`、`%`，以及 cmd 元字符 `& ^ | < > ( ) !`。
     - `%` 必须拒绝：cmd 里无法转义，引号内同样会展开变量（§5.2）。
     - `&` 在 §5.2 的 `process.mjs` 加固后技术上可安全传递，但本版仍拒绝以缩小注入面，并提示"请使用不带 `&` 的地址"；若日后要放开，只需改这一行白名单。
   - provider id `^[a-z0-9_]{1,32}$`；envKey `^[A-Z][A-Z0-9_]{0,63}$`；模型 ID `^[A-Za-z0-9._:\-/]{1,128}$`。
7. **不使用 VS Code `SecretStorage` / `globalState` / extension globalStorage 作为 SSOT**：CLI 无法自然共享同一套数据，会产生两套事实来源。未来若做 OS keychain，另立 spec。
8. 不写 `~/.claude`、`~/.codex`、`~/.config/opencode` 下任何文件；不修改三个 Agent 自身的全局配置。

## 13. 降级与错误处理

| 情况 | 处理 |
|---|---|
| `.cmd` 链路上参数被 cmd 破坏（仅纯 npm/bun 安装的 Codex 会走到；`& ^ |` 已由 §5.2 的加固解决，`%` 由白名单拒绝） | ① 插件改用 `createTerminal({shellPath, shellArgs})` argv 直启（无 shell）；② 若插件终端也做不到，插件只注入 env、argv 由 CLI 承担（提示"请用 `avenic codex` 以获得项目模型"）；③ 最后备选：`.agents/local/codex/config.toml` + `CODEX_HOME` 组合 home（**不在本版实现**，需另立 spec） |
| 实测项 2：project 认证下 Claude 不读项目 settings.local.json | 补一条启动 env 注入（仅 project 认证模式），并在面板标注差异 |
| 覆盖内置 anthropic provider 的端点仍不生效（个别版本/端点） | 退化自定义 provider + `@ai-sdk/anthropic`；仍不生效 → 面板标"OpenCode 暂不支持该端点"（其余两个 Agent 不受影响） |
| 端点协议与 Agent 不兼容（典型：Anthropic 端点 + Codex） | **不静默跳过**：卡片显示 ✗ + 原因；`avenic model show` 同样标注；启动该 Agent 时打印"该配置不适用于 Codex，本次使用其全局配置" |
| 投影文件不可写 / 被占用 | 事务不做任何替换（两边都保持原样），报错并提示"按 Agent 覆盖"或检查权限 |
| 库或项目文件被手工改坏 | 命令报可读错误并指向文件；面板显示"配置损坏"卡片 + 「在编辑器中打开」；不自动修复、不覆盖 |
| 无绑定 / 库为空 | 所有注入静默跳过，`avenic <agent>` 行为与今天一致 |
| 回滚时发现用户改过受管键 | 不动该键，报告 conflict（§6） |

## 14. 一致性检查（machine library / project binding / projection / rollback / CLI / VS Code / launch injection / delete profile / dangling binding / remote / multi-root / security）

| 关注点 | 单一语义 |
|---|---|
| 库是 SSOT | 只有 `stateRoot/models.json` 存 profile；项目文件只存绑定与记账；插件不存副本 |
| 绑定是项目态 | 只有 `.agents/model.json.activeProfileId`；`null` = 不注入 |
| 投影 | Claude 物化（带指纹与 entries）；Codex/OpenCode 启动注入（无记账） |
| 回滚 | 一律走 §6 的 before/written 判定；冲突不覆盖 |
| 删除 profile | 只动库；引用它的项目在下次触达时按 §7 清理并提示 |
| dangling | 回滚 + 置 null + 固定文案 + 幂等 |
| CLI / VS Code | 同一套 core 函数；插件零业务逻辑；两者写同一文件、同一事务、同一 revision 规则 |
| 启动注入 | CLI 与插件都读库、都做 dangling 检查、都刷新 Claude 投影（指纹） |
| remote / multi-root | 库随 Extension Host 环境；项目根用既有解析 + active editor 优先，不静默取 folders[0] |
| 安全 | 明文密钥只在本机库 + 项目记账 + 项目投影三处，均不入 Git、均掩码 |

## 15. 影响面

| 位置 | 改动 |
|---|---|
| `packages/core/src/model/*.mjs` | **新增**：`paths.mjs`（`modelsFile`）、`schema.mjs`（校验/归一化/指纹）、`library.mjs`（库读写 + revision + 事务）、`binding.mjs`（项目文件读写 + dangling + clear）、`project-claude.mjs`（合并投影/回滚 entries）、`inject.mjs`（codex argv / opencode env / claude env）、`parse.mjs`、`presets.mjs`、`probe.mjs`、`gitignore.mjs`（MODEL_RULES） |
| `packages/core/src/index.mjs` | 导出新模块 |
| `packages/core/src/runtime/process.mjs` | cmd 行拼接的引号触发条件加 `& \| ^ < > ( )`（§5.2 加固；独立小改动，随 core 一起发布） |
| `packages/core/src/runtime/gitignore.mjs` | 可移除集合加两条规则 + "路径仍存在则不删"守卫 |
| `packages/cli/src/cli/model-cli.mjs` | **新增**：`model` 子命令 |
| `packages/cli/src/cli/dispatcher.mjs` | `model` 顶层分发（兜底分支前）；`dispatchAgent` 注入（`launchArguments`/`launchEnvironment`，`:295-297`） |
| `packages/cli/vendor/core-src/**` | `npm run sync-core` |
| `packages/vscode/src/model/{state.ts,protocol.ts}` | **新增**：vscode-free 数据组装 + 消息白名单 |
| `packages/vscode/src/dashboard/model-panel.ts` | **新增**：`WebviewPanel` 薄壳（本仓库第一个编辑器标签页面板） |
| `packages/vscode/src/project.ts`、`extension.ts` | `projectRootForActiveEditor` + 接入 `root()` |
| `packages/vscode/src/services/model.ts`、`commands/model-commands.ts` | **新增**：服务层 + 两个命令 |
| `packages/vscode/src/services/agents.ts` | 启动注入（argv/env）+ 投影指纹刷新 |
| `packages/vscode/media/model/*` | **新增**面板资源 |
| `packages/vscode/package.json` | 2 个命令 + 视图标题按钮 + `@avenic/core` 版本提升 |
| 文档 | README×2、`docs/development.md`、`packages/vscode/CHANGELOG.md` |

## 16. 测试

- core 单测：schema/白名单校验、库读写与 revision、**事务回滚**（注入第二次 rename 失败 → 两边都保持原值）、损坏文件、投影合并（保留未知键 / 只删受管键 / `created` 语义 / 空文件删除）、**回滚三态**（current===written 且 before 存在 → 恢复原值；before 不存在 → 删除键；current≠written → conflict 不动）、指纹一致时零写入、dangling 清理幂等、codex argv 构造（用户自带 `-m` 时让位、值不含 `"`）、opencode 注入 JSON、`parse.mjs` 三形态 + 自由文本（多候选、无模型名、非 JSON）、presets 白名单、`probe.mjs` 结果分类（本地 mock server 覆盖 200/401/403/404/429/500/超时/网络失败，**不发真实请求**）。
- CLI：`model` 各子命令输出与退出码、掩码、`model` 不落 Pack 兜底分支、无绑定/空库时 `avenic <agent>` 行为不变。
- 插件：媒体测试（无远程资源、无 `innerHTML`、CSP 占位符）、协议白名单拒绝未知消息、面板数据组装（vscode-free）、`projectRootForActiveEditor` 单测、命令注册、启动定义中的注入落地。
- gitignore：保存后两条规则存在；`deinit --purge` 后（文件仍在）规则仍在。
- 隔离要求：所有测试用 `testEnv()`（`AVENIC_STATE_DIR` 指向临时目录）+ 临时项目目录；**禁止写真实家目录**（沿用 `skills-commands.test.ts:72-74` 的约定）。
- 端到端（本机、隔离目录）：`use` → 启动 mock Agent 捕获 env/argv → 断言注入值；`clear` → 断言受管键被恢复/删除且用户键保留。

## 17. 发布顺序

1. bump `packages/core` → 发布 `@avenic/core`（**USER CHECKPOINT**）；
2. `npm run sync-core` → bump `packages/cli` → 发布 `avenic`（**USER CHECKPOINT**）；
3. `packages/vscode` 提升 `@avenic/core` 依赖到新版本 → 实现插件侧 → 打包 VSIX（Marketplace 上传 **USER CHECKPOINT**；**0.1.10 已上传，不再重复上传**）。

> 注意：插件依赖的是**已发布**的 `@avenic/core`（§3.2），因此插件侧实现/测试必须排在第 1 步发布之后。

## 18. 明确不做

- 不做云同步 / 跨设备同步 / Windows↔WSL 同步 / Avenic 账号或服务端；
- 不写 `~/.claude`、`~/.codex`、`~/.config/opencode`；不改 Agent 全局配置；
- 不用 VS Code SecretStorage / globalState 作 SSOT；
- 不引入新的文件锁实现（§5.5 说明理由）；
- 不预填模型 ID；不做在线预设更新；
- 不自动定期测活、不在启动时探测（避免每次启动都打真实请求）；
- 不做 OS keychain 加密（另立 spec）；
- 不把 profile 库放进项目、不做"团队共享 binding"（若要共享，需先把 `before` 记账拆出项目文件，另立 spec）。

## 19. 开放问题

无未决**设计**问题。§3.3 的三条实测项各自绑定 §13 的降级行；§12.2（项目文件保存 `before` 原值）与 §5.5（不引入文件锁）是本次修订中我做的两个取舍，已在文中写明理由，若用户有不同偏好可单独推翻。
