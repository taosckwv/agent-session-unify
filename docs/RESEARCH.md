# 跨工具会话统一：调研结论

范围：Claude Code、Codex CLI、DeepSeek Harness（DSH）的会话记录，统一成同一种格式做分析。
本文是**调研结论**（事实、依据、结论、未验证项），不是设计文档，也不含实现代码。

日期：2026-11-25。本机环境：DSH Desktop 0.14.0（内含 `@deepseek-ai/*@0.2.2-rc.1`）、Claude Code CLI 2.1.303 + VS Code 扩展 2.1.330。

---

## 1. 要处理的数据与边界

- **Claude Code 的数据是泄露版 2.1.88 产生的历史会话**，不是本机 2.1.303/2.1.330 的（本机 6 个会话只作参考）。
- 输入只有两类：**原始会话文件**、**已经抓好的请求文件**。抓请求不在本项目范围。
- 会话来源：DSH `session.v*.jsonl.zstd`、Claude Code `projects/*.jsonl`、Codex `sessions/rollout-*.jsonl`。

## 2. 三条基本结论

1. **没有现成的三家统一解析库。** 最接近的都不覆盖 DSH；DSH 相关项目几乎都是查看器或遥测插件。
2. **每家都有版本分代**，且格式差异不小；解析器必须按版本分支，不能一个实现通吃。
3. **B 线（还原每一步真实请求）没有可抄的实现。** 现有工具要么只做用量，要么只发 span，没有一个做请求回放重建。

## 3. Claude Code

### 3.1 版本分段

以 `apiBlockIndex` 是否存在为分界，约在 **2.1.300**：

| 特征 | 2.1.88 时代（要处理的数据） | 2.1.3xx（新版） |
|---|---|---|
| `apiBlockIndex` | 无 | 有 |
| 一条 assistant 记录 | 完整 message，含多个 content block | 只装一个 content block，共享 `message.id` |
| `api-request` / `api-request-shape` | 无 | 有（B 线可直接取请求体） |
| `subagents/` 子目录 | 无（子 agent 混在同一文件） | 有 |
| `prompt_snapshot` | 无 | 有 |
| `compact_boundary` / `logicalParentUuid` / `compactMetadata` | 有 | 有，另加 `cumulativeDroppedTokens` |
| `parentUuid` / `isSidechain` / `toolUseResult` / `sourceToolUseID` / `sourceToolAssistantUUID` / `agentId` | 有 | 有 |
| 分发形态 | 单个 13 MB `cli.js` | 原生二进制分包（2.1.332 的 npm 包仅 32 KB / 7 文件） |

泄露版本 = `@anthropic-ai/claude-code` **2.1.88**，发布 2026-03-30T22:36Z（北京时间 3 月 31 日），已从 npm 下架，只剩 `time` 记录。上面的对比是用相邻的 2.1.89 解包 `cli.js` 得到的（2.1.88 本身已无法下载）。

### 3.2 对新旧版本的影响

- 老版一条记录 = 一条消息，**不按 `message.id` 聚合**；新版必须聚合，否则 token 与轮次放大 2–5 倍。
- 老版**没有请求体记录**，B 线只能回放。
- 老版**没有 `prompt_snapshot`**，回放缺 system prompt 段，只能标记缺口。
- 老版**没有 `subagents/`**，父子关系只能靠 `isSidechain` + `agentId` + `toolUseResult` 推断。

### 3.3 通用要点（两代都适用）

- compact 不是删除而是重接链：`compact_boundary` 的 `parentUuid=null`，真实前驱在 `logicalParentUuid`；随后 `user{isCompactSummary:true}` 的 `message.content` 是字符串不是块数组。
- tool 配对三条线索：`tool_use.id ↔ tool_result.tool_use_id`、`sourceToolAssistantUUID`、`toolUseResult`。孤儿/重复结果合法，标 `pending_or_interrupted`。
- 目录名不可反解（`AI工作流` → `---`），真实路径取记录内 `cwd`。
- 会话发现要避开 `.orphaned-*` / `.superseded-*` 重写副本。
- 版本判定顺序：记录内 `version` > `~/.claude.json` 的 `lastVersionBase` > 结构信号 > 二进制版本（**不能用二进制版本反推历史文件**）。
- 无 `version` 字段的记录（本机占三分之一：`atis-latch`、`last-prompt`、`api-request-blob`、`queue-operation`、`cost-state`、`file-history-snapshot`、`ai-title`）继承同文件里最近一条带版本的记录。

