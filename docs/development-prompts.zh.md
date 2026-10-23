# 开发提示词包（Development Prompts）

把本插件家族已实现的功能沉淀为可直接投喂给 agent 的任务提示词。用法：在仓库根目录打开一个 agent 会话（dsh / ZCode / Claude Code 等），整段复制下面某个提示词块作为任务输入。每个提示词自包含：背景、目标、约束、验收标准，不依赖会话上下文。

仓库速览（所有提示词共享的事实）：四个包 —— `packages/prompt-optimizer`（Host 服务，核心在 `src/index.ts` / `src/meta-prompt.ts` / `src/skills.ts` / `src/recommend.ts`）、`packages/api-prompt-optimizer`（Typert Remote，`tsc -b` 构建）、`packages/client-ui-prompt-optimizer`（浏览器 UI，`src/client/`，`tools/tsdown.client.ts` 预设出闭包工件）、`packages/bundle`（`cordis.patch.yml` 一键叠加）。版本基线：`@deepseek-ai/dsh-*` `0.2.1-rc.2`、`@deepseek-ai/cordis` `4.0.5`、`zod` 精确 `4.4.3`。门禁：`pnpm run check`（lint + typecheck + build + test；client 测试需 `DSH_HARNESS_ROOT` 指向 harness 检出）。

---

## P1 桌面端启用与冒烟验证

```text
任务：在 dsh 桌面应用（Electron 开发模式）里启用本插件家族并做一轮完整冒烟验证。

背景：
- 仓库是独立分发的 dsh 插件家族（四包，见根 README）；桌面应用源码在同级 harness 检出（DSH_HARNESS_ROOT 默认 ../deepseek-harness-latest）。
- 桌面 dev 模式：在 harness 检出里 `node_modules/.bin/pnpm run dev:desktop`（首次会全仓构建并下载 Electron）；dev home 在 `apps/desktop/.desktop-build/development/home`。
- 插件启用方式：往 `…/home/profiles/desktop/cordis.patch.yml` 追加一个 `- insert:` 块，三行 id/name 分别是 prompt-optimizer→@deepseek-ai/dsh-experimental-prompt-optimizer、api-prompt-optimizer→@deepseek-ai/dsh-experimental-api-prompt-optimizer、ui-prompt-optimizer→@deepseek-ai/dsh-experimental-client-ui-prompt-optimizer（名字经 dev project 的依赖目录解析）。

要求：
1. 启用插件后重启桌面端，逐项冒烟：输入框「优化」按钮、预览面板（原始/优化对照、变更说明、验收准则）、mechanical 准则「运行核验」按钮、队列条目行内入口、设置页默认角色下拉。
2. 验证产出语言跟随界面语言（中文界面出中文提示词，切 English 后出英文）。
3. 结果检查以会话日志为准：dev home 下 sessions/<workspace>/session-*/session.v4.jsonl.zstd，解包后应有 prompt-optimizer/llm-request 与（若点了核验）prompt-optimizer/verify 事件，且全程无 error 事件。

约束：不改 harness 源码；只改 dev home 的 profile patch（可随时删掉追加块回滚）。
验收标准：上述每项入口在桌面窗口可见可用；会话日志含优化事件且零错误；退出重启后插件仍然生效。
```

## P2 技能感知优化（skillAware）维护与扩展

```text
任务：理解并扩展 prompt-optimizer 的技能感知能力；本次目标是在提示词中引用技能时同时带上技能的参数占位（若技能声明了参数）。

背景：
- 现状：packages/prompt-optimizer/src/skills.ts 的 selectSkillHints(context, skills) 用确定性关键词重叠打分（技能名权重×3、简介×1，阈值 MIN_SKILL_SCORE=2，至多 12 条，简介截 160 字），只保留可被模型调用的技能；src/meta-prompt.ts 的 skillBlock() 把命中技能拼进元提示词，并带防幻觉约束（只允许引用列出技能的精确名称，禁止编造技能名）。src/index.ts 的 resolveSkillHints 在 skillAware=true 但无技能注册表时按类型化错误 fail loud。
- 配置项 skillAware（默认 true）在 cordis.yml 的 plugins > config > prompt-optimizer 下。

要求：
1. 先跑通现状：node 项目测试（vitest --project node）里 skills.spec.ts 全绿。
2. 扩展：技能定义若带参数描述，skill hint 里以「技能名（参数：参数名=说明, …）」形式追加；无参数技能保持原样。
3. 元提示词防幻觉规则同步收紧：参数同样只允许使用列出的参数名。

约束：打分逻辑保持确定性（不引入模型调用）；每条 hint 总长新增不超过 80 字；不改变现有 12 条上限。
验收标准：新增用例覆盖「带参技能命中→hint 含参数」「带参技能未命中→无参数段」；全部现有测试不回归；pnpm run check 通过。
```

