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

### P2：评测闭环（GEPA 精神的落地版）

- 金标集回归：`previousAttempts`（被拒候选）与被采纳结果落本地统计（采用率、verify 通过率、劝退命中率）。
- 生成 N 候选 + LLM-judge 打分 + 帕累托展示。
- 元提示模板任何改动先跑回归，防劣化；模型切换时提示「system prompt 是为旧模型调的，要重新优化吗」。

### P3：SKILL.md 蒸馏（原 P9）

重复检测触发（同类草稿第三次优化时主动建议），把优化结果蒸馏为 SKILL.md（渐进披露、引用一层深），沉淀一次性价值为持久资产。`evolveRole` 的下一站产出 SKILL.md 格式。

### P4：上下文体检（context doctor）

扫描 system prompt + skills + 记忆组合：冗余、冲突、过期引用（提示词提到的工具已不存在）、token 预算占比（对抗 context rot）。dsh 插件位置独有——网关拿不到这些输入，独立工具拿不到路由。

## 不做

- 通用 chat 类提示词优化（被内置工具吃死）
- 盲评/git 版本化的重技能进化（个人用户用不起）
- 为前沿模型用户做精细措辞调优（负收益证据最充分）

## 验证状态

- P0 落地于分支 `feat/model-aware-p0`（commit d86a6c3）：分挡矩阵、劝退矩阵、模板注入、service 劝退/force/档位路径、controller 编解码往返。
- P1 落地于同一分支：node 工程 156/156（面试模板与解析、澄清注入与校验、interview 派发与记录、controller 透传）、client 工程 81/81（面试流转、澄清随重跑保留、面试面板渲染、`?` 触发）。
