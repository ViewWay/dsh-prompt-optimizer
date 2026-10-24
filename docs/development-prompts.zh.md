# 开发提示词包（Development Prompts）

把本插件家族已实现的功能沉淀为可直接投喂给 agent 的任务提示词。用法：在仓库根目录打开一个 agent 会话（dsh / ZCode / Claude Code 等），整段复制下面某个提示词块作为任务输入。每个提示词自包含：背景、目标、约束、验收标准，不依赖会话上下文。

仓库速览（所有提示词共享的事实）：四个包 —— `packages/prompt-optimizer`（Host 服务，核心在 `src/index.ts` / `src/meta-prompt.ts` / `src/skills.ts` / `src/recommend.ts`）、`packages/api-prompt-optimizer`（Typert Remote，`tsc -b` 构建）、`packages/client-ui-prompt-optimizer`（浏览器 UI，`src/client/`，`tools/tsdown.client.ts` 预设出闭包工件）、`packages/bundle`（`cordis.patch.yml` 一键叠加）。版本基线：`@deepseek-ai/dsh-*` `0.2.1-rc.3`、`@deepseek-ai/cordis` `4.0.5`、`zod` 精确 `4.6.7`。门禁：`pnpm run check`（lint + typecheck + build + test；client 测试需 `DSH_HARNESS_ROOT` 指向 harness 检出）。

---

## P1 桌面端启用与冒烟验证

```text
任务：在 dsh 桌面应用（Electron 开发模式）里启用本插件家族并做一轮完整冒烟验证。

背景：
- 仓库是独立分发的 dsh 插件家族（四包，见根 README）；桌面应用源码在同级 harness 检出（DSH_HARNESS_ROOT 默认 ../deepseek-harness-latest）。
- 桌面 dev 模式：在 harness 检出里 `node_modules/.bin/pnpm run dev:desktop`（首次会全仓构建并下载 Electron）；dev home 在 `apps/desktop/.desktop-build/development/home`。
- 插件启用方式：往 `…/home/profiles/desktop/cordis.patch.yml` 追加一个 `- insert:` 块，三行 id/name 分别是 prompt-optimizer→@deepseek-ai/dsh-experimental-prompt-optimizer、api-prompt-optimizer→@deepseek-ai/dsh-experimental-api-prompt-optimizer、ui-prompt-optimizer→@deepseek-ai/dsh-experimental-client-ui-prompt-optimizer（名字经 dev project 的依赖目录解析）。
- 注意：上面三个 `@deepseek-ai/dsh-experimental-*` 名字是 harness 检出内置的实验副本（`packages/experimental/`，本仓库插件家族即由此抽出），按 P1 冒烟的是 harness 侧副本而非本仓库 `@yimiliya/dsh-*` 独立分发产物；若要冒烟本仓库产物，改用 `pnpm -r pack` 打出 tarball 后按根 README 的 tarball 路径安装 bundle。

要求：
1. 启用插件后重启桌面端，逐项冒烟：输入框「优化」按钮、预览面板（原始/优化对照、变更说明、验收准则）、mechanical 准则「运行核验」按钮、队列条目行内入口、设置页默认角色下拉。
2. 验证产出语言跟随界面语言（中文界面出中文提示词，切 English 后出英文）。
3. 结果检查以会话日志为准：dev home 下 sessions/<workspace>/session-*/session.v4.jsonl.zstd，解包后应有 plugin:prompt-optimizer/llm-request 与（若点了核验）plugin:prompt-optimizer/verify 记录（均为 ignorable 插件记录，宿主无需识别其类型），且全程无 error 事件。

约束：不改 harness 源码；只改 dev home 的 profile patch（可随时删掉追加块回滚）。
验收标准：上述每项入口在桌面窗口可见可用；会话日志含优化事件且零错误；退出重启后插件仍然生效。
```

## P2 技能感知优化（skillAware）维护与扩展

