# 安全修复执行计划 — dsh-prompt-optimizer

- **制定日期**：2026-10-24
- **唯一问题来源**：[security_best_practices_report.md](security_best_practices_report.md)（2026-10-24 安全审计报告，下称"报告"）。本计划的问题、位置、证据、修复思路全部取自报告；仅"任务分工、依赖编排、工作量与时间估算"属执行层展开，均已标注。
- **目标**：报告 8 项发现（SEC-01~08）全部落地修复或按报告建议路径降级留证，全量门禁通过。
- **通用纪律**（仓库既有约定）：最小 diff；一 SEC 项一 commit；UI 文案 zh/en 同步；generated 代码禁止手编；完成前跑 `pnpm run check`。

---

## 1. 问题清单（逐条取自报告）

| ID | 报告分级 | 问题摘要 | 报告标注的位置 | 报告缓释因素 |
| --- | --- | --- | --- | --- |
| SEC-01 | High | `zod` 固定在含已知高危漏洞的 4.4.3（GHSA-mrhx-c7xc-m3w5，超大受限集合验证内存耗尽 DoS）；zod codec 解析 Remote 客户端 JSON | `packages/prompt-optimizer/package.json:39`、`packages/api-prompt-optimizer/package.json:41`、pin 契约见 `docs/compatibility.md:10` 与 `AGENTS.md` | 攻击面有限（Remote 为本机受信 UI） |
| SEC-02 | High | `verify()` 接受 LLM 生成的任意 shell 命令：仅校验长度与超时，无白名单/危险模式过滤/二次审批；命令模板可被草稿提示注入操纵，UI 无风险警示 | `packages/prompt-optimizer/src/index.ts:587-637`（执行点 `:611-616`）、`src/meta-prompt.ts:448-462`（命令来源）、`PreviewPanel.tsx:130-142, 297-302`（UI 触发） | 需用户点击 + placeholder 填满；经宿主 `dsh-shell` 沙箱 |
| SEC-03 | Medium | `undici >=8.0.0 <8.12.2` 经 `dsh-shell` peer/dev 链引入本地与 CI，3 条已知漏洞（1 high + 2 moderate） | 依赖链自 `packages/prompt-optimizer/package.json:49,64` 起 | 发布产物不打包该链，运行时由宿主提供 |
| SEC-04 | Medium | `evolveRole()` 将 LLM 输出浅校验后直接落盘角色定义（存储型提示注入）：UI 点击即写、仅事后回显角色名，无内容审阅；该文件此后全文注入 system prompt | `packages/prompt-optimizer/src/index.ts:740-802`（写盘 `:788-793`）、`src/meta-prompt.ts:166-175`（注入面）、`PreviewPanel.tsx:171-186` | 自动备份 `.bak`；slug 双重校验防路径逃逸；需用户点击 |
| SEC-05 | Low | `prompt-optimizer/llm-request` 事件把完整草稿与 system prompt 明文写入会话日志，无文档声明 | `packages/prompt-optimizer/src/index.ts:454-466` | 本地单用户场景风险低 |
| SEC-06 | Low | `savePrompt.text` 无大小上限；`optimize.previousAttempts` 无条数/总字节上限（全量拼入 LLM 输入） | `packages/prompt-optimizer/src/index.ts:646-670`、`:506`、`meta-prompt.ts:398-409` | — |
| SEC-07 | Low | CI 三个 GitHub Actions 为 tag 引用，未 pin commit SHA | `.github/workflows/ci.yml:24,27,29`、`release.yml:17,19,21` | 已有 `permissions: contents: read`、`--frozen-lockfile`、克隆固定 tag |
| SEC-08 | Low | verify 命令输出（截断 4000 字符）全量回显 UI 并写入会话日志，可能携带密钥/敏感内容 | `packages/prompt-optimizer/src/index.ts:625-635`、`PreviewPanel.tsx:312-314` | — |

报告另附 8 项**正面发现**（XSS/密钥/路径遍历等均通过），无需整改，不进入任务清单。

## 2. 优先级排序（采用报告原分级与报告"修复优先级建议"）

