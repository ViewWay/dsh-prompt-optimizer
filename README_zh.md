# dsh-prompt-optimizer

[![CI](https://github.com/ViewWay/dsh-prompt-optimizer/actions/workflows/ci.yml/badge.svg)](https://github.com/ViewWay/dsh-prompt-optimizer/actions/workflows/ci.yml)

独立分发的 DeepSeek Harness「提示词优化器」插件全家桶：把一段粗糙的想法草稿，经多轮「重写 → 自评 → 修正」打磨成可直接交给 Agent 执行的提示词。

[English](README.md) | [简体中文](README_zh.md)

## 功能

- 输入框「优化」按钮 + 领域推荐 chips 一键触发；多轮优化、失败重试、逐轮对比预览
- 角色库（`rolesDir` 下的 `<slug>.md`）：角色按需列出、推荐、指定角色重跑；配置页可设默认角色
- 技能感知（`skillAware`）：草稿命中已安装技能时，把技能名与简介并入元提示词，产出直接引用这些技能的提示词，并带防幻觉的精确命名约束
- 多语言：优化产出的语言自动跟随 Agent 的界面语言设置（中文界面出中文提示词，English 界面出英文），代码标识符、路径与命令保持原样
- 队列条目行内「优化」入口：对已排队未发送的消息直接优化
- 验收准则：mechanical 准则附带可执行的检查命令模板

## 仓库布局

| 包 | npm | 作用 |
| --- | --- | --- |
| `packages/prompt-optimizer` | [@yimiliya/dsh-prompt-optimizer](https://www.npmjs.com/package/@yimiliya/dsh-prompt-optimizer) | Host 服务：优化轮次、角色库、技能提示、模型路由 |
| `packages/api-prompt-optimizer` | [@yimiliya/dsh-api-prompt-optimizer](https://www.npmjs.com/package/@yimiliya/dsh-api-prompt-optimizer) | Remote 控制器与 Typert 描述符（host/client 共享方法表） |
| `packages/client-ui-prompt-optimizer` | [@yimiliya/dsh-client-ui-prompt-optimizer](https://www.npmjs.com/package/@yimiliya/dsh-client-ui-prompt-optimizer) | 浏览器 UI：触发按钮、预览面板、队列入口、设置页 |
| `packages/bundle` | [@yimiliya/dsh-prompt-optimizer-bundle](https://www.npmjs.com/package/@yimiliya/dsh-prompt-optimizer-bundle) | Profile bundle（`cordis.patch.yml`），一次安装叠加全部三个插件 |

每个包都带有自己的 README（会展示在其 npm 包页上）；本文档是全家桶视角。`tools/tsdown.client.ts` 是独立版客户端打包预设：按 harness 的 `window.__ModuleLoader__.load({id, factory})` 契约产出浏览器闭包工件，CSS Modules 经 lightningcss 编译为自带样式的注入模块。

## 安装（用户）

发布到 npm 后，在任意装有 dsh 的 profile 上：

```sh
dsh plugin --profile web add @yimiliya/dsh-prompt-optimizer-bundle
```

bundle 会把 `prompt-optimizer`、`api-prompt-optimizer`、`ui-prompt-optimizer` 三个条目叠加进该 profile 的 `dsh.profile.bundles`。也可以在 Web 客户端的插件市场里安装。

未发布前请用 tarball 安装。直接写本地路径或 git 地址**不可用**：bundle 的 `workspace:*` 依赖只在本仓库的 pnpm workspace 内可解析，而 `dsh plugin add` 是在 profile 自己的安装根里装。打包会把版本范围改写为真实版本号（`pnpm -r pack`），tarball 的依赖随后从 registry 解析——因此这条路需要另外三个包已发布：

```sh
pnpm -r pack        # 在各包目录生成 *.tgz
dsh plugin --profile web add packages/bundle/yimiliya-dsh-prompt-optimizer-bundle-<version>.tgz
```

### 配置（可选，cordis.yml 的 `plugins > config > prompt-optimizer`）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `verifyTimeoutMs` | 见源码 | 验收检查命令的超时 |
| `domainPriors` | `true` | 按草稿的技术领域注入先验 |
| `provider` / `model` | 未设置 | 显式指定优化用的模型路由，两者必须成对出现 |
| `rolesDir` | 未设置 | 角色定义目录（`<slug>.md`）；设置后启用角色选择与推荐 |
| `defaultRole` | 未设置 | 未显式指定角色时使用的默认角色 slug；配置页也可设置 |
| `skillAware` | `true` | 把命中的已安装技能并入元提示词 |

## 隐私

优化过程会记录进会话自身的事件日志，请据此对待草稿内容：

- 每一轮优化都会向会话追加一条 `plugin:prompt-optimizer/llm-request` 记录，包含完整草稿文本与辅助 system prompt。
- 每次运行核验都会追加一条 `plugin:prompt-optimizer/verify` 记录，包含所执行的命令与其（已脱敏的）输出。
- 「改进此角色」会重写所配置 `rolesDir` 下的角色定义文件 `<slug>.md`；旧版本保留在同目录的 `<slug>.md.bak`。

向草稿中粘贴密钥等敏感内容时，应预期它们出现在会话日志里。

## 开发

```sh
pnpm install
pnpm run check      # lint + 类型检查 + 构建 + 测试（与 CI 相同的门禁）
pnpm run typecheck  # 仅类型检查
pnpm run lint       # oxlint
pnpm run test       # vitest（node + client 两个 project）
pnpm run build      # tsdown，按依赖顺序
```

- **node project**（host + api 测试）开箱即跑。
- **client project**（jsdom 浏览器测试）需要一份 deepseek-harness 检出：已发布的 dsh 客户端包是浏览器闭包工件，只能在真实 Web 客户端里加载，测试改为按 harness `tsconfig.base.json` 的 paths 解析到其源码树——这也是这些用例在 harness 仓库内的原生跑法。默认取仓库同级目录 `../deepseek-harness-latest`，或用环境变量指定：

  ```sh
  DSH_HARNESS_ROOT=/path/to/deepseek-harness pnpm run test
  ```

  harness 检出内需已执行过 `pnpm install`（其源码依赖从自身树内解析）。测试配置同时把 react / react-dom / use-sync-external-store 收敛到单一实例，避免跨副本的 hook 报错。

代理与贡献者请先阅读 [AGENTS.md](AGENTS.md) 了解仓库约定。

## 兼容性

支持的基线为 `@deepseek-ai/dsh-*` `0.2.1-rc.3`；更早版本未验证。细节——包括队列入口的插槽要求与锁定的 peer 依赖——见 [docs/compatibility.md](docs/compatibility.md)，该文件是唯一事实来源。

## 发布（维护者）

四个包保持版本一致。打 tag（`git tag vX.Y.Z && git push origin vX.Y.Z`）后，GitHub Actions 会按依赖顺序（host → api → client → bundle）构建、检查并把四个包发布到 npm。见 `.github/workflows/release.yml`。

## 许可证

[Apache-2.0](LICENSE)
