# 改造计划：从「改写器」到「规格生成器」（2026-11）

本计划基于 2026-11 的两轮调研（外部研究 + 代码盘点）制定。核心判断：**模型变强不会杀死这个插件，但会杀死「单次改写器」这个形态。** 护城河按优先级排序：① 能证明自己有效的评测回路 ② 意图澄清面试 ③ 模型感知优化 ④ 持久资产优化。

## 研究结论（决策依据）

| 证据 | 含义 |
| --- | --- |
| PromptPerfect（Jina AI）2026-09 关停；ChatGPT/OpenAI 内置 improve prompt 吞并独立工具 | 「把一句话改写得更漂亮」的独立市场正在消失 |
| Wang 2026：推理型模型上精细提示工程收益递减甚至为负 | 对推理模型做措辞调优是负价值；但约束完备性仍有效 |
| GEPA（arXiv:2507.19457）：反射式提示进化超 MIPROv2 10%+，实践建议 20–100 标注样本、模型升级后重跑 | 优化的正确形态是「候选 + 评分 + 进化」闭环，不是单轮改写 |
| Anthropic《Effective context engineering》：上下文窗口是稀缺资源，要策展而非堆砌；Chroma「context rot」：输入越长质量越非均匀劣化 | 持久资产（system prompt/skills）的体积与结构本身是优化对象 |
| 本地小模型（Qwen/Llama）上提示工程反而更重要（"prompt is a contract"） | dsh 的 LiteLLM/vLLM/Ollama 用户是反趋势阵地，无内置工具服务他们 |
| 2025 研究：LLM 能识别歧义但很少主动追问；多轮澄清显著提升意图获取 | 「优化前先问」比任何改写模板都高杠杆 |

代码盘点确认的缺口（2026-11-14）：无优化质量评测回路；元提示对所有模型逐字节相同；角色/技能匹配依赖关键词重叠；P9（SKILL.md 蒸馏）与 P10（技能进化）设计完成但未实现。

## 分阶段路线

### P0（本次，`feat/model-aware-p0` 分支）：模型分挡 + 克制优化

- `src/model-tier.ts`：按路由 id 分类三档——`reasoning`（r1/reasoner/o系/qwq/thinking 等标记）、`local-small`（litellm/vllm/ollama 等网关，或 ≤14B 开源家族带显式尺寸）、`standard`（其余）；推理标记优先于网关。
- 分挡注入元提示：推理档禁加思维链脚手架、改写偏向规格完备与信息密度；本地小模型档要求全显式不变量、逐条短句、字面输出模板；standard 档提示词逐字节不变（向后兼容）。
- 「不优化」预检（`skipCheck`，默认开）：推理档 + 简短清晰 + 无角色/方向/领域先验/重试的草稿 → 不调 LLM，直接返回 `skipped` 结果与稳定原因（`reasoning-short-clear`），记录 `plugin:prompt-optimizer/skipped`；请求带 `force` 或任何显式重跑（rerun 恒置 force）即绕过。
- UI：劝退建议块 +「仍要优化」按钮；非 standard 档位徽标；劝退时隐藏方向行、禁用替换。
- 线契约：请求 `force?`，结果 `tier?`/`skipped?`/`skipReason?`；typert 生成物锁步同步（生成器依赖上游内部工作区，本仓为 vendored 手工镜像，controller 编解码测试把关）。

### P1：意图澄清面试（✅ 已落地，`feat/model-aware-p0` 分支）

优化前对含糊草稿生成 2–3 个高杠杆澄清问题（漏了什么约束？输出给谁？什么算成功？），用户点选或跳过后再改写。产品定位从「改写」升级为「把模糊意图变成可验证规格」。