| 波次 | 报告优先级用语 | 问题 | 排序依据（报告原文） |
| --- | --- | --- | --- |
| W1 | **立即** | SEC-01、SEC-02 | "两者共同覆盖当前最高风险面" |
| W2 | **近期** | SEC-03、SEC-04 | 报告第 2 条建议 |
| W3 | **随版本迭代** | SEC-05、SEC-06、SEC-07、SEC-08 | 报告第 3 条建议 |

同波次内：High/Medium 项先于跨端协作项开工（见 §4 依赖）。

## 3. 逐项修复方案、涉及文件与工作量

> 每项"方案"均为报告"修复建议"的可执行化；标注 [可选] 的为报告中"可加/考虑"级别的建议，未纳入必做范围。

### SEC-01 [High · 立即]

- **方案**（报告建议 1→2→3 的验证优先路径）：
  1. 分支上将两包 `zod` 升至 `>=4.6.6`，跑 `pnpm run check` 验证 lib/types interop 是否真不兼容（报告指出"固定理由可能已随 4.5/4.6 版本消除"）。
  2. 通过 → 保留升级，并同步更新 pin 契约文件（报告位置所列的 `docs/compatibility.md` 与 `AGENTS.md` Pinned dependencies 节）。
  3. 受阻 → 用 `pnpm.overrides` 隔离验证并向上游 harness 反馈推进 baseline；同时实施短期缓解：**在 codec 之前对输入 JSON 尺寸设预检上限**（报告建议 3）。
- **涉及文件**：两个 `package.json`、`pnpm-lock.yaml`；（成功分支）`docs/compatibility.md`、`AGENTS.md`；（受阻分支）`packages/api-prompt-optimizer/src/index.ts` Remote 入口。
- **工作量/复杂度**：**M · 复杂度中**——顺利情形约半天；受阻情形半天+上游沟通，缓解改造另计半天。不确定性集中在契约验证结果。

### SEC-02 [High · 立即]

- **方案**（报告建议 1+2 必做，建议 3 [可选]）：
  1. 宿主 `verify()` 增加命令安全层：优先**只读命令白名单**（报告例举 `grep`/`test`/`node --test`）；至少实现**危险模式拒绝**（网络外发、`| sh`/`| bash`、`rm`/写入重定向、命令链分隔符后接下载器）。
  2. UI 运行前以**显著样式（警示色 + 等宽全文）**展示完整命令，高危模式要求**显式二次确认**（报告建议 2 原文）。
  3. [可选] 让 verify 复用宿主 agent 工具调用同款审批/沙箱管道（报告建议 3，涉 harness 集成，单独立项评估）。
- **涉及文件**：`packages/prompt-optimizer/src/index.ts`（verify 方法 + 新策略模块）、`packages/prompt-optimizer/tests/`（策略单测）、`packages/client-ui-prompt-optimizer/src/client/PreviewPanel.tsx`、`locales.ts`（zh+en）。
- **工作量/复杂度**：**L · 复杂度高**——host 策略 + 防绕过单测约 1 天，UI 展示/确认 + 双语文案 + 组件测试约 0.5-1 天。为全部 8 项中最大单项。

### SEC-03 [Medium · 近期]

- **方案**（报告建议 1 必做，2 [可选]，3 建议纳入）：
  1. 仓库根 `package.json` 加 `pnpm.overrides` 将 `undici` 强制到 `>=8.12.2`，重装并跑 `pnpm run check` 验证无回归。
  2. [可选] 推动 harness baseline 升级并同步 `docs/compatibility.md`（依赖上游节奏）。
  3. CI 增加 `pnpm audit --prod` 门禁步骤（报告建议 3，防同类问题再被固定）。
- **涉及文件**：根 `package.json`、`pnpm-lock.yaml`、`.github/workflows/ci.yml`。
- **工作量/复杂度**：**S · 复杂度低**——1-2 小时（含验证）。

### SEC-04 [Medium · 近期]

