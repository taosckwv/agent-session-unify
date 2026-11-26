# agent-session-unify 设计

日期：2026-11-25。本文是设计共识的落盘版；格式调研的依据见 [RESEARCH.md](./RESEARCH.md)。

## 1. 一句话

把 DSH 和 Claude Code 的本地会话日志，解析成 OpenTelemetry 格式的 trace 文件（OTLP JSON）。每个文件人能直接读，分析脚本能直接算，将来也能不改格式直接导入 Langfuse 这类观测平台。

## 2. V1 范围

| 项 | 决定 |
|---|---|
| DSH | 只适配 v4 及以上；v3 及以下的旧帧跳过并计数，不猜 |
| Claude Code | 只适配 2.1.3xx（本机会话当开发样本）；2.1.88 等真实样本到手后补分支 |
| Codex | 不做 |
| 输入形态 | 三类：会话文件（`.zstd` 按 DSH 解析、`.jsonl` 按 CC 解析）、目录（递归展开）、归档（先解包再按 `.jsonl` 解析） |
| 支持的归档 | `.tar.zst` / `.tar.zstd` / `.tar.gz` / `.tgz` / `.tar`；解到系统临时目录，解析完就删。`.zip` 不做 |
| 归档里的内容 | 只提取 `.jsonl`。DSH 的 `session.vN.jsonl.zstd` 打进归档不会被解析，按「非会话条目」跳过并计数；要看 DSH 请直接传 `.zstd` 文件或它的目录 |
| 嵌套归档 | 不展开：归档里的归档同样按非会话条目计数，不递归解 |
| B 线（逐请求回放重建） | 不做；A 线断言全绿后再开 |
| 发送 Langfuse | 不是 V1 功能；产出的 OTLP JSON 文件本身可直接导入 |

## 3. 输出格式

### 3.1 文件粒度

- 一个 **agent 会话**一个 JSON 文件：主会话和它派生的子 agent 会话（同一 session_id、不同 agent）分开各自成文件。
- 文件名含会话 id 和 agent 标识：`<会话id>__<agent标识>.json`。
- 输出目录：`data/unified/<工具名>/`（dsh、claude-code），本地目录、已在 .gitignore。
- 跨文件的父子关系不靠合并文件表达：每个文件里的相关 span 带上 `trace_id` 和父会话的 span 引用，读文件时能对上。

### 3.2 文件结构

单个文件就是一个 OTLP tracesData 结构：

```
resourceSpans
 └─ scopeSpans
     └─ spans（一棵 span 树）
```

span 树固定四层：

```
会话（根 span）
 └─ turn（一轮对话）
     └─ step（一次模型往返）
         └─ 工具（一次工具调用）
```

### 3.3 字段去向

原始事件里的每个字段，三选一，不许丢：

| 去向 | 什么东西 | 例子 |
|---|---|---|
| 语义约定的标准字段 | 有对应 `gen_ai.*` 约定的 | 模型名、token 用量、工具调用参数/结果 |
| `asu.*` 自定义属性 | 语义约定没有的 | surfaceOp 的 startSeq/endSeq、compact 重建链 |
| 计数统计 | 整块解析不了、被跳过的 | 坏行数、丢弃的 v3 帧数、未识别事件清单 |

`asu.*` 是本项目自己的属性前缀，避免跟官方约定撞名。

### 3.4 消息内容

- prompt 全文、模型回复、工具参数、工具结果原文**必须带**，放 step span 的 `gen_ai.input.messages` / `gen_ai.output.messages` 属性，工具的走 `gen_ai.tool.call.arguments` / `gen_ai.tool.call.result`。
- 这是现行 OTel GenAI 规范推荐的放法（老版规范曾要求放事件，新版改成了属性；Langfuse 两边都能映射到界面的 Input/Output）。
- **不截断**：再大的工具输出也原样保留。A 线是分析底座，截了就没法分析「工具输出占多少上下文」。
- 已知限制：Langfuse 旧版本（<3.66）可能不展示按属性存放的消息原文。届时加一个「同时按事件再发一份」的开关即可，底座不动。

### 3.5 resource 与根 span 的分工

- **resource**（描述「这份数据是谁产生的」，不带时间）：工具名（dsh / claude-code）、工具版本、会话格式版本、会话 id、cwd、agentPreset。
- **根 span 属性**（描述「这次会话怎么跑起来的」）：parentSession、delegationDepth、isSeeded、origin；CC 会话还带 `sessionFile`（这个会话来自哪个记录文件，值是逻辑路径，见第 10 节）。