## P3 输出语言跟随 Agent 界面设置

```text
任务：维护「优化产出语言跟随 Agent 界面语言」机制；本次目标是让语言标签在界面只剩一种语言可选时跳过（避免冗余请求字段）。

背景：
- 链路：packages/client-ui-prompt-optimizer/src/client/mount.ts 的 activeLanguageLabel() 从 ctx.locale.getLocale().locales 里按 active id 取自述标签（如「中文」/English），随 runRound 请求携带 language 字段；Host 端 src/index.ts 的 normalizeLanguage() 校验（超 40 字符报 PROMPT_OPTIMIZER_BAD_LANGUAGE），src/meta-prompt.ts 的 languageRule() 把元提示词规则 1 替换为「Write the rewrite in <语言>。代码标识符、文件路径、命令与引文保持原样」，规则 8/9（变更说明与验收准则的语言）经 writtenIn() 同步。
- 上线依据已验证：桌面会话日志里 llm-request 的 system 含 "Write the rewrite in 中文"。

要求：
1. locales 只有一项（或 active 项缺失标签）时，请求省略 language 字段，Host 端按现状（未指定语言→沿用默认规则集）处理，不报错。
2. 其余链路行为不变。

约束：不改动 Host 元提示词文本本身；locale 读取保持客户端侧。
验收标准：单语言下请求 payload 无 language 键（客户端测试断言 not.toHaveProperty）；双语言下行为不变；全量测试通过。
```

## P4 角色体系：角色库 + 推荐 chips + 默认角色

```text
任务：补齐角色体系的空隙——为角色库新增一个内置示例角色集（docs/roles/，20 个高频工程角色），并让 rolesDir 未配置时设置页给出引导文案。

背景：
- 机制：cordis.yml 配 rolesDir 指向 <slug>.md 目录；文件首行 H1 为显示名，正文为角色定义，单文件上限 8000 字符、目录上限 500 个文件；listRoles() 读全部定义（无模型调用），recommendRoles()（src/recommend.ts）按草稿+待发收件箱的关键词重叠排序取前 3 个推荐；请求未带 role 时回退 defaultRole（配置页 SettingsForm 可设，写入经 namespace mutate）；未列出的 defaultRole 或 role 报 PROMPT_OPTIMIZER_ROLE_NOT_FOUND（fail loud，目录外的路径永远不可达）。结果回显 resolved role 到面板徽标。

要求：
1. 在 docs/roles/ 落 20 个 <slug>.md（code-reviewer、test-writer、refactorer、api-designer、sql-optimizer、security-auditor、performance-profiler、doc-writer、i18n、release-notes 之类，slug 用英文，名称中文）。
2. rolesDir 未配置时，设置页默认角色下拉显示占位项并附一行引导（新 locale key 走 zh/en 双语字典）。
3. README 配置表同步指向 docs/roles/（绝对路径用法）。

约束：角色定义必须自包含、无编造工具名；每条 200–600 字；不引入模型调用。
验收标准：listRoles/recommendRoles 现有测试不回归；新增「docs/roles 可被 rolesDir 直接指向」的手测说明；双语字典键成对。
```

## P5 预览面板角色选择器与换角色重跑

```text
任务：给预览面板顶部角色选择器补充键盘可达性与角色数量过载时的搜索过滤。

背景：
- 现状：packages/client-ui-prompt-optimizer/src/client/PreviewPanel.tsx 头部有原生 <select>（roleLabel aria-label，roleNone + 全量角色，显示 name 传 id，running 时 disabled）；选中变更走 mount.ts 的 regenerateAsRole(sessionId, role|undefined)，它镜像 regenerate 但只覆盖 role，保留 previousAttempts/queueItemId/apply/target；角色列表经 usePromptRoles（src/client/use-prompt-roles.ts）加载，加载失败静默降级为徽标显示。

要求：
1. 角色数 > 60 时，选择器替换为 input 过滤 + 列表（原生元素优先，避免引入新依赖）；≤60 保持 <select>。
2. 两形态都满足键盘操作（Tab 进入、方向键/首字母定位、Enter/Esc）。
3. 过滤不区分大小写、匹配 name 与 slug。

约束：不引入新依赖；组件测试沿用现有 client 测试基建（@testing-library/react）；文案走 locale 字典（新增 key 双语成对）。
验收标准：>60 角色时过滤交互有测试（输入过滤、清空恢复全量）；≤60 分支回归不变；regenerateAsRole 行为不变。
```

## P6 队列条目行内入口与宿主插槽前向兼容

