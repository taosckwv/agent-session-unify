/**
 * 组装层：会话树（SessionNode）→ OTLP TracesData（DESIGN §3、§4.3、§4.4、§8-§11、
 * t1 契约 §2 core/spanBuilder.ts、裁决 R4/R9/R10/R13/R14/R18、t1 §7 硬约束）。
 *
 * 三件唯一职责：
 * 1. **脱敏唯一入口**（DESIGN §4.4）：本模块是全仓库唯一 import redact 的地方
 *    （tests 以源码断言钉住边界）。所有字符串属性写盘前统一过
 *    redactString/redactObject；dsh/cc 解析器与 otlp 序列化器都不碰。
 * 2. **字段三去向**（DESIGN §3.3）：有 GenAI 语义约定的字段 → gen_ai.*；
 *    无约定的自定义字段 → asu.*（解析器 extras 原样加前缀映射，键名不改）；
 *    统计 → asu.stats.*（R18：全部字符串标量，不上对象）。
 * 3. **时间回填**（DESIGN §10）：缺起点先看自身终点，再按文档序取下一已知事件
 *    时间回填，都不行用 0 并计数（解析器 unknownTimes + 组装增量）；终点缺失
 *    取自身起点与子树已知最大值，永不产出 end < start。
 *
 * 确定性（DESIGN §10）：trace_id = deriveTraceId(sessionId)（同会话同 trace）；
 * span_id = deriveSpanId(`${sessionId}__${agentLabel}`, 树路径)（t1 §7 硬约束：
 * 不能只用 sessionId，否则 CC sidechain 同 session 多 agent 撞 span id）；
 * 属性键按码点序排列；不读时钟/随机/locale。纯函数：不修改输入树。
 *
 * compaction 用量（DESIGN §5、t3 交接）：t3 把 compaction/* 事件整条原文留在
 * extras.events 里；本层把带 usage 的 compaction 事件提成专用子 span
 * （asu.compaction=true + R1 usage 属性），绝不并入 step.usage；原文仍留在父节点
 * asu.events 里（一个字不丢）。compaction 事件时间只用于其自身 span 与会话根
 * 终点最大值，不作为其他 span 的回填源（回填源 = 树节点自带时间，§10 口径）。
 *
 * span 计数口径：asu.stats.produced_spans = 输出文件实际 span 总数
 * （四层节点数 + compaction span 数），以组装层产出为准；与解析器树
 * producedSpans（四层节点数）的差额 = asu.stats.compaction_spans，输出文件内
 * 自洽可对账。
 *
 * 已知取舍（均注释在事发处）：跨文件父引用假定父 agentLabel='main'；
 * 跨 trace（DSH 子会话）省略 parentSpanId，仅以 asu.parent_session.* 属性对账
 * （t12 修补：OTLP 要求 parentSpanId 同 trace，跨 trace 写入是悬空引用）。
 */

import {
  deriveParentSpanRef,
  deriveSpanId,
  deriveTraceId,
  sessionKey,
  sessionSpanPath,
  stepSpanPath,
  toolSpanPath,
  turnSpanPath,
} from './ids.js';
import { msToUnixNano } from './model.js';
import type {
  SessionNode,
  StepNode,
  ToolNode,
  TurnNode,
  UnixNano,
  Usage,
} from './model.js';
import { SCOPE_NAME } from './otlp.js';
import type { AttributeValue, KeyValue, Span, TracesData } from './otlp.js';
import { redactObject, redactString } from './redact.js';

// ---------------------------------------------------------------------------
// 常量（t1 检查单：命名常量 + 出处）
// ---------------------------------------------------------------------------

/** 时间完全无法确定时的未知值（DESIGN §10：0 并计数，不抛错）。 */
const UNKNOWN_TIME_NANO: UnixNano = 0n;

/** 跨文件父引用对父 agentLabel 的缺省假定（R4 主路径：父会话默认 main）。 */
const DEFAULT_PARENT_AGENT_LABEL = 'main';

/** compaction 子 span 的 span 名（kind 仍 INTERNAL，语义靠 asu.compaction）。 */
const COMPACTION_SPAN_NAME = 'compaction';

