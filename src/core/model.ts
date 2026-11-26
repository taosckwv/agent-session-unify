/**
 * 会话树类型（DESIGN §4.1）：两个解析器（src/dsh、src/cc）与组装层
 * （core/spanBuilder）之间的统一中间格式。解析器不产 span，产这棵树；
 * 公共规则（四层树、字段三去向、id 派生、时间回填）只在 core 写一份。
 *
 * 字段纪律（DESIGN §3.3 / AGENTS.md）：
 * - 原始字段三选一：语义约定的强类型槽（如 Usage）、extras（无处去的字段，
 *   组装时统一进 asu.*）、计数（Stats）。禁止静默丢弃；缺失值不填 0。
 * - extras 的键不带 asu. 前缀：前缀由组装层统一添加。
 * - 时间一律 UnixNano（bigint）：纳秒数值超 2^53，Number 运算会丢精度
 *   （t1 架构裁决 R12/R13）。
 */

/** 工具名（DESIGN §3.5 resource 属性；V1 只有两家）。 */
export type ToolName = 'dsh' | 'claude-code';

/** span 树四层（DESIGN §3.2），每层对应一种节点。 */
export type FrameKind = 'session' | 'turn' | 'step' | 'tool';

/**
 * Unix 纳秒时间戳。恒为 bigint：毫秒×1e6 ≈ 1.79e18 > 2^53（R13），
 * 组装层序列化成 OTLP 的 startTimeUnixNano/endTimeUnixNano 字符串。
 */
export type UnixNano = bigint;

/**
 * 来源序号：该节点由输入里哪几条事件/记录构成（DESIGN §4.1）。
 * 条数守恒断言靠它对账（tests/helpers.ts）；file 为调用方传入的路径原样。
 */
export interface SourceRef {
  file: string;
  /** jsonl 行号（1 起）。CC 记录用行号；DSH 事件用 seq。 */
  line?: number;
  /** DSH 事件 seq。 */
  seq?: number;
  /** 事件/记录的 type 字段原样（对账时核对记录类型）。 */
  recordType: string;
}

/**
 * usage 统一口径（t1 裁决 R1；DSH §5 与 CC 实测字段名对齐）。
 *
 * - 全部非负整数；缺失 = 没有该数据，不填 0（AGENTS 禁零填充）；
 *   实测 0 是合法值，保留（R15：CC api-error 场景有 input_tokens:0）。
 * - 组装层映射：inputTokens→gen_ai.usage.input_tokens；
 *   outputTokens→gen_ai.usage.output_tokens；
 *   reasoningTokens→gen_ai.usage.output_tokens.reasoning_tokens（⊆ output，不减）；
 *   cacheReadTokens→gen_ai.token_count.cache_read（输入侧）；
 *   cacheWriteTokens→asu.usage.cache_write（CC cache_creation_input_tokens，
 *   官方约定未定义，按 DESIGN §3.3 走 asu.*）。
 * - 非负整数校验失败的原始值不进这里，原样留在 extras。
 */
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * 解析统计（DESIGN §11）：全部写进根 span 的 asu.stats.*（R18），
 * 终端摘要同时打印。除 unknownEventTypes 外全为数值计数，缺失不猜。
 */