已落地形态：输入行 `?` 触发 `interview` RPC（独立元提示：最多 3 问、每问 ≤4 个可点选候选、`(free text)` 标记自由作答、领域先验直接转为提问清单、完整草稿允许零问题）；预览面板进入 `interviewing` 阶段渲染问题卡片（选项 chips + 自由输入），「带着澄清重新优化」把 Q&A 作为权威需求注入改写（系统侧规则：答案优先于草稿、按位并入而非附录）并恒定 force；答案在显式重跑中保留；「无需澄清」自动落入普通轮；带澄清的轮次永不被劝退预检拦截。记录 `plugin:prompt-optimizer/interview`（路由/问题数/字节）与 llm-request 的 `clarifications` 计数。

### P2：评测闭环（GEPA 精神的落地版）——P2a、P2b、P2c 已落地

**P2a 本地统计闭环（✅ 已落地，`feat/model-aware-p0` 分支）**：独立 `prompt_optimizer_metrics` 存储域（append-only 行：kind/route/tier/时间戳/计数，2000 行保留上限，**不含草稿内容**）；宿主自动写入四类（declined/interviewed 按问题数/clarified 按答案数/verify-passed·failed），客户端上报三类用户意图（adopted=替换草稿、rejected=显式重跑弃用、decline-overridden=「仍要优化」推翻劝退）；`listMetrics` 聚合（采用率、核验通过率、劝退与推翻、面试问题数）在设置页渲染为「本地统计」卡；`metrics` 配置可整体关闭。插件第一次能回答「我到底有没有用」。

- 金标集回归：`previousAttempts`（被拒候选）与被采纳结果落本地统计（✅ 已随 P2a 落地）
- 生成 N 候选 + LLM-judge 打分 + 帕累托展示（P2b ✅ 已落地，分支 `feat/p2b-judge`：顺序生成 2–4 候选、兄弟候选注入求差异化、judge 三维打分 + BEST 推荐位、帕累托前沿标记、judge 失败降级为无分候选；`candidates-generated`/`judge-score` 两类指标行与设置页平均分；全量 check 272/272）
- 元提示模板任何改动先跑回归，防劣化；模型切换时提示「system prompt 是为旧模型调的，要重新优化吗」（P2c ✅ 已落地：`prompt_optimizer_system_tracks` 域按会话记录系统提示词调优路由（随 `metrics` 开关、不存内容）；optimize/optimizeCandidates 结果在路由变化时携带 `systemPromptStale {from,to}`，面板提示并指向既有「按系统提示词优化」按钮，重调后消除；`tests/golden.spec.ts` 对全部 7 个系统提示 + 7 个输入框架做字节级金标。全量 check 314/314）

### P3：SKILL.md 蒸馏（原 P9）✅ 已落地

重复检测触发（同类草稿第三次优化时主动建议），把优化结果蒸馏为 SKILL.md（渐进披露、引用一层深），沉淀一次性价值为持久资产。`evolveRole` 的下一站产出 SKILL.md 格式。

已落地形态（分支 `feat/p2b-judge` 同支）：`prompt_optimizer_repeats` 存储域按归一化草稿哈希计数（不存内容，随 `metrics` 开关），第三次命中时结果携带 `suggestDistill`；`distillSkill` RPC 两阶段（预览轮 + 确认写盘，镜像 evolveRole），写入会话项目 `.dsh/skills/<name>/SKILL.md`（`distillDir` 可覆盖，同名先备份 `.bak`），文件系统 provider 即时收录；面板建议块 + 定义预览 + 确认/放弃；`distilled` 指标行与设置页计数。全量 check 288/288。

### P4：上下文体检（context doctor）✅ 已落地

扫描 system prompt + skills + 记忆组合：冗余、冲突、过期引用（提示词提到的工具已不存在）、token 预算占比（对抗 context rot）。dsh 插件位置独有——网关拿不到这些输入，独立工具拿不到路由。