/** DSH extras.events 流水里 compaction 事件 type 的识别前缀。 */
const COMPACTION_TYPE_PREFIX = 'compaction/';

/** 工具事件缺工具名时的标记（与 dsh/parse.ts 的 UNKNOWN_TOOL_NAME 同口径）。 */
const UNKNOWN_EVENT_TYPE = '(unknown)';

/** stats 键前缀（R18）。 */
const STATS_PREFIX = 'asu.stats.';

/** 组装层自计的 compaction span 统计键（Stats 契约外，组装层口径）。 */
const COMPACTION_SPANS_KEY = 'asu.stats.compaction_spans';

/** 未识别事件统计的拆键前缀（R18：<type> 原样保留，含 `/`）。 */
const UNKNOWN_EVENT_TYPES_PREFIX = 'asu.stats.unknown_event_types.';

/** compaction span 标记属性键。 */
const COMPACTION_FLAG_KEY = 'asu.compaction';

/** 未配对/中断标记（DESIGN §6：pairing != 'paired' 时置 true）。 */
const PENDING_OR_INTERRUPTED_KEY = 'asu.pending_or_interrupted';

/** 每个四层 span 的来源引用计数（R7 守恒可在输出文件侧对账）。 */
const SOURCE_REF_COUNT_KEY = 'asu.source_ref_count';

/** 全部 span 的 kind（会话重放无网络边界语义，INTERNAL 是唯一诚实选项）。 */
const SPAN_KIND = 'SPAN_KIND_INTERNAL';

/** usage 键 → 属性键（R1，与 model.ts Usage 注释逐字对齐）。 */
const USAGE_ATTRIBUTE_MAP: Readonly<Record<keyof Usage, string>> = {
  inputTokens: 'gen_ai.usage.input_tokens',
  outputTokens: 'gen_ai.usage.output_tokens',
  reasoningTokens: 'gen_ai.usage.output_tokens.reasoning_tokens',
  cacheReadTokens: 'gen_ai.token_count.cache_read',
  cacheWriteTokens: 'asu.usage.cache_write',
};

/** totalTokens 的属性键（R11：原样，不重算）。 */
const TOTAL_TOKENS_KEY = 'asu.usage.total_tokens';

// ---------------------------------------------------------------------------
// 属性构造（脱敏唯一入口在此）
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false;
  const proto = Object.getPrototypeOf(v) as object | null;
  return proto === Object.prototype || proto === null;
}

/** 非字符串、非 JSON 形态的确定性字符串化（Date 用 ISO，禁本地时区）。 */
function stringifyUnknown(value: object): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * 未知类型值 → OTLP AttributeValue。字符串一律过 redactString（§4.4 唯一入口）；
 * 数组/普通对象先 redactObject 再 JSON 序列化（R14：非字符串叶原样保留；
 * 大值不截断，t1 §5.3 已知取舍）；null/undefined → 空串（OTLP 无 null 形态，
 * 键仍可见，明确「有值但为空」不是缺失）。循环引用兜底 String()（解析器产
 * 自 JSON 不会出现，防御性保留）。
 */
function toAttributeValue(value: unknown): AttributeValue {
  if (typeof value === 'string') return { stringValue: redactString(value) };
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value)) return { intValue: value };
    if (Number.isFinite(value)) return { doubleValue: value };
    return { stringValue: redactString(String(value)) };
  }
  if (value === null || value === undefined) return { stringValue: '' };
  if (Array.isArray(value) || isPlainObject(value)) {
    let text: string;
    try {
      text = JSON.stringify(redactObject(value));
    } catch {
      text = stringifyUnknown(value);
    }
    return { stringValue: redactString(text) };
  }
  // Map/Set/Date/函数等非 JSON 形态：确定性字符串形态
  return { stringValue: redactString(stringifyUnknown(value)) };
}

/** 键值对构造（值先过唯一脱敏入口）。 */
function kv(key: string, value: unknown): KeyValue {
  return { key, value: toAttributeValue(value) };
}