export interface Stats {
  /** 输入记录数。R7 口径：DSH = 解码成功帧拼出的 jsonl 行数（坏帧单计 failedFrames）；CC = 文件行数（跳过的 orphaned/superseded 文件整文件行数计进 skippedRecords）。 */
  inputRecords: number;
  /** 产出 span 数 = 四层节点总数（R7）。 */
  producedSpans: number;
  /** 跳过/丢弃的记录数：v3 帧对应行、orphaned/superseded 文件行等。 */
  skippedRecords: number;
  /** 坏行数（JSON 解析失败）。 */
  badLines: number;
  /** 整文件跳过的 v3 会话数（R5：每文件计 1，其行数计进 skippedRecords）。 */
  skippedV3: number;
  /** zstd 帧总数（仅 DSH）。 */
  frames: number;
  /** 解压失败/超限被跳过的帧数（仅 DSH）。 */
  failedFrames: number;
  /** 镜像重复去重数，按 (sessionId, seq)（R17：只在调用方传入重复 session 时触发）。 */
  deduped: number;
  /** 未识别事件/记录类型 → 出现次数。整条原文进 extras，不丢弃。 */
  unknownEventTypes: Record<string, number>;
  /** 时间无法确定的次数（自带时间与下一事件回填都不可用，DESIGN §10）。 */
  unknownTimes: number;
  /** 未配对工具数（orphan_call / orphan_result / duplicate）。 */
  unpairedTools: number;
  /** 同 message.id 各记录 usage 不一致的审计计数（R2）。 */
  duplicateUsage: number;
  /**
   * CC 每消息携带的 usage 快照总条数（t9/R2）：同 message.id 多条记录各带
   * 一份相同 usage，其中一条为权威条（进 step.usage），全部快照原文留在
   * step.extras.usageSnapshots；此计数 = 快照条数（含权威条），供对账
   * 「聚合没有吞掉观测」。DSH 恒 0。实测 0 合法（R15）。
   */
  usageSnapshots: number;
  /** 单文件级解析异常数（R8：不中断整批，计数后跳过整个文件）。 */
  parseErrors: number;
}

/** 轮节点：一轮对话（用户消息开始，到下一条用户消息为止，DESIGN §6）。 */
export interface TurnNode {
  sourceRefs: SourceRef[];
  extras: Record<string, unknown>;
  startTimeUnixNano?: UnixNano;
  endTimeUnixNano?: UnixNano;
  /** compact 边界标记（R9：compact_boundary 重接，链不断）；compact 元数据全量放 extras。 */
  compact?: boolean;
  /** 轮结束原因（事件自带原文，如 stop / 用户中断）。 */
  endReason?: string;
  steps: StepNode[];
}

/** 步节点：一次模型往返（DESIGN §4.1：模型名、usage、输入输出消息、请求上下文）。 */
export interface StepNode {
  sourceRefs: SourceRef[];
  extras: Record<string, unknown>;
  startTimeUnixNano?: UnixNano;
  endTimeUnixNano?: UnixNano;
  /** 模型名（→ gen_ai.request.model / gen_ai.response.model）。 */
  model?: string;
  usage?: Usage;
  /** 输入侧消息原文（用户/系统消息 → gen_ai.input.messages，不截断）。 */
  inputMessages?: unknown[];
  /** 输出侧消息原文（assistant 回复 → gen_ai.output.messages，不截断）。 */
  outputMessages?: unknown[];
  /** 请求上下文（provider/窗口/工具清单路由等）无官方约定，放 extras 走 asu.*。 */
  tools: ToolNode[];
}

/** 工具配对状态（DESIGN §6：孤儿与重复结果合法；组装层标 asu.pending_or_interrupted）。 */
export type ToolPairing = 'paired' | 'orphan_call' | 'orphan_result' | 'duplicate';

/** 工具节点：一次工具调用（参数与结果原文，不截断，DESIGN §3.4）。 */
export interface ToolNode {
  sourceRefs: SourceRef[];
  extras: Record<string, unknown>;
  startTimeUnixNano?: UnixNano;
  endTimeUnixNano?: UnixNano;
  /** 工具名。 */
  toolName: string;
  /** 工具调用 id（CC tool_use.id；DSH 无则缺省）→ gen_ai.tool.call.id。 */
  toolCallId?: string;
  /** 参数原文。 */
  argsText?: string;
  /** 结果原文。 */
  resultText?: string;
  /** 出错标记（DSH v3 的 isError 两处都查，见 DESIGN §5）。 */
  isError?: boolean;
  pairing: ToolPairing;
}

/** 会话节点（根）：身份 + 运行信息 + 解析统计（DESIGN §4.1）。 */
export interface SessionNode {
  sourceRefs: SourceRef[];
  extras: Record<string, unknown>;
  tool: ToolName;
  /** 会话格式版本（DSH header.version）。CC 无 version 记录时缺省，不猜（DESIGN §6）。 */
  formatVersion?: number;
  /** 会话 id。缺失时用文件名去扩展名顶替并标 asu.session_id_source（R6）。 */
  sessionId: string;
  /**
   * agent 标识（R4）：DSH 用 origin ?? 'main'；CC 用 isSidechain ? 'sidechain' : 'main'。
   * 同 session_id 不同 agent 各自成文件、共用同一 trace。
   */
  agentLabel: string;
  cwd?: string;
  agentPreset?: string;
  parentSession?: string;
  delegationDepth?: number;
  isSeeded?: boolean;
  origin?: string;
  /** 会话创建时间：epoch 毫秒（13 位，Number 安全）。 */
  createdAtMs?: number;
  turns: TurnNode[];
  stats: Stats;
}