## 4. 程序骨架

一条单向流水线，跑一遍就结束：没有常驻进程、没有数据库，纯文件进文件出，跑完即退。

```
命令行入口 src/index.ts（parse 命令，见第 7 节）
   │  路径分派：目录递归、归档解包到临时目录、去重、定逻辑路径
   ├─ DSH 解析模块 src/dsh/：读多帧 zstd（解码在 core/zstd.ts）、判版、切事件、去重
   │
   └─ Claude Code 解析模块 src/cc/：按 message.id 聚合、切 turn、
                                   配工具、compact 重接
          │
          ▼   两家产出同一种「会话树」（只存在内存里，见 4.1）
       组装层 src/core/：会话树 → span 树（字段去向、id 派生、
                        时间回填、统计上根 span、脱敏入口）
                        ——两家共用，只写一份
          │
          ▼
       写出层：键序固定、字节级确定（第 10 节），
               一个 agent 会话一个 JSON 文件（第 3.1 节）
          │
          ▼
       终端摘要（每会话的 step 数、工具数、跳过与丢弃计数、归档对账，第 11 节）
```

### 4.1 会话树：两个解析器之间的统一中间格式

两个解析器不直接产 span，先各自把原始记录转成同一棵「会话树」，组装层只认会话树。三个理由：

1. **公共规则只写一份**：四层 span 树、字段三去向、id 派生、时间回填，两家完全共用，不用各抄一份。
2. **后补新版本只动解析模块**：比如以后补 2.1.88，差异全在「原始记录 → 会话树」这半段；产出的树不变，组装层一行不改。
3. **断言有落点**：条数守恒、字段齐全直接对着会话树查，不用等文件写出来再反推。

代价：多一层概念、多一次数据搬运；原文在内存里短暂停留（落盘前统一脱敏，见 4.4）。

树四层，与输出的 span 一一对应：

```
会话节点：身份（工具名/版本/会话 id/cwd/agentPreset）、
          运行信息（parentSession/delegationDepth/isSeeded/origin）、解析统计
  └─ 轮节点：起止时间、compact 标记、结束原因
      └─ 步节点：模型名、usage、输入输出消息、请求上下文
          └─ 工具节点：工具名、参数原文、结果原文、出错标记、配对状态
```

每个节点还带两样东西：

- **来源序号**：这个节点由输入里哪几条事件/记录构成——条数守恒靠它对账；
- **无处去的字段**：认不出但禁止丢的，原样挂在节点上，组装时统一进 `asu.*`。

### 4.2 目录结构

```
src/
  index.ts          命令行入口：parse、编排、终端摘要
  core/             公共层，两家共用
    model.ts        会话树的类型定义（四层节点、来源序号、统计、会话来源 SessionSource）
    spanBuilder.ts  会话树 → OTLP span 树
    ids.ts          span/trace id 派生 + 占位符 hash（同一套确定性算法）
    redact.ts       脱敏规则与占位符
    otlp.ts         OTLP 类型 + 键序固定的序列化 + 落盘
    zstd.ts         多帧 zstd 字节解码：按帧魔数定帧尾、逐帧解、单帧与累计双上限
    archive.ts      tar 解析与安全解包：会话归档 → 临时目录，只落 .jsonl
  dsh/
    frames.ts       读 .zstd 文件，并把 core/zstd 的解码符号原样再导出（壳）
    parse.ts        事件 → 会话树：判版、v3 跳过计数、去重、usage 口径
  cc/
    parse.ts        记录 → 会话树：聚合、切 turn、工具配对、compact 重接
tests/
  helpers.ts        三件套断言，两家共用一份
  dsh/  cc/  core/
  integration/      CLI 级用例：归档输入、确定性两跑、真进程
data/               真实样本副本（已 gitignore）
```

目录按工具分（src/dsh、src/cc），公共规则下沉 src/core：一家格式的怪癖聚在一处，改一家不碰另一家。依赖方向只有三条：`dsh/`、`cc/` → `core/`，`index.ts` → 全部；**`core/` 不许反向依赖 `dsh/`、`cc/`、`index.ts`**。所以「多帧 zstd 解码」这种两家都要、又与具体格式无关的字节能力放 `core/zstd.ts`，`dsh/frames.ts` 只剩读文件与再导出；归档解包同理放 `core/archive.ts`。运行时零第三方依赖，zstd 解压用 Node 自带 zlib。

### 4.3 模块职责