/** stats 专用：字符串标量（R18 裁决字面：asu.stats.* 全部字符串属性）。 */
function kvStat(key: string, value: number | string): KeyValue {
  return { key, value: { stringValue: redactString(String(value)) } };
}

/** 解析器 extras → asu.<原键>（model.ts 契约：extras 键不带前缀，此处统一加；
 * 键名不改，camel/snake 混用并存；extras 键若自带 asu. 会得双前缀——可见不丢）。 */
function appendExtras(attrs: KeyValue[], extras: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(extras)) {
    attrs.push(kv(`asu.${key}`, value));
  }
}

/** 属性键排序（码点序，禁 localeCompare——locale 数据非确定）。 */
function sortAttributes(attrs: KeyValue[]): void {
  attrs.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** 码点序比较（unknown_event_types 拆键排序用）。 */
function cmpStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** camelCase → snake_case（stats 键形态）。 */
function snakeCase(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

// ---------------------------------------------------------------------------
// 时间索引与回填（DESIGN §10）
// ---------------------------------------------------------------------------

/** 一个 span 在文档序时间表上的区间 [startIdx, endIdx]（闭区间）。 */
interface SpanRange {
  startIdx: number;
  endIdx: number;
}

/** 文档序时间表 + 各层 span 的槽位区间（indexTimes 一次遍历产出）。 */
interface TimeIndex {
  /** 文档序全部已知/未知时间槽：[会话创建] 逐 turn [turn.start, 逐 step [step.start, 逐 tool [tool.start, tool.end], step.end], turn.end]。 */
  times: Array<UnixNano | undefined>;
  turnRanges: SpanRange[];
  /** stepRanges[turn][step]。 */
  stepRanges: SpanRange[][];
  /** toolStartIdx[turn][step][tool]；tool 的 endIdx = startIdx + 1。 */
  toolStartIdx: number[][][];
}

function indexTimes(tree: SessionNode): TimeIndex {
  const times: Array<UnixNano | undefined> = [];
  const turnRanges: SpanRange[] = [];
  const stepRanges: SpanRange[][] = [];
  const toolStartIdx: number[][][] = [];

  times.push(
    tree.createdAtMs !== undefined ? msToUnixNano(tree.createdAtMs) : undefined,
  );
  for (const turn of tree.turns) {
    const turnStartIdx = times.length;
    times.push(turn.startTimeUnixNano);
    const stepRangesOfTurn: SpanRange[] = [];
    const toolStartsOfTurn: number[][] = [];
    for (const step of turn.steps) {
      const stepStartIdx = times.length;
      times.push(step.startTimeUnixNano);
      const toolStarts: number[] = [];
      for (const tool of step.tools) {
        toolStarts.push(times.length);
        times.push(tool.startTimeUnixNano, tool.endTimeUnixNano);
      }
      times.push(step.endTimeUnixNano);
      stepRangesOfTurn.push({ startIdx: stepStartIdx, endIdx: times.length - 1 });
      toolStartsOfTurn.push(toolStarts);
    }
    times.push(turn.endTimeUnixNano);
    turnRanges.push({ startIdx: turnStartIdx, endIdx: times.length - 1 });
    stepRanges.push(stepRangesOfTurn);
    toolStartIdx.push(toolStartsOfTurn);
  }
  return { times, turnRanges, stepRanges, toolStartIdx };
}

/** [from, to]（闭区间）内已知时间的最大值；无已知值返回 undefined。 */
function maxInRange(
  times: Array<UnixNano | undefined>,
  from: number,
  to: number,
): UnixNano | undefined {
  let max: UnixNano | undefined;
  for (let i = from; i <= to && i < times.length; i += 1) {
    const v = times[i];
    if (v !== undefined && (max === undefined || v > max)) max = v;
  }
  return max;
}

/**
 * 起点：自身 start → 自身 end（最近的「下一事件」，零时长落点）→ 文档序前向
 * 首个已知槽（§10 字面）→ 未知值 0 并计数。
 */
function resolveStart(
  times: Array<UnixNano | undefined>,
  range: SpanRange,
  counter: { count: number },
): UnixNano {
  const ownStart = times[range.startIdx];
  if (ownStart !== undefined) return ownStart;
  const ownEnd = times[range.endIdx];
  if (ownEnd !== undefined) return ownEnd;
  for (let i = range.startIdx + 1; i < times.length; i += 1) {
    const v = times[i];
    if (v !== undefined) return v;
  }
  counter.count += 1;
  return UNKNOWN_TIME_NANO;
}

/**
 * 终点：自身 end（早于已解析起点时夹到起点——数据异常原文在 extras 可查，
 * 不产出 end < start 的非法 span）→ max(起点, 自身区间已知最大值) → 起点
 * （零时长）。计数只在起点真正未知时发生（resolveStart），终点不重复计数。
 */
function resolveEnd(
  times: Array<UnixNano | undefined>,
  range: SpanRange,
  start: UnixNano,
): UnixNano {
  const own = times[range.endIdx];
  if (own !== undefined) return own < start ? start : own;
  const rangeMax = maxInRange(times, range.startIdx, range.endIdx);
  if (rangeMax !== undefined && rangeMax > start) return rangeMax;
  return start;
}

// ---------------------------------------------------------------------------
// compaction 事件 → 专用子 span（DESIGN §5、t3 交接）
// ---------------------------------------------------------------------------

/**
 * 从节点 extras.events 里找 compaction 事件（type 以 compaction/ 开头且带
 * usage）。DSH compaction 用量原文在 entry.data.usage（t3 交接），兼容 entry.usage。
 * 保持 extras.events 数组内的原顺序（文档序）。
 */
function compactionEventsFromExtras(
  extras: Record<string, unknown>,
): Array<{ entry: Record<string, unknown>; usage: unknown }> {
  const events = extras['events'];
  if (!Array.isArray(events)) return [];
  const out: Array<{ entry: Record<string, unknown>; usage: unknown }> = [];
  for (const raw of events) {
    if (!isPlainObject(raw)) continue;
    const type = raw['type'];
    if (typeof type !== 'string' || !type.startsWith(COMPACTION_TYPE_PREFIX)) continue;
    const data = isPlainObject(raw['data']) ? raw['data'] : undefined;
    const usage =
      data !== undefined && data['usage'] !== undefined ? data['usage'] : raw['usage'];
    if (usage === undefined) continue;
    out.push({ entry: raw, usage });
  }
  return out;
}

/** compaction 子 span 的树内路径（与四层路径互不碰撞：无 step/tool 段）。 */
function compactionSpanPath(parentPath: string, ordinal: number): string {
  return `${parentPath}/compaction/${ordinal}`;
}

/** 事件自带 time → 纳秒（epoch 毫秒数字，与 dsh/parse.ts 同口径）。 */
function eventTimeToNano(entry: Record<string, unknown>): UnixNano | undefined {
  const raw = entry['time'];
  if (typeof raw === 'number' && Number.isFinite(raw)) return msToUnixNano(raw);
  if (typeof raw === 'string' && /^-?\d+$/.test(raw)) {
    return BigInt(raw) * 1_000_000n;
  }
  return undefined;
}

/**
 * usage（对象）→ 属性（R1 同口径；totalTokens 原样 R11；未知键 asu.usage.<原键>，
 * R14 非数字叶原样）。非对象形态 → asu.compaction.usage 原样（不静默丢）。
 * 缺失键不补 0，实测 0 保留（R15）。
 */
function usageToAttributes(usage: unknown, attrs: KeyValue[]): void {
  if (!isPlainObject(usage)) {
    attrs.push(kv('asu.compaction.usage', usage));
    return;
  }
  for (const [key, value] of Object.entries(usage)) {
    if (value === undefined) continue;
    const mapped = USAGE_ATTRIBUTE_MAP[key as keyof Usage];
    if (mapped !== undefined) {
      attrs.push(kv(mapped, value));
    } else if (key === 'totalTokens') {
      attrs.push(kv(TOTAL_TOKENS_KEY, value));
    } else {
      attrs.push(kv(`asu.usage.${key}`, value));
    }
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/** 构建期共享状态（全部派生自输入树，无环境读取）。 */
interface BuildContext {
  tree: SessionNode;
  key: string;
  traceId: string;
  spans: Span[];
  index: TimeIndex;
  /** 组装层回填新增的未知时间计数。 */
  unknownTimes: { count: number };
  /** compaction span 数与其中最大事件时间（会话根终点用）。 */
  compaction: { count: number; maxNano: UnixNano | undefined };
}

/**
 * 会话树 → OTLP TracesData（一个 agent 会话 = 一个输出文件的完整内容）。
 * 结构：单 resourceSpans（resource = 谁产生数据，§3.5）→ 单 scopeSpans →
 * span 树（session 根 → turn → step → tool，外加 compaction 子 span）。
 *
 * 纯函数：不修改 tree、不读时钟/随机/locale；两次调用产出完全相同的结果
 * （字节级一致性由 serializeTracesData 的固定键序与本函数的属性排序共同保证）。
 */
export function buildSpans(tree: SessionNode): TracesData {
  const key = sessionKey(tree.sessionId, tree.agentLabel);
  const traceId = deriveTraceId(tree.sessionId);
  const ctx: BuildContext = {
    tree,
    key,
    traceId,
    spans: [],
    index: indexTimes(tree),
    unknownTimes: { count: 0 },
    compaction: { count: 0, maxNano: undefined },
  };

  const sessionSpan = buildSessionSpan(ctx);
  ctx.spans.push(sessionSpan);
  for (const [turnOrdinal, turn] of tree.turns.entries()) {
    buildTurnSpan(ctx, turn, turnOrdinal, sessionSpan);
  }
  // 会话级 compaction 事件（t3 把无 turn 归属的事件挂树根 extras.events）
  buildCompactionSpans(ctx, tree.extras, sessionSpanPath(), sessionSpan);
  finishSessionSpan(ctx, sessionSpan);

  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttributes(tree) },
        scopeSpans: [{ scope: { name: SCOPE_NAME }, spans: ctx.spans }],
      },
    ],
  };
}