```text
任务：理解并维护 prompt-optimizer 的技能感知（skillAware）能力——本任务落地三件套：参数占位、top 命中深读、来源标注。

背景：
- 选型：packages/prompt-optimizer/src/skills.ts 的 selectSkillHints(context, skills) 用确定性关键词重叠打分（技能名权重×3、简介×1，阈值 MIN_SKILL_SCORE=2，至多 12 条，简介截 160 字），只保留可被模型调用的技能；每条 hint 经 sourceLabelOf() 标注粗粒度来源（project-dsh/project-agents→project、user-dsh/user-agents→user、bundled、runtime，其余→custom）。
- 深读：src/index.ts 的 resolveSkillHints 打分后经 detailSkillHints() 对前 MAX_DETAIL_HINTS=3 条调用 registry.get()；enrichSkillHint() 从 SkillDefinition 提取参数约定 metadata.parameters（支持 {name,description}/{name,desc} 对象数组、字符串数组、record 三种形态，至多 4 条、单条说明截 24 字）与正文摘要 digestOf()（空白折叠、截 200 字）；get 失败按 best-effort 降级为仅摘要，不打断优化轮。
- 注入：src/meta-prompt.ts 的 skillBlock() 渲染为「- 技能名 — 简介 [来源]; params: 参数名=说明」，深读条目追加第二行缩进正文摘要；防幻觉双保险：技能名只允许列出的精确名称，参数名同样只允许列出的名称；params 段整体截 80 字。
- 配置项 skillAware（默认 true）在 cordis.yml 的 plugins > config > prompt-optimizer 下；skillAware=true 但无技能注册表时 fail loud。

要求：
1. node 测试全绿：tests/skills.spec.ts（选型/来源/参数解析/摘要）、tests/meta-prompt.spec.ts（渲染与 80 字截断）、tests/service.spec.ts（运行时注册技能端到端注入参数与摘要）。
2. 若宿主 @deepseek-ai/dsh-skill 的 SkillSummary/SkillDefinition 字段调整，同步更新解析约定并保持测试覆盖。

约束：打分逻辑保持确定性（不引入模型调用）；12 条上限、3 条深读上限、80 字参数段上限不变。
验收标准：用例覆盖「带参技能命中→hint 含参数」「带参技能未命中→无参数段」「深读条目含正文摘要与来源标签」；全部现有测试不回归；pnpm run check 通过。
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
- 现状：宿主插槽 conversation.input.dock.queue.item 截至 0.2.1-rc.3 未随任何 npm 版本发布（rc.2 后曾短暂进入 harness 源码树、rc.3 前被移除）。src/client/mount.ts 里注册包在 try/catch 中，slot 名与注册对象以 as never 降级（旧宿主抛错→catch→ctx.logger.warn，入口静默隐藏）；src/client/QueueItemOptimizeEntry.tsx 的 Props 用本地结构声明（QueueItemEntryItem 等），不依赖未发布插槽的 PropsRuntime 查询；插件对纯文本队列项渲染入口，点击 startQueued(sessionId, itemId, text)，面板顶部仍可换角色重跑。

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
- 基线 @deepseek-ai/dsh-* 0.2.1-rc.3 分布在多处：docs/compatibility.md（自称为 source of truth）、.github/workflows/ci.yml（clone --branch dsh-v0.2.1-rc.3）、三个 package.json 的 peerDependencies 精确锁定、README 兼容性节。
- 发布事实（已实测）：pnpm -r pack 会把 dependencies 与 peerDependencies 里的 workspace:* 改写为真实版本号；release workflow 按 tag 触发、pnpm -r publish --access public --no-git-checks 依 host→api→client→bundle 依赖序发布；未发布前本地安装只能走 tarball（README 安装节已写明）。

要求：
1. 新增 scripts/check-baseline.mjs：从 docs/compatibility.md 解析出基线 tag，核对 ci.yml 的 clone tag 与全部 package.json 里 @deepseek-ai/dsh-* 的版本段一致；不一致时逐条列出位置与期望/实际值并以非零码退出。
2. 把该脚本挂进 scripts/check.sh（在 lint 之后、typecheck 之前）。
3. 同步挂进 CI：ci.yml 分步跑 pnpm run lint/typecheck/build/test，从不调用 check.sh——需在 .github/workflows/ci.yml 增加基线核对步骤（建议根 package.json 加 baseline script，CI 里 pnpm run baseline，置于 Lint 之后）。

约束：脚本零依赖（node:fs + 正则即可）；解析失败视为检查失败（fail loud）。
验收标准：人为把 ci.yml 的 tag 改错→脚本报出该位置；恢复后通过；pnpm run check 全链路绿。
```

---

## 规划中：技能深化路线（P9/P10，未实现）

以下两个提示词已定设计口径：技能落盘默认项目级、可配置个人级；进化半自动（生成 patch + diff 确认），参照 darwin-skill / huashu-nuwa / dsh-mnemon 的循环机制。待逐个执行。

## P9 技能缺口沉淀：优化结果 → SKILL.md