| 模块 | 吃进 | 吐出 | 藏在里面的复杂度 |
|---|---|---|---|
| dsh/frames.ts | `.zstd` 文件路径 | 解压后的 jsonl 文本 | 只剩读文件；解码符号全部再导出 `core/zstd.ts`，不抄第二份 |
| core/zstd.ts | zstd 字节 | 逐帧解出的字节 + 帧级统计 | 帧与行不是 1:1，必须全解完拼成整段文本再切行；压缩数据里会出现假魔数，帧尾要按「能解开的最小右界」定位；坏帧/撕裂尾帧跳过并计数；单帧与累计输出双上限防 OOM |
| core/archive.ts | 归档路径 + 落盘目录 + 展示路径 | 解出的 `.jsonl` 路径 + 条目统计 | tar 只覆盖会话归档会用到的形态（ustar、ustar prefix、PAX `path`、GNU 长名）；只写 `.jsonl`；拒绝绝对路径/盘符/`..`/Windows 非法字符/保留名；不创建链接；校验头校验和、严格要结束块；报错文本用调用方给的展示路径（逻辑路径），不泄漏临时目录 |
| dsh/parse.ts | jsonl 文本 + 文件元信息 | 会话树 + 统计 | 只读最高 vN；v3 及以下帧跳过并计数；镜像重复按 `(session_id, seq)` 去重；usage 只取 `assistant/message`；`surfaceOp` 两种写法都认 |
| cc/parse.ts | `projects/*.jsonl` 路径 | 会话树 + 统计 | 跳过 `.orphaned-*` / `.superseded-*`；按 `message.id` 聚合、usage 只从带 usage 的记录取；用户消息切 turn；`tool_use ↔ tool_result` 配对；compact 按 `logicalParentUuid` 重接；无 version 不猜、继承同文件最近版本 |
| core/spanBuilder.ts | 一棵会话树 | OTLP 结构 | 四层树；字段三去向；跨文件父子引用；缺起点用下一事件时间回填；统计挂根 span |
| core/redact.ts | 任意字符串 | 原文或占位符 | 第 8 节的最小规则集；同一原文永远得到同一占位符 |
| core/otlp.ts | OTLP 结构 | 文件 | 键序固定；文件名 `<会话id>__<agent标识>.json`；不掺当前时间与随机数 |
| index.ts | 命令行参数 | 退出码 + 摘要 | parse 命令、路径编排（递归、归档展开、去重、逻辑路径）、临时目录清理、多输入汇总 |

core 里的模块之间可以互相引用，但不能引用 `dsh/`、`cc/`、`index.ts`；这条是硬约束，不是风格偏好——否则一方格式的怪癖会顺着 core 漏到另一方的解析路径上。

### 4.4 全局规则归谁管

| 规则 | 归属 |
|---|---|
| 坏行/坏帧/未知事件：跳过并计数，不中断整份文件 | 两个解析模块，计数汇入统计 |
| 字段不许丢（三去向，第 3.3 节） | 解析层收集，组装层落 `asu.*` |
| 盘上只有占位符 | 组装层写字符串属性前过 `redact`，是唯一入口 |
| 字节级确定（第 10 节） | `ids.ts`（id/hash 派生）+ `otlp.ts`（键序） |
| 输出里只出现逻辑路径，物理/临时路径不进输出（第 10 节） | `index.ts` 生产逻辑路径（`SessionSource`），解析器只读物理路径、只写逻辑路径 |
| 时间全用事件自带时间戳 | 组装层的回填规则 |

三个取舍在此定案：**要**会话树中间层；脱敏在**组装层统一做**（而不是各解析器各自做，规则调用点只留一处，两家自动都被覆盖）；目录**按工具分**。

### 4.5 测试怎么搭

- 单元测试用手工造的小样本（合成数据、可入库）：坏行坏帧不炸且计数正确、取数口径（usage、聚合、切 turn）。
- 三件套（第 9 节）对 `data/` 里的真实样本副本跑，目录为空自动跳过；断言代码只写一份（`tests/helpers.ts`），两家引用同一口径。

### 4.6 这套骨架刻意没有的

自动发现（自己去找默认位置扫盘）：路径全手动传，传目录只是在该目录内递归展开（第 7 节）、Langfuse 发送与 B 线回放（第 2 节范围外，路线见第 12 节）、数据库与常驻进程。

## 5. DSH 解析口径