### 3.4 本机参考数据

`~/.claude/projects` 共 6 个会话、221 行、全部 2026-11-25 当天生成：`2.1.303` 133 条（5 文件）、`2.1.330` 16 条（1 文件）。无跨版本续写文件，72 条记录无 `version` 字段。

## 4. Codex CLI

- 三代格式：era0 ≤0.31 无信封（裸 SessionMeta + 裸 ResponseItem）；era1 0.32–0.144 `{timestamp,type,payload}`；era2 0.145+ 加 `ordinal` / `session_id`。
- 判版：优先 `session_meta.payload.cli_version`，否则结构嗅探；**不能用 EventMsg 变体数**（非单调）。
- 0.137 起冷会话压成 `.jsonl.zst`；0.148 起 wire 映射迁到 `codex-rs/history` crate。
- 坑：三层 type 同名不同义；文件名时间戳是本地时间、行内是 UTC；`session_id` 缺失时 `id` 是线程 id，不等于 session_id；compacted 不删历史行，以 `replacement_history` 为准；MCP 结果与命令输出各截断 64 KiB；官方直接丢弃 `ResponseItem::Other`。
- **本机没有装 Codex，也没有 `~/.codex`**，上面的格式来自源码结构与官方文档，未用真实数据校准。

## 5. DSH

- 容器：`session.v<N>.jsonl.zstd` 是多帧 zstd（每行一帧），必须按帧魔数切分逐帧解；只读最高 `vN`，`session.jsonl` = v0。
- 信头：`{type:"session", version, id, createdAt, cwd, isSeeded, delegationDepth, agentPreset, parentSession?, origin?}`；事件 `{type, seq, time(epoch ms), data}`。
- 实测 416 会话 / 65,436 事件 / 32,439 帧，零解码失败。事件类型 40 种，关键：`request/header`（工具清单与路由）、`request/context`（provider/model/窗口）、`assistant/message`（usage 主口径）、`tool/call`、`tool/result`、`compaction/summary`、`session/end-seed`（fold 切点）。
- **日志里没有完整 messages**：`request/header` 只有工具清单与路由配置，`request/context` 只有 provider/model/窗口。消息内容散在 `user/message`、`assistant/message`、`system/message`、`tool/call`、`tool/result` 里 → **B 线必须回放重建**。
- usage 口径：`assistant/message.data.usage`；`compaction/summary` 单列；`assistant/attempt` **不带 usage**（从那儿取会重复计账）。`inputTokens` 已排除 cache 读写，`reasoningTokens ⊆ outputTokens`。
- 去重：先按 session id 合并根目录（`~/.dsh/sessions` 与 `harness/sessions` 是镜像，直接相加会把 849.81M 变成 1.28B），再按 `(session_id, seq)`。
- 判版：`header.version` 权威；文件名交叉校验；`delivery-accepted.sessionFormatVersion` 不是日志版本。本机 DSH Desktop 0.14.0 写 v4（自 2026-10-20 起），另有 v3（至 2026-10-18）。
- 坑：`surfaceOp` 规格写 `start/end`，本机实测是 `startSeq/endSeq`（两种都要认）；v3 的 `isError` 藏在 `content[0]`，另有第三路 `data.error{name,code}`；`new-api` 与 `newapi` 是两个不同 provider 字面量，不归一。

## 6. 已有实现调研

### 6.1 能覆盖三家的

| 项目 | 语言/许可 | 覆盖 | 可借鉴处 |
|---|---|---|---|
| ZH-TX3/trajectory-viewer | Rust / MIT | CC + Codex + DSH | 三家各一个解析器统一成 `TrajectoryData`；DSH 的 zstd 处理、读前 200 行自动识别来源 |
| alibaba/loongsuite-pilot | TS / Apache-2.0 | CC + Codex + DSH + 更多 | 归一化层、GenAI 事件 schema、Codex rollout 解析、内容字段命名 |
| doit2020s/ai-session-viewer-grok-dsh | Rust / MIT | CC + Codex + Grok + DSH + Pi | 多来源会话管理器的目录与元数据抽象 |

### 6.2 DSH 相关的其他项目