```text
任务：为优化结果增加「沉淀为技能」链路——当一次优化产出的提示词具有可复用价值时，蒸馏成 SKILL.md 草稿并在用户确认后写入技能目录。

背景：
- 宿主技能目录（@deepseek-ai/dsh-skill-filesystem）：项目级 <project>/.dsh/skills（source: project-dsh）、个人级 ~/.dsh/skills（source: user-dsh）；SKILL.md frontmatter 契约：必填 name（kebab-case）+ description，可选 whenToUse（字符串）、metadata（任意对象；参数约定走 metadata.parameters，见 P2）、布尔项 user-invocable / disable-model-invocation；目录 watch 默认开启，写入稳定后自动进入注册表，无需重启。
- 现有沉淀物：PromptLibrarySaveRequest 已支持把优化结果存入提示词库；本任务把「库条目」升级为「技能」，Host 需新增两个 API：suggestSkill（生成草稿，模型调用）与 saveSkill（落盘，纯确定性）。

要求：
1. Host 新增 saveSkill：按 target（'project' | 'user'，新增配置 skillSaveTarget，默认 'project'）写入对应目录的 <slug>/SKILL.md；校验 isSkillName 命名、与注册表现有技能重名冲突（fail loud PROMPT_OPTIMIZER_SKILL_EXISTS）、单文件 8000 字符上限；目标文件已存在时绝不覆盖。
2. Host 新增 suggestSkill：以优化结果 + 原始草稿为输入，产出 frontmatter（name/description/whenToUse，可选 metadata.parameters）与自包含 body；复用三标记 envelope 风格新增 SKILL envelope 与解析器。
3. UI：预览面板结果卡旁加「沉淀为技能」入口；确认弹层展示完整 SKILL.md 内容与目标目录，用户可改 slug 与 target；落盘成功提示技能已进入注册表。
4. api 包补 Typert 描述符；文案走 locale 双语字典。

约束：写入必须是用户显式确认动作；slug 冲突允许改名重试；不引入新依赖。
验收标准：saveSkill 确定性测试（目录选择、重名、命名与大小校验、不覆盖既有文件）；suggestSkill envelope 解析测试；UI 确认流 jsdom 测试；pnpm run check 通过。
```

## P10 技能进化：使用反馈 → 达尔文式完善回路

```text
任务：为已沉淀技能建立进化回路——像 darwin-skill 那样（固定 rubric 评分 → 生成改进 patch → 测试提示词盲评门控 → git 版本化 → 人工 checkpoint；收益递减自动停），用真实使用反馈持续完善技能，全程人工把关。

背景：
- 参照机制：darwin-skill 对 SKILL.md 做 9 维 rubric 评估后爬山改进、每步 git commit、独立评审盲评、验证门控、diminishing returns 自动停；huashu-nuwa 把主题思维框架蒸馏成可运行技能（新技能从何而来）；dsh-mnemon 用记忆空间沉淀洞察并建语义链（反馈从何积累）。
- 本插件已有钩子：优化轮记录 skillsHinted 与命中技能；PromptVerifyResult 已能执行机械验收命令；registry.get() 可取技能完整定义；P9 的落盘与目录契约直接复用。
- 进化素材：一次优化中「引用了技能 X 的提示词 + 用户采纳/拒绝 + verify 通过与否」即一条使用反馈。

要求：
1. Host 新增 evolveSkillEvaluate：给定技能名加载完整定义，按代码内写死的 rubric（触发描述准确性、自包含性、防幻觉边界、简洁性、参数声明合理性、与宿主 API 一致性等）产出评分与短板清单；纯模型调用，零写操作。
2. Host 新增 evolveSkillDraft：以短板清单 + 近 N 条使用反馈（采纳率、verify 通过率、被拒重写样本）为条件，生成改进后的完整 SKILL.md 全文 + 变更说明（新 envelope），不落盘。
3. 版本化：技能所在目录无 git 仓库则 git init；每次用户采纳进化生成一条 commit（message 含评分摘要），可回滚。
4. 验证门控：patch 须通过测试提示词盲评（改进前后定义各跑一轮对比打分）且不低于现版；连续 2 轮提升低于阈值自动停止并报告。
5. UI：技能卡「进化」入口 → 评分报告 → patch diff 确认 → 落盘；一切写操作均为用户显式点击。
6. 使用反馈持久化为插件数据目录下的 JSONL（技能名、时间、采纳与否、verify 结果），提供清理入口。

约束：绝不自动改写技能文件；rubric 维度写死、可开关但不可注入自定义提示（防提示注入）；单技能单次进化至多 3 轮迭代；评审调用走插件现有 route 解析。
验收标准：评分确定性测试（同输入同分数）；patch 仅在用户确认后落盘（测试断言）；git commit 含评分摘要且可回滚；递减停止逻辑有测试；pnpm run check 通过。
```

---

## 使用建议

- 提示词按「一个任务一个提示词」拆分，避免合并导致验收口径互相稀释；改动跨包时（如 P6 涉及 mount 与新组件）保持单提示词内的文件清单完整。
- 每个 P 的验收都隐含「pnpm run check 通过」——agent 应在交付前跑齐 lint/typecheck/build/test。
- 基线升级（P8 落地后）应作为其他一切任务的前置检查执行。