- **容器**：多帧 zstd，按帧魔数逐帧解，只读最高 vN 的 `session.v*.jsonl.zstd`。
- **usage 只取一处**：`assistant/message` 事件里的 `data.usage`。`assistant/attempt` 不取（取了会重复计账）；compaction 的用量单独一个 span，不混进 step。
- **usage 字段映射**：input→`gen_ai.usage.input_tokens`，output→`gen_ai.usage.output_tokens`，cacheRead→`gen_ai.token_count.cache_read`（输入侧），reasoning（属于 output 的一部分）→`gen_ai.usage.output_tokens.reasoning_tokens`。非负整数校验，认不出的原样进 `asu.*`。
- **已知坑照单全收**：`surfaceOp` 的 `start/end` 与 `startSeq/endSeq` 两种写法都认；v3 的 `isError` 藏在 `content[0]` 和 `data.error` 两处都查；`new-api` 与 `newapi` 是两个不同的 provider 名，不归一。
- **镜像目录**：解析器不主动扫两个镜像目录；调用方传进来的输入里出现重复 session id 时才去重（按 `(session_id, seq)`）。

## 6. Claude Code 解析口径

- **入口**：按文件传（`projects/<项目目录>/*.jsonl`）；自动跳过 `.orphaned-*` / `.superseded-*` 重写副本。
- **聚合**：2.1.3xx 一条 assistant 记录只装一个 content block，多条共享 `message.id`——按 `message.id` 聚合成一个 step span，usage 只从带 usage 字段的那条取，避免 token 和轮次被放大 2–5 倍。
- **turn 切分**：文件里没有现成的 turn 事件，以用户消息记录为界：一条 user 记录开始一个 turn，直到下一条 user 记录。
- **无 version 记录**：不猜版本，原样保留进 `asu.*`，版本字段留空。
- **compact**：`compact_boundary` 的 `parentUuid=null` 是重接不是删除，真实前驱在 `logicalParentUuid`——在 turn 层打标记，链不断。
- **tool 配对**：`tool_use.id ↔ tool_result.tool_use_id` 配对；孤儿和重复结果合法，标 `asu.pending_or_interrupted`。

## 7. CLI

单命令：

```
parse <文件或目录路径...> [--out <目录>]（默认 data/unified/）
```

- 纯手动传路径，不做自动发现、不主动扫盘。路径可以是三类：会话文件（`.zstd` 按 DSH、`.jsonl` 按 CC）、目录、归档。
- **目录递归展开**：子目录同规则，按字典序；不跟符号链接；DSH 在同一目录只读最高 `vN`，CC 每个文件各自成树。目录里一个会话文件和归档都没有 → 输入错误。
- **归档**：`.tar.zst` / `.tar.zstd` / `.tar.gz` / `.tgz` / `.tar`。先解到系统临时目录，再只把 `.jsonl` 当 CC 会话文件收进来；解析结束（成功或失败）都删临时目录。归档里的 DSH `.zstd` 不解析，按非会话条目计数；内层归档不展开（第 2 节）。
- **去重**：同一文件 / 归档 / 目录重复传（包括「目录 + 目录里的文件」「归档 + 目录里的同一归档」）按真实路径（realpath）认作同一份，只解析一次、保留第一次的写法；摘要里报「重复输入已跳过 N 项」。
- **逻辑路径**（第 10 节）：直接传的会话文件，输出里就是参数原样；传目录时是「目录参数 + 目录内相对路径」拼出来的路径。两种都不 resolve 成绝对路径——相对就相对、绝对就绝对。归档成员是 `<归档参数>!/<归档内相对路径>`（`/` 分隔）。临时目录名不进任何输出。
- **归档失败**：按输入错误处理，报中文原因（路径穿越、校验和不符、缺结束块、超限、坏帧……），这个归档不写任何输出；其他输入照常解析。
- **退出码三态**：0 = 至少一个会话成功写盘；1 = 有会话但全部解析/写盘失败（仍写只带统计的错误树）；2 = 输入/参数错误，或整批没有可解析的会话（含只有坏归档的情况）。
- 解析完终端打印摘要（每个会话的 step 数、工具数、跳过与丢弃计数；归档对账与重复输入行见第 11 节）。

## 8. 脱敏

- **时机**：边解析边脱敏，落盘文件里只有占位符，原文不落盘。
- **V1 规则**（最小集）：
  1. 凭据前缀：`sk-` / `AKIA` / `ghp_` / `xox` / `JWT` / `Bearer` 开头的字符串；
  2. 配置里的 `apiKey` / `token` / `password` / `secret` 字段的值。