```text
任务：巩固队列条目入口的宿主兼容层；本次目标是把降级 warn 升级为一次性用户可见提示，避免问题只沉在日志里。

背景：
- 现状：宿主插槽 conversation.input.dock.queue.item 晚于 0.2.1-rc.2 发布。src/client/mount.ts 里注册包在 try/catch 中，slot 名与注册对象以 as never 降级（旧宿主抛错→catch→ctx.logger.warn，入口静默隐藏）；src/client/QueueItemOptimizeEntry.tsx 的 Props 用本地结构声明（QueueItemEntryItem 等），不依赖未发布插槽的 PropsRuntime 查询；插件对纯文本队列项渲染入口，点击 startQueued(sessionId, itemId, text)，面板顶部仍可换角色重跑。

要求：
1. catch 分支在 logger.warn 之外，用客户端既有提示原语（查 @deepseek-ai/dsh-client-ui-primitives 可用的 toast/notice；若无则保持仅日志并在设置页顶部加一行常驻提示条）告知「当前宿主版本不支持队列条目入口」。
2. 提示每次插件激活至多出现一次。

约束：不新增依赖；降级路径不得抛错打断其他入口加载；提示文案 locale 字典双语。
验收标准：mock 旧宿主（slots.inject 对未知 slot 抛错）的测试断言提示恰好出现一次且后续入口正常注册；正常宿主路径无提示。
```

## P7 按系统提示词优化（双轮评审）

```text
任务：为「按系统提示词优化」模式增加评审轮次的可见产物——把每轮 critique 条目落为可复制的清单文本。

背景：
- 现状：optimize(target:'system') 在普通重写后追加一轮自我评审；预览面板以 critiqueItem（「评审修订：{text}」）逐条列出；host 端 envelope 解析与轮次控制在 packages/prompt-optimizer/src/index.ts（三标记 envelope：OPTIMIZED_PROMPT/CHANGES/AC），系统提示词变体经 optimizerSystemPromptForSystem 与 critiqueSystemPrompt（均接收 {domainPriors, role, skills, language} 条件对象）。

要求：
1. 面板为 critique 清单增加「复制全部」按钮（navigator.clipboard，失败时回退提示文案）。
2. 复制格式：每行一条 `- 文案`，按面板显示顺序。

约束：不新增依赖；clipboard 调用带 try/catch 与失败 locale 文案；按钮在清单为空时不渲染。
验收标准：jsdom 测试断言复制内容与顺序（mock clipboard）；空清单不出现按钮；现有面板测试不回归。
```

## P8 分发工程：发布流程与版本基线升级

```text
任务：把「版本基线升级」从五处手工修改收敛为脚本化检查；本次先实现升级核对器。

背景：
- 基线 @deepseek-ai/dsh-* 0.2.1-rc.2 分布在多处：docs/compatibility.md（自称为 source of truth）、.github/workflows/ci.yml（clone --branch dsh-v0.2.1-rc.2）、三个 package.json 的 peerDependencies 精确锁定、README 兼容性节。
- 发布事实（已实测）：pnpm -r pack 会把 dependencies 与 peerDependencies 里的 workspace:* 改写为真实版本号；release workflow 按 tag 触发、pnpm -r publish --access public --no-git-checks 依 host→api→client→bundle 依赖序发布；未发布前本地安装只能走 tarball（README 安装节已写明）。

要求：
1. 新增 scripts/check-baseline.mjs：从 docs/compatibility.md 解析出基线 tag，核对 ci.yml 的 clone tag 与全部 package.json 里 @deepseek-ai/dsh-* 的版本段一致；不一致时逐条列出位置与期望/实际值并以非零码退出。
2. 把该脚本挂进 scripts/check.sh（在 lint 之后、typecheck 之前）。
3. 同步挂进 CI：ci.yml 分步跑 pnpm run lint/typecheck/build/test，从不调用 check.sh——需在 .github/workflows/ci.yml 增加基线核对步骤（建议根 package.json 加 baseline script，CI 里 pnpm run baseline，置于 Lint 之后）。

约束：脚本零依赖（node:fs + 正则即可）；解析失败视为检查失败（fail loud）。
验收标准：人为把 ci.yml 的 tag 改错→脚本报出该位置；恢复后通过；pnpm run check 全链路绿。
```

---

## 使用建议

- 提示词按「一个任务一个提示词」拆分，避免合并导致验收口径互相稀释；改动跨包时（如 P6 涉及 mount 与新组件）保持单提示词内的文件清单完整。
- 每个 P 的验收都隐含「pnpm run check 通过」——agent 应在交付前跑齐 lint/typecheck/build/test。
- 基线升级（P8 落地后）应作为其他一切任务的前置检查执行。