已落地形态（分支 `feat/p2b-judge` 同支）：`contextCheck` RPC 确定性扫描（零 LLM）——系统提示经 `systemPrompt.assemble`（以会话 Agent 为 scope，降级到全局层）逐段计体量/占比/粗估 token（CJK 单字计）；技能经注册表按工作目录列出并深读前 16 个正文，做 Jaccard 重复检测、超长检测、相对文件引用存在性核对（按技能 resourceBase 目录）；五类发现（超长/重复段落、超长/重复技能、失效引用）。纯分析逻辑在 `src/context-check.ts`。输入行「体检」按钮 → composer 位 `ContextPanel` 报告卡。记忆子系统本 harness 未提供，未纳入。全量 check 304/304。

### P5：上下文修复——context doctor 从诊断到收口（✅ 已落地，分支 `feat/v1.0.0-sprint`）

五类发现中三类天然可修复。按「有无写回路径」分层，全部镜像 `distillSkill` 的两阶段（预览 → 确认写盘 + `.bak`）：

- **技能侧（有 `fs.writeText` 路径）**
  - `stale-skill-reference`：零 LLM 修复——从正文删除该引用行；技能目录内存在同扩展名近似文件名时同时提议改写目标路径。
  - `duplicate-skill`：一轮模型草拟合并后的 SKILL.md（走 `parseSkillDefinition` 校验与 `SKILL_MAX_CHARS` 上限），预览全文，确认写盘；被并入方整份备份为 `.bak`，registry 即时反映新内容。
  - `oversized-skill`：不自动修改（截断有语义风险），报告文案维持「细节移入引用文件」建议。
- **系统提示侧（`systemPrompt.assemble` 只读，无写回 API）**
  - `duplicate-section`：一轮模型草拟合并文本，报告卡提供「复制建议」按钮，明确标注 advisory——不越权写回。
  - `oversized-section`：零 LLM，只给分段/裁剪点位建议，同样 advisory。
- 线契约：新 `contextFix` RPC（session + finding 定位 + phase；预览返回 diff，确认执行），确认后自动重跑 `contextCheck` 验证该 finding 消失；typert 生成物锁步同步，controller 编解码测试把关。两个新元提示（技能合并、段落合并）入 `tests/golden.spec.ts` 字节级金标。
- **验收标准**：① 三类可修复发现在 `ContextPanel` 报告卡有修复入口，预览 → 确认 → 写盘 → 重扫消失全链路有测试；② 每次写盘必有 `.bak`；③ 系统提示侧建议带 advisory 标注且无任何自动写回；④ 全量 check 通过。

### P6：技能进化 + 采纳回流（P10 轻量版）（✅ 已落地，分支 `feat/v1.0.0-sprint`）——把 P2a/P2b/P3 连成环

- **P6a 技能进化（`suggestEvolve`）**
  - 新域 `prompt_optimizer_skill_links`：`distillSkill` 确认写盘时登记 `fingerprint → {name, targetDir}`（不存草稿内容，与 repeats 同界）。v0.8 只做指纹精确命中；领域级模糊匹配（domainPriors 键）留待后续。
  - `noteRepeat` 命中且已有链接时，结果携带 `suggestEvolve {name}` 替代 `suggestDistill`；面板建议块文案变为「更新技能 <name>」。
  - 进化流扩展 `distillSkill`：请求携带 `evolveOf`（既有定义 + 本轮 draft/optimized + 澄清），独立进化元提示（保留仍成立的约束、并入新差异、逐条变更说明），预览对照旧定义 → 确认覆盖 + `.bak`（confirm 路径已有备份语义）。
  - 指标行 `evolved`；进化元提示入金标。
- **P6b 采纳回流（同域先例）**
  - 新域 `prompt_optimizer_precedents`（**存优化结果文本**，与 metrics「永不存内容」分立，README 隐私节须同步更新——同机同级于既有会话事件日志，不外发）：客户端 adopted 上报挂点扩展可选 `optimizedText`/`domain`/`judgeTotal` 字段（metrics 行仍零内容；字段在场时宿主另写先例），每域保留 ≤3 条按 recency + judgeTotal 淘汰。
  - 注入：`optimizerUserInput` / `candidateUserInput` 增加可选「同域先例」块（仅 1 条最佳先例，标注为参考非模板）；local-small 档不注入（防上下文膨胀）。输入框架新增带先例形态，与不带先例各入金标一份。
  - `precedents` 配置开关（默认开）；先例域行数有上限与清理，随开关整体停写。