`dsh-session-viewer`（TS，离线解析）、`dsh-trace-viewer`（TS）、`dsh-history-viewer`（JS，零依赖）、`dsh-subagent-tree`（父子会话树）、`dsh-coldread-cache`（常驻解析 + 追加式增量）、`ccusage`（Rust DSH 适配器，usage 口径可当验收标准）、`jwilson411/dsh-otel`（span 树与派生 id，导出不含内容）、`linyp/dsh-plugin-langfuse`（DSH 事件 → OTLP traces）、`loongsuite/dsh-plugin`、`PerryLink/dsh-observe`、`Yuntwo/dsh-langfuse-plugin`。

### 6.3 统一格式的候选

- **OTel GenAI span 树**：协议层是 OTLP（protobuf 或 JSON），语义靠 GenAI 语义约定（`gen_ai.*`）。Claude Code 已吐 `gen_ai.system` / `gen_ai.request.model` / `gen_ai.response.id` / `gen_ai.usage.*` / `gen_ai.tool.call.id`，但 span 名仍是 `claude_code.*`；Codex 是 `codex.*`。语义约定仍为 Development 状态，`gen_ai.system` 正被 `gen_ai.provider.name` 取代。
- **agent-canonical**：CC / Codex 的 Zod schema + 解析器，无 DSH，pre-1.0。
- **gh-aw Unified Agent Session Spec**：事件词汇 + 无损契约，Draft，无 DSH。
- 结论：语义层可以对齐到 `gen_ai.*`，但每家都要一层映射，不是连上就通用。

### 6.4 B 线现状

没有可抄的实现。现有工具分两类：一类只统计用量（ccusage），一类只把事件转成 span（各类 telemetry 插件），都不做“逐步还原当时发出的 messages”。Claude Code 新版有 `api-request` 可直接取，但 2.1.88 没有；DSH 从来没有。

## 7. 内容怎么放、怎么脱敏

- **内容必须带**：不能采用只发 span、不带 prompt 与工具参数的做法。
- **存法**：第一步存全量 messages，后续只存增量 + `messages_hash`，读取按 hash 链还原。理由：agent 每步都把历史全量重发，逐条存全量会让文件膨胀到原日志的几十倍。
- **分层**：会话级（system prompt、工具定义、模型、cwd、git）→ turn 级（起止、结束原因、用量）→ step 级（请求、响应、usage）→ tool 级（参数、结果、是否报错）。
- **脱敏范围只限凭据**：API key、`Bearer` 值、`Authorization` 头、URL 里的 token、连接串里的账号口令、配置里 `apiKey/token/password/secret` 字段。替换成带 hash 前缀的占位符，原文不落盘。路径、代码、对话原文全部保留。
- 副作用要接受：带内容的文件本身就是敏感资料，需要按原始日志同级管理。

## 8. A/B 线关系

- **A 线（原始解析）为准**：从原始会话回放重建，`reconstruction.method = "replay"`。
- 有捕获请求时用它核对：一致不记，不一致写进 `reconstruction.diffs`。
- 只有回放不出来时，才用捕获补齐，并标 `source = "captured"` 且在 `gaps` 里写明补的是哪一段。
- 对齐键（可靠性降序）：`messages_hash` > 请求时间与 `step/start` 时间就近 > 模型名 + 消息条数 > 顺序。对不上的写 `gaps`，不错位硬拼。

## 9. 一句话结论

A 线可以靠第三方实现起步（trajectory-viewer 的三家解析器 + ccusage 的 usage 口径），DSH 与 2.1.88 的差异需要自己补；B 线只能自建，且 2.1.88 与 DSH 两处注定只能回放、缺 system prompt 段。

## 10. 未验证与未决

- Codex 格式全部来自源码结构，**无真实样本**，需要在一台装过 Codex 的机器上校准。
- 2.1.88 的会话样本尚未到手，上面的差异是从 2.1.89 的 `cli.js` 推断，需用真实文件验证（断言：条数守恒、字段齐全、两次解析 hash 一致）。
- 捕获请求文件的具体格式未定（一请求一文件 / 一会话一 jsonl / 原始 HTTP 体）。
- 父会话与子会话的文件关系（CC 的 sidechain、DSH 的 `parentSession`、Codex 的 subagent）尚未统一。
- 单会话文件过大时的分片策略未定。