/** resource：谁产生了这份数据（DESIGN §3.5）。工具版本无树内来源字段，不猜不填。 */
function resourceAttributes(tree: SessionNode): KeyValue[] {
  const attrs: KeyValue[] = [
    kv('service.name', tree.tool),
    kv('asu.session.id', tree.sessionId),
    kv('asu.session.agent_label', tree.agentLabel),
  ];
  if (tree.formatVersion !== undefined) {
    attrs.push(kv('asu.session.format_version', tree.formatVersion));
  }
  if (tree.cwd !== undefined) attrs.push(kv('asu.session.cwd', tree.cwd));
  if (tree.agentPreset !== undefined) {
    attrs.push(kv('asu.session.agent_preset', tree.agentPreset));
  }
  sortAttributes(attrs);
  return attrs;
}

/** 会话根 span（身份 + 跨文件父引用 + extras；stats 由 finishSessionSpan 追加）。 */
function buildSessionSpan(ctx: BuildContext): Span {
  const { tree, key, traceId } = ctx;
  const start = resolveStart(ctx.index.times, { startIdx: 0, endIdx: 0 }, ctx.unknownTimes);
  const span: Span = {
    traceId,
    spanId: deriveSpanId(key, sessionSpanPath()),
    name: redactString(`session ${tree.sessionId}`),
    kind: SPAN_KIND,
    startTimeUnixNano: start.toString(),
    endTimeUnixNano: start.toString(), // finishSessionSpan 里按全树最大值重算
    attributes: [kv(SOURCE_REF_COUNT_KEY, tree.sourceRefs.length)], // stats 必发，恒非空
  };

  // 跨文件父引用（DESIGN §3.1/§3.5，t12 修补）：树字段优先；CC sidechain 只在
  // extras 里带 parentSession（t4 口径），统一提升成结构化引用。父文件 agentLabel
  // 无来源字段，按 R4 缺省假定 'main'（并在 asu.parent_session.agent_label 里显式
  // 可见）。parentSpanId 仅在父与本 span 同 trace_id（parentSession === 本
  // sessionId，即 CC sidechain 场景）时写入——OTLP 要求 parentSpanId 指向同
  // trace 内的 span；跨 trace（DSH 子会话父 id 不同）时省略 parentSpanId，
  // asu.parent_session.trace_id/span_id/session_id/agent_label 四属性保留，
  // 读文件仍能对上。父文件缺失或非 main 时 parent_span_id 可能悬空，但
  // trace_id 属性始终指向正确 trace（同 session 全部 agent 文件共用 trace_id）。
  const parentSession =
    tree.parentSession ??
    (typeof tree.extras['parentSession'] === 'string' ? tree.extras['parentSession'] : undefined);
  if (parentSession !== undefined) {
    const ref = deriveParentSpanRef(parentSession, DEFAULT_PARENT_AGENT_LABEL);
    if (ref.traceId === traceId) {
      // 同 trace（parentSession === 本 sessionId）：parentSpanId 合法且精确
      span.parentSpanId = ref.spanId;
    }
    span.attributes?.push(
      kv('asu.parent_session.id', parentSession),
      kv('asu.parent_session.trace_id', ref.traceId),
      kv('asu.parent_session.span_id', ref.spanId),
      kv('asu.parent_session.agent_label', DEFAULT_PARENT_AGENT_LABEL),
    );
  }

  if (tree.delegationDepth !== undefined) {
    span.attributes?.push(kv('asu.session.delegation_depth', tree.delegationDepth));
  }
  if (tree.isSeeded !== undefined) {
    span.attributes?.push(kv('asu.session.is_seeded', tree.isSeeded));
  }
  if (tree.origin !== undefined) span.attributes?.push(kv('asu.session.origin', tree.origin));
  appendExtras(span.attributes ?? [], tree.extras);
  return span;
}