- **方案**（报告建议 1 必做，2 [可选]，3 纳入 SEC-05 一并做）：
  1. UI 写入前展示生成定义的 **diff 或全文供用户审阅确认**（当前"点击即落盘"改为"预览→确认→落盘"）。
  2. [可选] 宿主对生成内容做注入标记扫描（指令劫持类语句命中即拒绝或要求更强确认）。
  3. 文档明示该功能会修改磁盘角色定义文件（并入 SEC-05 文档任务）。
- **涉及文件**：`packages/prompt-optimizer/src/index.ts`（evolveRole 两阶段化）、`src/types.ts`、`packages/api-prompt-optimizer/src/index.ts` + `src/generated/`（API 扩展需**再生成**，禁止手编）、`PreviewPanel.tsx`、`locales.ts`（zh+en）、两侧 `tests/`。
- **工作量/复杂度**：**M-L · 复杂度中高**——API 两阶段 + 描述符再生成约 1 天，UI 审阅交互 + 测试约 0.5-1 天。次大单项。

### SEC-05 [Low · 迭代]

- **方案**：README/文档声明 `prompt-optimizer/llm-request` 记录完整草稿与 system prompt 的行为及存放位置；[可选] 提供截断/脱敏选项或超阈值仅记摘要（报告原文"考虑提供"）。并入 SEC-04 的文档明示（角色定义写盘）。
- **涉及文件**：`README.md`、`README_zh.md`。
- **工作量/复杂度**：**S · 复杂度低**——约 1 小时。

### SEC-06 [Low · 迭代]

- **方案**：为 `savePrompt.text` 增加字节上限（报告建议"对齐 `maxInputBytes` 量级"）；为 `previousAttempts` 增加条数与总字节数上限。
- **涉及文件**：`packages/prompt-optimizer/src/index.ts`（savePrompt/optimize + 常量区）、`tests/service.spec.ts`。
- **工作量/复杂度**：**S-M · 复杂度低中**——半天内含边界单测。

### SEC-07 [Low · 迭代]

- **方案**：6 处 action 引用（`actions/checkout@v4`、`pnpm/action-setup@v4`、`actions/setup-node@v4` × 两工作流）pin 到完整 commit SHA；[可选] 加 Dependabot 维护 SHA 更新（报告"可加"）。
- **涉及文件**：`.github/workflows/ci.yml`、`release.yml`。
- **工作量/复杂度**：**S · 复杂度低**——1-2 小时（含查 SHA），由下一次 CI 运行验证。

### SEC-08 [Low · 迭代]

- **方案**：对 verify 输出做**常见密钥模式脱敏**（报告建议首选），或仅本地展示不落日志（二选一，推荐前者，改动小且保留审计）。
- **涉及文件**：`packages/prompt-optimizer/src/index.ts`（输出处理处）、`tests/`（脱敏单测）。
- **工作量/复杂度**：**S · 复杂度低**——2-3 小时。

## 4. 任务分工与依赖编排

### 4.1 分工（按报告位置的文件归属自然划分，写作用域零重叠）

| 工作流 | 建议负责人 | 承担任务 | 写作用域 |
| --- | --- | --- | --- |
| 供应链 | 队员 A（supply-chain） | SEC-01 → SEC-03 → SEC-07 | `package.json` × 5、`pnpm-lock.yaml`、`.github/workflows/*`、`AGENTS.md`、`docs/compatibility.md` |
| 宿主加固 | 队员 B（host-hardening） | SEC-02(host) → SEC-04(API/host) → SEC-06 → SEC-08 | `packages/prompt-optimizer/{src,tests}/**`、`packages/api-prompt-optimizer/{src,tests}/**` |
| UI 与文档 | 队员 C（ui-flow） | SEC-02(UI) → SEC-04(UI) → SEC-05 | `packages/client-ui-prompt-optimizer/{src,tests}/**`、`README*.md` |
| 统筹 | Lead | 下发/验收、依赖仲裁、最终全量门禁与审计复核 | 只读 + 收尾 commit（审计报告状态列） |

### 4.2 依赖关系（先行项 → 后继项）