- 命中即替换成带 hash 前缀的占位符（hash 用确定性算法，同一原文得到同一占位符，可对账）。
- **待办清单**（遇到真实案例再补规则，补一条记一条）：连接串里的账号口令、URL 里的 token、Authorization 头的完整解析。
- **已知风险**：V1 规则没覆盖的凭据会落进输出文件。输出文件按「原始日志同级」的敏感级别管理，只放本地 `data/`，不入库。

## 9. 测试与断言

- 真实样本手工拷副本进 `data/`（已在 .gitignore），断言只对副本跑。
- 三件套断言，跑在真实样本上：
  1. **条数守恒**：输入事件数 = 输出 span 数 + 跳过数 + 丢弃数，一个都不许凭空消失；归档输入另有条目对账：解出 + 跳过 = 归档内内容条目总数（第 11 节）；
  2. **字段齐全**：输出逐字段对照 schema，每个输入字段都有明确去向；
  3. **两次解析一致**：同一输入解析两次，输出文件 hash 相同；归档输入同样适用，输出里不许出现解包临时目录名（第 10 节）。
- 归档的条目口径：`entries` 只数**内容条目**（普通文件、目录、链接、设备等），PAX/GNU 的 `x/g/L/K` 结构扩展头不算（它们另按头块数卡上限）；目录条目与链接只进「跳过」。解包失败时按已读到的部分给统计，同样满足上面的等式。

## 10. 确定性与时间

- **字节级确定**：span/trace id 从会话 id + 序号确定性派生；占位符 hash 稳定；不引入当前时间、随机 id。两次跑出字节相同的文件。
- **确定性口径**：同一台机器、同一组参数、同一份输入内容，跑两次输出逐字节相同（文件名集合、文件内容、键序、id 全同）。不承诺跨机器/跨平台一致，也不承诺参数写法不同（相对 vs 绝对、`a/../b` 之类）或输入内容不同还一致。
- **物理路径与逻辑路径分开**：归档先解到随机命名的临时目录，物理路径只用来读盘与去重；写进输出的一律是逻辑路径（归档成员为 `<归档参数>!/<成员相对路径>`，`/` 分隔）。根 span 的 `asu.sessionFile`、`agentLabel` 的 hash 种子、错误树里的文件路径，全都用逻辑路径 —— 解析器不许把物理/临时路径写进输出。
- **时间基准**：span 起止用事件自带时间戳；缺起点用下一个事件时间回填；都不行用未知值并计数。

## 11. 解析统计

跳过行数、丢弃的 v3 帧数、未识别事件类型清单，全部写进根 span 的 `asu.stats.*` 属性，终端同时打印摘要。断言直接读输出文件就能对账，不依赖第二个文件。

每个归档在会话摘要之前先打一行对账：

- 成功：`[归档] <逻辑路径>：解出 N 个 .jsonl，跳过 M 个非会话条目（共 K 条）`，其中 N + M = K（第 9 节的条目口径）；
- 失败：`[归档] <逻辑路径>：解包失败，已解出 N 个 .jsonl，跳过 M 个条目（已读 K 条）`，已读到的残缺条目也计入跳过，同样满足 N + M = K。

重复输入去重真的发生时，另打一行 `重复输入已跳过 N 项`；最后一行是 `完成：N 个会话、写入 M 个文件`。归档条目数只进终端，不进 `asu.stats.*`：同一个归档里可能有好几个会话，挂到每个会话根 span 上会重复计数。

## 12. 后续路线（不在 V1）

1. **B 线**：A 线三件套断言在真实样本上全绿后开工；回放规则、增量 + messages_hash、捕获请求文件格式到时候再定（调研第 7、8 节已有方向）。
2. **CC 2.1.88**：真实样本到手后补版本分支，与 2.1.3xx 共用同一套 span 映射（差异点见调研 3.1 表）。
3. **Codex**：无真实样本，不排期。
4. **脱敏补规则**：按待办清单逐条补。
5. **发送 Langfuse**：独立的 send 步骤，V1 之后加。

## 附：业界依据

- 内容放属性：[OTel GenAI 现行规范](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/client-inference.md)（`gen_ai.input/output.messages`）；老版 v1.28 曾要求走事件。
- Langfuse 属性与事件都映射成界面 Input/Output（事件需 ≥3.66）：[Langfuse OTel 集成](https://langfuse.com/integrations/native/opentelemetry)、[事件映射 PR](https://github.com/langfuse/langfuse/pull/7135)。
- 大块内容业界无统一截断惯例，Langfuse 收到超大 span 只记日志不截断。