/**
 * 会话根 span 收尾：终点 = max(起点, 全树已知时间, compaction 事件最大时间)；
 * 追加 stats（R18 字符串标量，Object.entries 全字段兜底——含 t10 的
 * usageSnapshots 与后续新增字段，防漏）后统一排序。
 */
function finishSessionSpan(ctx: BuildContext, sessionSpan: Span): void {
  const times = ctx.index.times;
  const start = BigInt(sessionSpan.startTimeUnixNano);
  let max = maxInRange(times, 0, times.length - 1);
  const compactionMax = ctx.compaction.maxNano;
  if (compactionMax !== undefined && (max === undefined || compactionMax > max)) {
    max = compactionMax;
  }
  sessionSpan.endTimeUnixNano = (max !== undefined && max > start ? max : start).toString();

  const attrs = sessionSpan.attributes ?? [];
  const stats = ctx.tree.stats;
  attrs.push(kvStat(`${STATS_PREFIX}produced_spans`, ctx.spans.length));
  attrs.push(kvStat(COMPACTION_SPANS_KEY, ctx.compaction.count));
  for (const [key, value] of Object.entries(stats)) {
    if (key === 'producedSpans') continue; // 已用组装层实际产出覆盖
    if (key === 'unknownTimes') {
      // 解析器计数 + 组装回填增量，一份口径一次写盘
      attrs.push(kvStat(`${STATS_PREFIX}unknown_times`, (value as number) + ctx.unknownTimes.count));
      continue;
    }
    if (key === 'unknownEventTypes') {
      const entries = Object.entries(value as Record<string, number>).sort(([a], [b]) =>
        cmpStrings(a, b),
      );
      for (const [type, count] of entries) {
        attrs.push(kvStat(`${UNKNOWN_EVENT_TYPES_PREFIX}${type}`, count));
      }
      continue;
    }
    // 兜底：数值 → String；未来非数值字段 → JSON（不丢，标量上盘）
    const statValue =
      typeof value === 'number' || typeof value === 'string' ? value : JSON.stringify(value);
    attrs.push(kvStat(`${STATS_PREFIX}${snakeCase(key)}`, statValue));
  }
  sortAttributes(attrs);
}

