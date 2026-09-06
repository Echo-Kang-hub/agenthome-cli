# AgentHome CLI 开发指南

面向贡献者：仓库结构、开发、测试、打包与发布。

## 结构

```text
packages/core/                 平台无关核心库（runtime、sessions、skills、catalog、direct）
packages/cli/                  命令行层（dispatcher、skills-cli、self-update）
packages/cli/vendor/core-src/  packages/core/src 的同步副本（提交进 git，发布时随包）
integration/                   全局安装集成测试（registry 包 + GitHub 根包双模式）
test/                          单元与 fixture 测试（catalog 用例全部本地 git fixture，不联网）
docs/superpowers/              设计 spec 与实施 plan
```

## 开发

```bash
npm install
npm test               # node --test；pretest 自动同步 vendor core
npm run test:install   # 双模式全局安装集成测试
npm run pack:cli       # npm pack --dry-run
npm run sync-core      # 手动同步 packages/core/src → packages/cli/vendor/core-src
```

## 打包约束（重要）

根 package.json **不带 `workspaces` 字段，也没有任何 install 生命周期脚本**（postinstall/build/preinstall/install/prepack/prepare）：npm 11 对 git 简写安装会把 node_modules 链接到 pacote 解包临时目录，`workspaces` 或这些脚本会让 pacote 在该目录里再跑一次嵌套 `npm install`（pacote git.js `#prepareDir`），Windows 上嵌套 reify 与全局安装竞争会把解包目录改残（bin 报 MODULE_NOT_FOUND）。本包零运行时依赖，不需要嵌套安装；`test/packaging.test.mjs` 守护此约束。

CLI 通过 package.json `imports`（`#core` → `./vendor/core-src/index.mjs`）引用 core——相对 vendor 路径在「GitHub 根安装」与「registry tarball 安装」两种模式下都成立。改 core 后必须 `npm run sync-core`（pretest/prepack 会自动执行，测试 `test/sync.test.mjs` 守护一致性）。

## 发布

```bash
npm login   # 已登录则跳过
# 提升 packages/cli/package.json（及 packages/core/package.json、根 package.json）的 version
cd packages/cli && npm publish
```

- `agentHome.packageSpec` 保持 `agenthome-cli@latest`（`agent update` 自更新源）。
- registry 包 `private` 保持 `false`。
- 唯一发布物是 `packages/cli`（包名 `agenthome-cli`）；`packages/core` 不发布。

## catalog 仓库

私有 catalog 仓库是纯数据仓库：`skills/`、`packs/`、`sources.lock.json`、`licenses/`，加每日 CI（auto-update-skills.yml，从 registry 安装 CLI 后运行 `agent catalog update` + `agent catalog doctor` 并提交）。不得再分发的第三方 Skills 只允许存在于该私有仓库，不进入本公开仓库。