- **验收标准**：① 同指纹第三次优化且存在链接技能 → `suggestEvolve` 而非 `suggestDistill`；进化确认后 SKILL.md 为新版、`.bak` 为旧版；② adopted 后同域下一轮的输入框架含先例块（node 测试断言输入串），`precedents: false` 或 local-small 档时完全缺席；③ 先例域淘汰、上限、关闭抑制均有测试；④ 新元提示与新输入框架形态入金标；全量 check 通过。

### P7：证据包（✅ 已落地，分支 `feat/v1.0.0-sprint`，随 1.0.0 发布）

`src/eval-pack.ts` 内置 12 条领域交错标注样本（每域 2 条）；`runEvalPack` RPC 每样本跑「改写轮 + judge 轮（A=原始草稿 vs B=改写）」对比，judge 失败降级为未计分样本；`eval-run`/`eval-win` 指标行 + 设置页聚合行；体检面板内「证据包」一键对比卡；`systemPromptStale` 文案升级为指向重跑对比。

### P8：验收先行模式（✅ 已落地，分支 `feat/v1.0.0-sprint`，随 1.0.0 发布）

`mode: 'goal'` 面试变体（`goalInterviewSystemPrompt`：首问固定「什么算完成」，金标守护）；客户端「验收先行」触发；首问答案按换行/分号编译为 ≤4 条 `goalCriteria`，其余答案保持 clarifications；三轮系统提示均注入 goal 块（权威验收——改写必须满足并逐条重述）；随重跑/多候选保留。ZCode skill 产品化为跨仓分发渠道，不在本仓 npm 发版门内，另行立项。

## 不做

- 通用 chat 类提示词优化（被内置工具吃死）
- 盲评/git 版本化的重技能进化（个人用户用不起）
- 为前沿模型用户做精细措辞调优（负收益证据最充分）

## 验证状态（1.0.0 冲刺）

- P5：`contextFix` RPC（预览→确认写盘 + `.bak` + 重扫）、技能侧可写边界（仅蒸馏目录内）、系统提示侧 advisory、技能合并/段落合并元提示入金标；`tests/context-fix.spec.ts` + `tests/context-fix-service.spec.ts`。
- P6：`prompt_optimizer_skill_links` 域 + `suggestEvolve`（每三次命中阈值触发，替代 suggestDistill）；`distillSkill` 扩展 `evolveOf`（名称钉定 + 原地覆盖）；`prompt_optimizer_precedents` 域（每域 ≤3 按 judge 分+新近淘汰）+ adopted 上报携带先例材料 + `optimizerUserInput`/`candidateUserInput` 先例块（local-small 档不注入）；`precedents` 配置开关；`tests/skill-evolution.spec.ts` + `tests/precedents.spec.ts`。
- P7/P8：`tests/eval-pack.spec.ts` + `tests/goal-mode.spec.ts`；金标扩至 9 系统提示 + 11 输入框架。
- 全量 check 于 1.0.0 冲刺分支通过（node 254 / client 103）。

## 验证状态（历史）

- P0 落地于分支 `feat/model-aware-p0`（commit d86a6c3）：分挡矩阵、劝退矩阵、模板注入、service 劝退/force/档位路径、controller 编解码往返。
- P1 落地于同一分支：node 工程 156/156（面试模板与解析、澄清注入与校验、interview 派发与记录、controller 透传）、client 工程 81/81（面试流转、澄清随重跑保留、面试面板渲染、`?` 触发）。
- P2a 落地于同一分支：全量 247/247（node 164：指标写入四路径、reportMetric 校验、listMetrics 聚合与率、无存储失败、关闭抑制；client 83：adopted/rejected 上报流转、设置页统计卡渲染）。