/** 轮 span（+ 其 step、工具、compaction 子 span）。 */
function buildTurnSpan(
  ctx: BuildContext,
  turn: TurnNode,
  turnOrdinal: number,
  parent: Span,
): void {
  const { key, traceId } = ctx;
  const range = ctx.index.turnRanges[turnOrdinal];
  if (range === undefined) {
    throw new RangeError(`组装内部错误：turn 槽位缺失（turn=${turnOrdinal}）`);
  }
  const start = resolveStart(ctx.index.times, range, ctx.unknownTimes);
  const end = resolveEnd(ctx.index.times, range, start);
  const span: Span = {
    traceId,
    spanId: deriveSpanId(key, turnSpanPath(turnOrdinal)),
    parentSpanId: parent.spanId,
    name: redactString(`turn ${turnOrdinal}`),
    kind: SPAN_KIND,
    startTimeUnixNano: start.toString(),
    endTimeUnixNano: end.toString(),
  };

  const attrs: KeyValue[] = [];
  if (turn.compact === true) attrs.push(kv('asu.turn.compact', true));
  if (turn.endReason !== undefined) attrs.push(kv('asu.turn.end_reason', turn.endReason));
  attrs.push(kv(SOURCE_REF_COUNT_KEY, turn.sourceRefs.length));
  appendExtras(attrs, turn.extras);
  sortAttributes(attrs);
  if (attrs.length > 0) span.attributes = attrs;

  ctx.spans.push(span);

  for (const [stepOrdinal, step] of turn.steps.entries()) {
    buildStepSpan(ctx, step, turnOrdinal, stepOrdinal, span);
  }
  buildCompactionSpans(ctx, turn.extras, turnSpanPath(turnOrdinal), span);
}