```
报告优先级产生的硬顺序：
  W1(SEC-01,SEC-02) ──► W2(SEC-03,SEC-04) ──► W3(SEC-05..08)

执行层依赖（展开自报告位置的文件冲突与跨端契约，非报告新增内容）：
  D1  SEC-01 ──► SEC-03        同触 pnpm-lock.yaml，队员 A 内部串行
  D2  SEC-02(host:新错误码/策略) ──► SEC-02(UI:阻断展示)     B 先 C 后
  D3  SEC-04(API/host:两阶段参数) ──► SEC-04(UI:审阅交互)   B 先 C 后
  D4  SEC-05 依赖 SEC-04 定稿   （角色写盘声明与该功能文案一并落）
```

无其他依赖：SEC-06、SEC-07、SEC-08 相互独立，可任意并行。

### 4.3 执行顺序甘特（建议）

```
D1  A: SEC-01(验证)      B: SEC-02(host)         C: 待命/预研 PreviewPanel 改造点
D2  A: SEC-03            B: SEC-04(API/host)     C: SEC-02(UI)
D3  A: SEC-07            B: SEC-04(API) 收尾     C: SEC-04(UI)
D4  A: [缓冲/上游反馈]    B: SEC-06、SEC-08       C: SEC-05(文档)
D5  Lead: 全量门禁 + pnpm audit 复核 + 验收 + 报告状态更新
```

## 5. 时间安排建议（总计 5 个工作日，含缓冲）

| 波次 | 日程 | 任务 | 里程碑 |
| --- | --- | --- | --- |
| W1 立即 | D1-D2 | SEC-01（含契约联动或缓解落地）、SEC-02（host+UI） | 两项 High 风险关闭：audit 无 zod 或缓解已部署；危险命令被阻断 |
| W2 近期 | D2-D4 | SEC-03、SEC-04（API→UI） | `pnpm audit` undici 三条清零；角色进化需显式确认才写盘 |
| W3 迭代 | D4-D5 | SEC-05、06、07、08 | 全部 Low 项关闭 |
| 收尾 | D5 下午 | Lead 全量验证（见 §6）+ 验收 | 8/8 完成，门禁绿 |

工作量汇总：S×4（03/05/07/08）、S-M×1（06）、M×1（01）、M-L×1（04）、L×1（02）；三人并行时关键路径 ≈ SEC-02 + SEC-04 ≈ 3 天，总日程 5 天含 1 天缓冲（预留给 SEC-01 受阻分支与 SEC-07 的 CI 观察窗）。

## 6. 验证方式

**单项验证**（并入各任务 DoD）：
- SEC-01/03：`pnpm audit`（--prod 与全量）对应条目消失；`pnpm run check` 通过。
- SEC-02：危险命令策略单测（网络外发/管道执行/删除写入等正反例）+ UI 阻断确认组件测试。
- SEC-04：两阶段行为测试（未确认不落盘、确认后落盘且 `.bak` 存在）+ UI 审阅交互测试。
- SEC-05：文档评审（Lead）。
- SEC-06：上限边界单测（恰好在限通过、超限拒绝）。
- SEC-07：替换后下一次 CI 三平台运行成功。
- SEC-08：脱敏正反例单测（密钥模式命中替换、普通输出不受影响）。

**全局验证**（Lead 收尾）：
1. `pnpm run check` 全绿（仓库既定门禁）。
2. `pnpm audit` 复核：除 SEC-01 受阻分支的已知 zod 项（附证据注记）外应为 0。
3. Diff 复审对照 §4.1 写作用域：无越界改动、无临时文件、zh/en 字典键一致、每 SEC 项一 commit。
4. 更新审计报告：追加各 SEC 项"修复状态"列。

## 7. 开放决策（开工前需拍板）

1. SEC-01 若升级受阻：是否由本仓出面向上游 harness 提 issue（报告建议 2）？
2. SEC-02 白名单 vs 黑名单的起点（报告"优先白名单；至少黑名单"）：建议黑名单起步+白名单为后续演进，需确认。
3. SEC-08 二选一（脱敏 vs 不落日志）：建议脱敏，需确认。
4. 版本 bump：修复合入后是否按仓库发布流程发 0.2.1（4 包同版本），由用户决定。