type NodeFieldKey = keyof SessionNode | keyof TurnNode | keyof StepNode | keyof ToolNode;

/**
 * 四类节点的全部可序列化字段清单（运行时镜像）。加字段必须同步扩展此清单：
 * tests/helpers.ts 的「字段齐全」断言据此发现漂移到契约之外的字段
 * （契约外字段应进 extras，不允许绕过三去向纪律）。
 */
export const SESSION_NODE_FIELD_KEYS = [
  'sourceRefs',
  'extras',
  'tool',
  'formatVersion',
  'sessionId',
  'agentLabel',
  'cwd',
  'agentPreset',
  'parentSession',
  'delegationDepth',
  'isSeeded',
  'origin',
  'createdAtMs',
  'turns',
  'stats',
  'startTimeUnixNano',
  'endTimeUnixNano',
  'compact',
  'endReason',
  'steps',
  'model',
  'usage',
  'inputMessages',
  'outputMessages',
  'tools',
  'toolName',
  'toolCallId',
  'argsText',
  'resultText',
  'isError',
  'pairing',
] as const satisfies readonly NodeFieldKey[];

/** 全零空统计（解析器起点；数值计数缺失不猜，从 0 起累加）。 */
export function emptyStats(): Stats {
  return {
    inputRecords: 0,
    producedSpans: 0,
    skippedRecords: 0,
    badLines: 0,
    skippedV3: 0,
    frames: 0,
    failedFrames: 0,
    deduped: 0,
    unknownEventTypes: {},
    unknownTimes: 0,
    unpairedTools: 0,
    duplicateUsage: 0,
    usageSnapshots: 0,
    parseErrors: 0,
  };
}

/** 合并两份统计（多文件/多来源汇总）：数值相加，unknownEventTypes 合并计数。纯函数。 */
export function mergeStats(a: Stats, b: Stats): Stats {
  const unknownEventTypes: Record<string, number> = { ...a.unknownEventTypes };
  for (const [type, count] of Object.entries(b.unknownEventTypes)) {
    unknownEventTypes[type] = (unknownEventTypes[type] ?? 0) + count;
  }
  return {
    inputRecords: a.inputRecords + b.inputRecords,
    producedSpans: a.producedSpans + b.producedSpans,
    skippedRecords: a.skippedRecords + b.skippedRecords,
    badLines: a.badLines + b.badLines,
    skippedV3: a.skippedV3 + b.skippedV3,
    frames: a.frames + b.frames,
    failedFrames: a.failedFrames + b.failedFrames,
    deduped: a.deduped + b.deduped,
    unknownEventTypes,
    unknownTimes: a.unknownTimes + b.unknownTimes,
    unpairedTools: a.unpairedTools + b.unpairedTools,
    duplicateUsage: a.duplicateUsage + b.duplicateUsage,
    usageSnapshots: a.usageSnapshots + b.usageSnapshots,
    parseErrors: a.parseErrors + b.parseErrors,
  };
}

/** 毫秒 → 纳秒。必须 BigInt 乘法，Number 乘法在 1.79e12×1e6≈1.79e18 处丢精度（R13）。非有限值抛错。 */
export function msToUnixNano(ms: number): UnixNano {
  if (!Number.isFinite(ms)) {
    throw new RangeError(`非有限的毫秒时间戳：${ms}`);
  }
  return BigInt(ms) * 1_000_000n;
}

/**
 * ISO 8601 字符串 → 纳秒（CC timestamp 是 ISO 串，R12）。
 * 解析失败返回 undefined（缺失不猜，由调用方计入 stats.unknownTimes）。
 * 仅依赖 ES 规范对 ISO 格式的确定性解析，不引入第三方库。
 */
export function isoToUnixNano(iso: string): UnixNano | undefined {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return undefined;
  return msToUnixNano(ms);
}