/** 步 span（+ 其工具、compaction 子 span）。字段三去向的核心层。 */
function buildStepSpan(
  ctx: BuildContext,
  step: StepNode,
  turnOrdinal: number,
  stepOrdinal: number,
  parent: Span,
): void {
  const { key, traceId } = ctx;
  const range = ctx.index.stepRanges[turnOrdinal]?.[stepOrdinal];
  if (range === undefined) {
    throw new RangeError(`组装内部错误：step 槽位缺失（turn=${turnOrdinal} step=${stepOrdinal}）`);
  }
  const start = resolveStart(ctx.index.times, range, ctx.unknownTimes);
  const end = resolveEnd(ctx.index.times, range, start);
  const span: Span = {
    traceId,
    spanId: deriveSpanId(key, stepSpanPath(turnOrdinal, stepOrdinal)),
    parentSpanId: parent.spanId,
    name: redactString(`step ${turnOrdinal}/${stepOrdinal}`),
    kind: SPAN_KIND,
    startTimeUnixNano: start.toString(),
    endTimeUnixNano: end.toString(),
  };

  const attrs: KeyValue[] = [];
  if (step.model !== undefined) {
    attrs.push(kv('gen_ai.request.model', step.model));
    attrs.push(kv('gen_ai.response.model', step.model));
  }
  if (step.usage !== undefined) usageToAttributes(step.usage, attrs);
  if (step.inputMessages !== undefined) {
    attrs.push(kv('gen_ai.input.messages', JSON.stringify(redactObject(step.inputMessages))));
  }
  if (step.outputMessages !== undefined) {
    attrs.push(kv('gen_ai.output.messages', JSON.stringify(redactObject(step.outputMessages))));
  }
  attrs.push(kv(SOURCE_REF_COUNT_KEY, step.sourceRefs.length));
  appendExtras(attrs, step.extras);
  sortAttributes(attrs);
  if (attrs.length > 0) span.attributes = attrs;

  ctx.spans.push(span);

  for (const [toolOrdinal, tool] of step.tools.entries()) {
    buildToolSpan(ctx, tool, turnOrdinal, stepOrdinal, toolOrdinal, span);
  }
  buildCompactionSpans(ctx, step.extras, stepSpanPath(turnOrdinal, stepOrdinal), span);
}

/** 工具 span（+ compaction 子 span）。 */
function buildToolSpan(
  ctx: BuildContext,
  tool: ToolNode,
  turnOrdinal: number,
  stepOrdinal: number,
  toolOrdinal: number,
  parent: Span,
): void {
  const { key, traceId } = ctx;
  const toolStart = ctx.index.toolStartIdx[turnOrdinal]?.[stepOrdinal]?.[toolOrdinal];
  if (toolStart === undefined) {
    throw new RangeError(
      `组装内部错误：tool 槽位缺失（turn=${turnOrdinal} step=${stepOrdinal} tool=${toolOrdinal}）`,
    );
  }
  const range: SpanRange = { startIdx: toolStart, endIdx: toolStart + 1 };
  const start = resolveStart(ctx.index.times, range, ctx.unknownTimes);
  const end = resolveEnd(ctx.index.times, range, start);
  const span: Span = {
    traceId,
    spanId: deriveSpanId(key, toolSpanPath(turnOrdinal, stepOrdinal, toolOrdinal)),
    parentSpanId: parent.spanId,
    name: redactString(tool.toolName),
    kind: SPAN_KIND,
    startTimeUnixNano: start.toString(),
    endTimeUnixNano: end.toString(),
  };

  const attrs: KeyValue[] = [];
  attrs.push(kv('gen_ai.tool.name', tool.toolName));
  if (tool.toolCallId !== undefined) attrs.push(kv('gen_ai.tool.call.id', tool.toolCallId));
  if (tool.argsText !== undefined) attrs.push(kv('gen_ai.tool.call.arguments', tool.argsText));
  if (tool.resultText !== undefined) attrs.push(kv('gen_ai.tool.call.result', tool.resultText));
  attrs.push(kv('asu.tool.pairing', tool.pairing));
  if (tool.pairing !== 'paired') {
    attrs.push(kv(PENDING_OR_INTERRUPTED_KEY, true));
  }
  if (tool.isError === true) {
    attrs.push(kv('asu.tool.is_error', true));
    span.status = { code: 'STATUS_CODE_ERROR' };
  }
  attrs.push(kv(SOURCE_REF_COUNT_KEY, tool.sourceRefs.length));
  appendExtras(attrs, tool.extras);
  sortAttributes(attrs);
  if (attrs.length > 0) span.attributes = attrs;

  ctx.spans.push(span);

  buildCompactionSpans(ctx, tool.extras, toolSpanPath(turnOrdinal, stepOrdinal, toolOrdinal), span);
}

/**
 * compaction 子 span：挂在 parentSpan 下（turn/step/tool 各自的 extras.events）。
 * 时间取事件自带 time（start=end）；无 time → 0 并计数。不设 source_ref_count
 * （派生 span；原始事件的引用计数已在父节点 asu.source_ref_count 内）。
 * 子 span 时间可能晚于父 span 终点（事件真实时间优先于窗口美观，原文在
 * asu.events 可查——DESIGN §10 时间取事件自带，不做窗口修剪）。
 */
function buildCompactionSpans(
  ctx: BuildContext,
  extras: Record<string, unknown>,
  parentPath: string,
  parentSpan: Span,
): void {
  const events = compactionEventsFromExtras(extras);
  for (const [ordinal, event] of events.entries()) {
    const time = eventTimeToNano(event.entry);
    const span: Span = {
      traceId: ctx.traceId,
      spanId: deriveSpanId(ctx.key, compactionSpanPath(parentPath, ordinal)),
      parentSpanId: parentSpan.spanId,
      name: COMPACTION_SPAN_NAME,
      kind: SPAN_KIND,
      startTimeUnixNano: (time ?? UNKNOWN_TIME_NANO).toString(),
      endTimeUnixNano: (time ?? UNKNOWN_TIME_NANO).toString(),
    };
    if (time === undefined) {
      ctx.unknownTimes.count += 1;
    } else if (ctx.compaction.maxNano === undefined || time > ctx.compaction.maxNano) {
      ctx.compaction.maxNano = time;
    }

    const attrs: KeyValue[] = [];
    attrs.push(kv(COMPACTION_FLAG_KEY, true));
    const type = typeof event.entry['type'] === 'string' ? event.entry['type'] : UNKNOWN_EVENT_TYPE;
    attrs.push(kv('asu.compaction.event_type', type));
    usageToAttributes(event.usage, attrs);
    sortAttributes(attrs);
    if (attrs.length > 0) span.attributes = attrs;

    ctx.spans.push(span);
    ctx.compaction.count += 1;
  }
}
