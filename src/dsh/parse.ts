/**
 * DSH 事件流 → 会话树（DESIGN §4.1/§4.3/§5、RESEARCH §5、t1 裁决 R1/R3/R5/R6/R11/R12/R16/R17）。
 *
 * 分工：`frames.ts` 负责容器（多帧 zstd → 整体 jsonl 文本），本文件负责语义：
 * - **判版**：只解析 `header.version >= 4` 的会话（DESIGN §2）；v3 及以下整文件跳过、
 *   计数（R5）——仍产出一个只含统计的 SessionNode，「计数不猜」，不伪造 turn/step；
 * - **去重**：镜像目录（`~/.dsh/sessions` 与 `harness/sessions`）里同一会话的重复
 *   记录按 `(session_id, seq)` 去重并计数（DESIGN §5 镜像条款、R17）；
 * - **usage 主口径**：只取 `assistant/message.data.usage`；`assistant/attempt` 不带
 *   usage，从不取（R16），否则重复计账；`totalTokens` 含 cacheRead，不自行重算，
 *   原样进 `asu.usage.total_tokens`（R11）；
 * - **surfaceOp 两种写法**：字符串 `"append"` 与对象 `{op,start,end}` /
 *   `{op,startSeq,endSeq}` 都认，统一归一到 `{op, startSeq, endSeq}` 形状（DESIGN §5）；
 * - **字段三去向**（DESIGN §3.3）：语义槽（四层节点字段）、extras（认不得/无处去的
 *   字段，组装层统一成 `asu.*`）、计数（Stats）。整条事件原文、事件级未知字段、
 *   结构事件里没被消费的 data 字段，全部按原样进 extras，绝不静默丢弃；
 * - **容错**：坏行/坏帧/未知事件跳过或保留 + 计数，绝不 throw 中断整份文件。
 *
 * 时间（DESIGN §10、R12/R13）：事件自带 `time` 是 epoch 毫秒（13 位，Number 安全），
 * 立刻用 `msToUnixNano`（BigInt 乘法）换成纳秒；出现超 2^53 的数值/字符串时不猜，
 * 原样留在 extras、节点时间缺省（由组装层回填并计 unknownTimes）。
 *
 * extras 的键不带 `asu.` 前缀：前缀与脱敏都由组装层（core/spanBuilder）统一处理；
 * 本模块不 import redact（t1 §6 裁决 3）。
 */

import { readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  asSessionSource,
  emptyStats,
  msToUnixNano,
  type SessionNode,
  type SessionSource,
  type SourceRef,
  type Stats,
  type StepNode,
  type ToolNode,
  type ToolPairing,
  type TurnNode,
  type UnixNano,
  type Usage,
} from '../core/model.js';
import { readZstdJsonl, type FrameDecodeOptions } from './frames.js';

/** 本解析器产出的工具名（DESIGN §3.5 resource 属性）。 */
export const DSH_TOOL_NAME = 'dsh';

/**
 * 支持的最低会话格式版本（DESIGN §2：DSH 只适配 v4 及以上）。
 * v3 及以下整文件跳过并计数，不猜（R5）。
 */
export const MIN_SUPPORTED_FORMAT_VERSION = 4;

/** `session.jsonl.zstd`（无 `.vN`）是 v0（RESEARCH §5）。 */
export const IMPLICIT_SESSION_FILE_VERSION = 0;

/** 版本化会话容器文件名：`session.vN.jsonl.zstd`；`session.jsonl.zstd` = v0。 */
const SESSION_FILE_PATTERN = /^session(?:\.v(\d+))?\.jsonl\.zstd$/i;

/**
 * 会话容器统一后缀：zstd 里装的是 jsonl 行。
 *
 * 真实数据里文件名有两种布局（本机实证）：
 * - 版本化：`session.vN.jsonl.zstd`（`~/.dsh/sessions/<ws>/<sessionId>/` 布局，
 *   同目录多版本只读最高 vN，DESIGN §5）；
 * - 扁平：`session-<uuid>.jsonl.zstd` / `<uuid>.jsonl.zstd`（导出 dump 布局，
 *   一个文件就是一个会话，**不折叠**）。
 *
 * 版本一律按记录判（AGENTS：不按文件级判版），所以这里只判「是不是容器」，
 * 文件名里有没有版本号由 `sessionFileVersion` 单独回答（扁平命名回答 undefined）。
 */
export const DSH_CONTAINER_SUFFIX = '.jsonl.zstd';

/** 是否是 DSH 会话容器（只看容器后缀，不看主干命名）。 */
export function isDshSessionContainer(fileName: string): boolean {
  return basename(fileName).toLowerCase().endsWith(DSH_CONTAINER_SUFFIX);
}

/** 事件缺 `type` 时的记录类型标记（不猜、不丢，按未知事件计数）。 */
const MISSING_TYPE_RECORD = '<missing-type>';

/** 工具事件缺工具名时的标记（AGENTS：缺失不填假值，用显式标记）。 */
const UNKNOWN_TOOL_NAME = '(unknown)';

/** 结构事件：直接映射到会话树四层的类型。其余类型整条事件原文进 extras。 */
const STRUCTURAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'user/message',
  'system/message',
  'developer/message',
  'assistant/message',
  'assistant/attempt',
  'tool/call',
  'tool/result',
]);

/**
 * 已知的非结构事件类型（本机 v3/v4 实证 40 种，取自 617 个会话文件的类型普查）。
 * 用于区分「认得但只是原样保留」与「真未知」（后者进 stats.unknownEventTypes）。
 * 新版本新增类型会自然落入 unknownEventTypes，不改这里也能保留原文。
 */
const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set([
  'session',
  'permission/preset',
  'sandbox/mode',
  'approval/policy',
  'approval/asked',
  'approval/decided',
  'agent/inbox/spliced',
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'system/message',
  'user/message',
  'developer/message',
  'request/header',
  'request/context',
  'session/title',
  'session/title-llm-request',
  'session/end-seed',
  'session-log-deepseek/delivery-accepted',
  'assistant/message',
  'assistant/attempt',
  'tool/call',
  'tool/result',
  'model/selection',
  'subagent/catalog',
  'subagent/descriptor',
  'job/registered',
  'job/settled',
  'llm/retry',
  'llm/retry-started',
  'workspace/changes',
  'deliverables/presented',
  'compaction/start',
  'compaction/summary',
  'compaction/end',
  'compaction/prune',
  'todo/write',
  'command/run',
  'command/done',
  'goal/change',
]);

/**
 * 会话级事件：与具体 turn/step 无关的配置、标题、注入、命令等，extras 统一挂会话根
 * （避免把几千字的注入提示词挂到某个 step 上；DESIGN §3.3 只要求不丢，不要求挂点）。
 */
const SESSION_SCOPED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'permission/preset',
  'sandbox/mode',
  'approval/policy',
  'approval/asked',
  'approval/decided',
  'agent/inbox/spliced',
  'session/title',
  'session/title-llm-request',
  'session/end-seed',
  'session-log-deepseek/delivery-accepted',
  'subagent/catalog',
  'subagent/descriptor',
  'model/selection',
  'todo/write',
  'goal/change',
  'command/run',
  'command/done',
]);

/**
 * 结构事件里被语义槽完整吸收的 data 字段；其余字段原样进 extras（三去向纪律）。
 * `turn`/`step` 编号不进这里——它们在节点 extras 里各存一次（turn_number/step_number），
 * 原始编号不丢，也不会在每个事件里重复一份。
 */
const CONSUMED_DATA_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  'turn/start': new Set(['turn']),
  'turn/end': new Set(['turn']),
  'step/start': new Set(['turn', 'step']),
  'step/end': new Set(['turn', 'step']),
  'user/message': new Set(['turn', 'step', 'message', 'content', 'role', 'id', 'source']),
  'system/message': new Set(['turn', 'step', 'message']),
  'developer/message': new Set(['turn', 'step', 'message']),
  'assistant/message': new Set(['turn', 'step', 'message', 'usage']),
  'assistant/attempt': new Set(['turn', 'step']),
  'tool/call': new Set(['turn', 'step', 'callId', 'name', 'arguments']),
  'tool/result': new Set(['turn', 'step', 'message']),
};

/** 可挂 extras 的节点（四层都有 sourceRefs + extras）。 */
type ExtraNode = SessionNode | TurnNode | StepNode | ToolNode;

/** 原始 JSON 对象。 */
type JsonObject = Record<string, unknown>;

/** 解析一条记录后的中间形态（时间已换成纳秒；rawTime 留着防丢）。 */
interface ParsedRecord {
  type: string;
  seq: number | undefined;
  timeUnixNano: UnixNano | undefined;
  rawTime: unknown;
  record: JsonObject;
  data: JsonObject | undefined;
  /** jsonl 行号（1 起，切行前的位置）。 */
  line: number;
  file: string;
}

/** 一个已解码会话文件的原始材料（尚未判版）。 */
interface RawSessionFile {
  path: string;
  header: JsonObject | undefined;
  headerVersion: number | undefined;
  headerLine: number | undefined;
  records: ParsedRecord[];
  /** 非空行数（R7 的 DSH 输入口径）。 */
  inputRecords: number;
  badLines: number;
  frames: number;
  failedFrames: number;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function nonNegativeIntegerOrUndefined(value: unknown): number | undefined {
  const n = numberOrUndefined(value);
  return n !== undefined && n >= 0 ? n : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** 复制对象但去掉指定键（无损保留其余字段，用于 message 去掉已消费的大块 content）。 */
function omitKeys(source: JsonObject, keys: readonly string[]): JsonObject {
  const out: JsonObject = {};
  const skip = new Set(keys);
  for (const [key, value] of Object.entries(source)) {
    if (!skip.has(key)) out[key] = value;
  }
  return out;
}

/** 结构性序列化（参数/结果原文非字符串时的兜底），失败不抛。 */
function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * 事件 time → 纳秒（R12）：DSH 的 time 是 epoch 毫秒整数（13 位，Number 安全）。
 * 超 2^53 的数值（例如纳秒整数）或数字字符串一律不猜，返回 undefined 由调用方原样保留。
 */
function dshTimeToUnixNano(value: unknown): UnixNano | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? msToUnixNano(value) : undefined;
  }
  // 只有能证明落在安全整数范围内的数字字符串才换算；19 位纳秒串不进 Number。
  if (typeof value === 'string' && /^\d{1,16}$/.test(value)) {
    const ms = Number(value);
    return Number.isSafeInteger(ms) ? msToUnixNano(ms) : undefined;
  }
  return undefined;
}

/**
 * surfaceOp 归一（DESIGN §5：`start/end` 与 `startSeq/endSeq` 两种写法都认）。
 * 对象形式保留全部原始键，并把可识别的范围统一成 startSeq/endSeq。
 */
function normalizeSurfaceOp(value: unknown): unknown {
  if (typeof value === 'string') return { op: value };
  if (!isJsonObject(value)) return value;
  const out: JsonObject = { ...value };
  const start = value.startSeq ?? value.start;
  const end = value.endSeq ?? value.end;
  if (start !== undefined && out.startSeq === undefined) out.startSeq = start;
  if (end !== undefined && out.endSeq === undefined) out.endSeq = end;
  return out;
}

/** 往 extras 追加一条事件流水（数组，顺序稳定；不做键名爆炸）。 */
function appendEventExtra(extras: JsonObject, entry: JsonObject): void {
  const existing = extras.events;
  if (Array.isArray(existing)) {
    existing.push(entry);
    return;
  }
  if (existing === undefined) {
    extras.events = [entry];
    return;
  }
  extras.events = [existing, entry];
}

/** 标量 extras 写入：同名重复出现时升级成数组，不覆盖前值（不丢字段）。 */
function putScalarExtra(extras: JsonObject, key: string, value: unknown): void {
  const existing = extras[key];
  if (existing === undefined) {
    extras[key] = value;
    return;
  }
  if (Array.isArray(existing)) {
    existing.push(value);
    return;
  }
  extras[key] = [existing, value];
}

/** 工具调用 id 的三种取法（DSH tool/call、tool/result.message、job/deliverables 的 toolCall）。 */
function extractToolCallId(data: JsonObject | undefined): string | undefined {
  if (data === undefined) return undefined;
  const direct = stringOrUndefined(data.callId);
  if (direct !== undefined) return direct;
  if (isJsonObject(data.toolCall)) return stringOrUndefined(data.toolCall.callId);
  return undefined;
}

/** 工具结果/错误判断：`message.isError` → content 块的 `isError` → `data.error` 存在（DESIGN §5）。 */
function deriveIsError(message: JsonObject | undefined, dataError: unknown): boolean | undefined {
  if (message !== undefined) {
    if (typeof message.isError === 'boolean') return message.isError;
    const content = message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (isJsonObject(block) && typeof block.isError === 'boolean') return block.isError;
      }
    }
  }
  if (dataError !== undefined) return true;
  return undefined;
}

/**
 * 工具结果原文：全 text 块拼成字符串；含图片/嵌套 tool-result 等非文本块时整段
 * JSON 序列化（无损，DESIGN §3.4 不截断）。
 */
function contentToText(content: unknown): string | undefined {
  if (content === undefined) return undefined;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    let allText = true;
    const texts: string[] = [];
    for (const block of content) {
      if (isJsonObject(block) && block.type === 'text' && typeof block.text === 'string') {
        texts.push(block.text);
      } else {
        allText = false;
        break;
      }
    }
    if (allText) return texts.join('\n');
  }
  return stringifyJson(content);
}

/** 轮/步编号 → 步节点索引键（同轮内步号唯一）。 */
function stepKey(turnNumber: number, stepNumber: number): string {
  return `${turnNumber}:${stepNumber}`;
}

/** 会话文件名 → 格式版本（`session.jsonl.zstd` = v0）；认不出返回 undefined。 */
export function sessionFileVersion(fileName: string): number | undefined {
  const match = SESSION_FILE_PATTERN.exec(basename(fileName));
  if (match === null) return undefined;
  const raw = match[1];
  return raw === undefined ? IMPLICIT_SESSION_FILE_VERSION : Number(raw);
}

/**
 * 从候选文件里挑最高版本的 `session.vN.jsonl.zstd`（DESIGN §5「只读最高 vN」）。
 * 同版本时按路径字典序取第一个，保证确定性。
 */
export function pickHighestVersionSessionFile(paths: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestVersion = Number.NEGATIVE_INFINITY;
  for (const path of paths) {
    const version = sessionFileVersion(path);
    if (version === undefined) continue;
    if (version > bestVersion || (version === bestVersion && best !== undefined && path < best)) {
      best = path;
      bestVersion = version;
    }
  }
  return best;
}

/**
 * 把调用方传的输入规范化成会话来源（t1 裁决 R4）：`physicalPath` 是真正要读的
 * 文件（目录则取其中最高版本文件，DESIGN §7：不做自动扫盘）；`logicalPath` 进
 * 一切输出。字符串入参照旧语义，phys == logical（既有调用方零改动）。
 */
export function resolveSessionSource(source: string | SessionSource): SessionSource {
  if (typeof source !== 'string') return source;
  const physicalPath = resolveSessionInput(source);
  return { physicalPath, logicalPath: physicalPath };
}

/**
 * 把调用方传的输入路径规范化成一个会话文件。
 * - 文件：原样返回（DESIGN §7：不做自动扫盘）；
 * - 目录：版本化 `session.vN.jsonl.zstd` 取最高 vN（DESIGN §5）；
 *   目录里只有扁平命名（`session-<uuid>` / `<uuid>`）时，恰好一个就用它，
 *   多个则抛错——扁平布局下「一个目录」不再等于「一个会话」，猜哪个都是错，
 *   批量场景请直接给 `parseDshSessions` 传多个文件（它不做目录扫描）。
 */
export function resolveSessionInput(path: string): string {
  const info = statSync(path);
  if (!info.isDirectory()) return path;
  const containers = readdirSync(path)
    .sort()
    .filter((name) => isDshSessionContainer(name))
    .map((name) => join(path, name));
  const best = pickHighestVersionSessionFile(containers);
  if (best !== undefined) return best;
  if (containers.length === 1) return containers[0] as string;
  if (containers.length === 0) {
    throw new Error(`目录内没有 session 容器（*.jsonl.zstd）：${path}`);
  }
  throw new Error(
    `目录内有 ${containers.length} 个扁平命名的会话容器，一个目录不再等于一个会话；` +
      `请逐个传文件，或用 parseDshSessions 一次收多个：${path}`,
  );
}

/** 真实布局里会话文件名就是版本名（`session.vN.jsonl.zstd`），会话标识只在目录名上。 */
const BARE_SESSION_STEM_PATTERN = /^session(?:\.v\d+)?$/i;

/**
 * 会话 id 回退（R6：只在信头缺 id 时用，并标 `session_id_source='filename'`）。
 * 文件名去掉 `.jsonl.zstd`；若文件名本身就是 `session` / `session.vN`（真实布局），
 * 取所在目录名——那才是这次的会话标识，取 `session.v4` 只会把不同会话撞成一个。
 */
function sessionIdFromFileName(path: string): string {
  const stem = basename(path).replace(/\.jsonl\.zstd$/i, '');
  if (!BARE_SESSION_STEM_PATTERN.test(stem)) return stem;
  const dirName = basename(dirname(path));
  return dirName === '' || dirName === '.' ? stem : dirName;
}

// ---------------------------------------------------------------------------
// 读文件：容器解码 + 逐行解析（不判版）
// ---------------------------------------------------------------------------

function readSessionFile(
  source: SessionSource,
  options: FrameDecodeOptions,
): RawSessionFile {
  const decoded = readZstdJsonl(source.physicalPath, options);
  const lines = decoded.text.split('\n');
  const records: ParsedRecord[] = [];
  let inputRecords = 0;
  let badLines = 0;
  let header: JsonObject | undefined;
  let headerVersion: number | undefined;
  let headerLine: number | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] as string;
    const line = raw.trim();
    if (line === '') continue;
    inputRecords += 1;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      badLines += 1;
      continue;
    }
    if (!isJsonObject(parsed)) {
      badLines += 1;
      continue;
    }

    const type = stringOrUndefined(parsed.type) ?? MISSING_TYPE_RECORD;
    if (type === 'session' && header === undefined) {
      header = parsed;
      headerLine = index + 1;
      headerVersion = numberOrUndefined(parsed.version);
      continue;
    }

    const dataValue = parsed.data;
    records.push({
      type,
      seq: numberOrUndefined(parsed.seq),
      timeUnixNano: dshTimeToUnixNano(parsed.time),
      rawTime: parsed.time,
      record: parsed,
      data: isJsonObject(dataValue) ? dataValue : undefined,
      line: index + 1,
      file: source.logicalPath,
    });
  }

  return {
    path: source.logicalPath,
    header,
    headerVersion,
    headerLine,
    records,
    inputRecords,
    badLines,
    frames: decoded.stats.frames,
    failedFrames: decoded.stats.failedFrames,
  };
}

// ---------------------------------------------------------------------------
// 事件 → 会话树
// ---------------------------------------------------------------------------

/** 单会话的建树器：持有当前 turn/step 上下文与去重/索引状态。 */
class DshTreeBuilder {
  private readonly tree: SessionNode;
  private readonly stats: Stats;
  private readonly seenSeq = new Set<number>();
  private readonly toolByCallId = new Map<string, ToolNode>();
  private readonly turnsByNumber = new Map<number, TurnNode>();
  private readonly stepsByKey = new Map<string, StepNode>();
  private currentTurn: TurnNode | undefined;
  private currentStep: StepNode | undefined;
  /**
   * 尚未有 step 可落的输入消息（实证：`user/message` 常不带 turn/step，且在
   * step/start 之前到达）。先挂起，等下一步建出来时并入它的 inputMessages；
   * 若该轮结束仍无 step，则整条原文挂到轮/会话 extras——两条路径都只归属一次。
   */
  private pendingInputs: Array<{ record: ParsedRecord; message: unknown }> = [];

  constructor(tree: SessionNode) {
    this.tree = tree;
    this.stats = tree.stats;
  }

  /** 一条记录的总入口：先按 (session_id, seq) 去重，再按类型分派。 */
  dispatch(record: ParsedRecord): void {
    if (record.type === 'session') {
      // 同组内后到的信头（镜像副本）：无 seq 可去重，按重复记录计数。
      this.stats.deduped += 1;
      this.stats.skippedRecords += 1;
      return;
    }
    if (record.seq !== undefined) {
      if (this.seenSeq.has(record.seq)) {
        this.stats.deduped += 1;
        this.stats.skippedRecords += 1;
        return;
      }
      this.seenSeq.add(record.seq);
    }
    switch (record.type) {
      case 'turn/start':
        this.onTurnStart(record);
        return;
      case 'turn/end':
        this.onTurnEnd(record);
        return;
      case 'step/start':
        this.onStepStart(record);
        return;
      case 'step/end':
        this.onStepEnd(record);
        return;
      case 'user/message':
      case 'system/message':
      case 'developer/message':
        this.onInputMessage(record);
        return;
      case 'assistant/message':
        this.onAssistantMessage(record);
        return;
      case 'assistant/attempt':
        this.onAssistantAttempt(record);
        return;
      case 'tool/call':
        this.onToolCall(record);
        return;
      case 'tool/result':
        this.onToolResult(record);
        return;
      default:
        this.onOtherEvent(record);
    }
  }

  /** 收尾：产出 span 总数与未配对工具数（R7 条数守恒的分子之一）。 */
  finalize(): void {
    this.flushPendingToNode(this.currentTurn ?? this.lastTurn() ?? this.tree);
    let producedSpans = 1;
    let unpairedTools = 0;
    for (const turn of this.tree.turns) {
      producedSpans += 1;
      for (const step of turn.steps) {
        producedSpans += 1;
        for (const tool of step.tools) {
          producedSpans += 1;
          if (tool.pairing !== 'paired') unpairedTools += 1;
        }
      }
    }
    this.stats.producedSpans = producedSpans;
    this.stats.unpairedTools = unpairedTools;
  }

  // -- 节点构造 -------------------------------------------------------------

  private createTurn(time: UnixNano | undefined): TurnNode {
    const turn: TurnNode = { sourceRefs: [], extras: {}, steps: [] };
    if (time !== undefined) turn.startTimeUnixNano = time;
    this.tree.turns.push(turn);
    return turn;
  }

  private createStep(turn: TurnNode, time: UnixNano | undefined): StepNode {
    const step: StepNode = { sourceRefs: [], extras: {}, tools: [] };
    if (time !== undefined) step.startTimeUnixNano = time;
    turn.steps.push(step);
    // 挂起的输入消息（先于 step/start 到达的用户/系统消息）并入新步。
    this.flushPendingIntoStep(step);
    return step;
  }

  private lastTurn(): TurnNode | undefined {
    return this.tree.turns.length === 0 ? undefined : this.tree.turns[this.tree.turns.length - 1];
  }

  private flushPendingIntoStep(step: StepNode): void {
    for (const item of this.pendingInputs) {
      if (item.message !== undefined) {
        if (step.inputMessages === undefined) step.inputMessages = [];
        step.inputMessages.push(item.message);
      }
      this.addRef(step, item.record);
      this.pushLeftovers(step, item.record, CONSUMED_DATA_KEYS[item.record.type] ?? new Set());
    }
    this.pendingInputs = [];
  }

  private flushPendingToNode(node: ExtraNode): void {
    for (const item of this.pendingInputs) {
      this.addRef(node, item.record);
      // 没有 step 可落：整条 data（含 content/role/source）原样进 extras，一字不丢。
      this.pushLeftovers(node, item.record, new Set());
    }
    this.pendingInputs = [];
  }

  private getOrCreateTurn(turnNumber: number | undefined, time: UnixNano | undefined): TurnNode {
    if (turnNumber !== undefined) {
      const existing = this.turnsByNumber.get(turnNumber);
      if (existing !== undefined) return existing;
    } else if (this.currentTurn !== undefined) {
      return this.currentTurn;
    }
    const turn = this.createTurn(time);
    if (turnNumber !== undefined) {
      this.turnsByNumber.set(turnNumber, turn);
      turn.extras.turn_number = turnNumber;
    }
    return turn;
  }

  /** 取（必要时补建）事件指向的 step；不改当前上下文（迟到事件用）。 */
  private getOrCreateStep(
    turnNumber: number | undefined,
    stepNumber: number | undefined,
    time: UnixNano | undefined,
  ): StepNode | undefined {
    if (turnNumber === undefined || stepNumber === undefined) return this.currentStep;
    const key = stepKey(turnNumber, stepNumber);
    const existing = this.stepsByKey.get(key);
    if (existing !== undefined) return existing;
    const turn = this.getOrCreateTurn(turnNumber, time);
    const step = this.createStep(turn, time);
    step.extras.step_number = stepNumber;
    this.stepsByKey.set(key, step);
    return step;
  }

  private lookupStep(turnNumber: number | undefined, stepNumber: number | undefined): StepNode | undefined {
    if (turnNumber === undefined || stepNumber === undefined) return undefined;
    return this.stepsByKey.get(stepKey(turnNumber, stepNumber));
  }

  // -- 引用与 extras --------------------------------------------------------

  private addRef(node: ExtraNode, record: ParsedRecord): void {
    const ref: SourceRef = { file: record.file, line: record.line, recordType: record.type };
    if (record.seq !== undefined) ref.seq = record.seq;
    node.sourceRefs.push(ref);
  }

  /** 事件级 + data 级未被消费字段的原文条目（type/seq 打头，便于对账）。 */
  private baseLeftoverEntry(record: ParsedRecord): JsonObject {
    const entry: JsonObject = { type: record.type };
    if (record.seq !== undefined) entry.seq = record.seq;
    if (record.timeUnixNano === undefined && record.rawTime !== undefined) entry.time = record.rawTime;
    for (const [key, value] of Object.entries(record.record)) {
      if (key === 'type' || key === 'seq' || key === 'time' || key === 'data') continue;
      entry[key] = key === 'surfaceOp' ? normalizeSurfaceOp(value) : value;
    }
    return entry;
  }

  private pushLeftovers(
    node: ExtraNode,
    record: ParsedRecord,
    consumed: ReadonlySet<string>,
  ): void {
    const entry = this.baseLeftoverEntry(record);
    if (record.data !== undefined) {
      for (const [key, value] of Object.entries(record.data)) {
        if (!consumed.has(key)) entry[key] = value;
      }
    } else if (record.record.data !== undefined) {
      entry.data = record.record.data;
    }
    if (Object.keys(entry).length > 1) appendEventExtra(node.extras, entry);
  }

  private setEndTime(node: { endTimeUnixNano?: UnixNano }, time: UnixNano | undefined): void {
    if (time === undefined) return;
    const current = node.endTimeUnixNano;
    if (current === undefined || time > current) node.endTimeUnixNano = time;
  }

  // -- 结构事件 -------------------------------------------------------------

  private onTurnStart(record: ParsedRecord): void {
    const data = record.data ?? {};
    const turnNumber = numberOrUndefined(data.turn);
    // 上一轮若留有待落步的输入消息，先归到上一轮（不跨轮串味）。
    this.flushPendingToNode(this.currentTurn ?? this.tree);
    const turn = this.createTurn(record.timeUnixNano);
    if (turnNumber !== undefined) {
      this.turnsByNumber.set(turnNumber, turn);
      turn.extras.turn_number = turnNumber;
    }
    this.currentTurn = turn;
    this.currentStep = undefined;
    this.addRef(turn, record);
    this.pushLeftovers(turn, record, CONSUMED_DATA_KEYS['turn/start'] ?? new Set());
  }

  private onTurnEnd(record: ParsedRecord): void {
    const data = record.data ?? {};
    const turnNumber = numberOrUndefined(data.turn);
    const turn =
      (turnNumber !== undefined ? this.turnsByNumber.get(turnNumber) : undefined) ??
      this.currentTurn ??
      this.createTurn(record.timeUnixNano);
    if (record.timeUnixNano !== undefined) turn.endTimeUnixNano = record.timeUnixNano;
    const reason = data.reason;
    const endReason =
      typeof reason === 'string'
        ? reason
        : isJsonObject(reason)
          ? stringOrUndefined(reason.kind)
          : undefined;
    if (endReason !== undefined) turn.endReason = endReason;
    this.flushPendingToNode(turn);
    this.addRef(turn, record);
    // reason 对象整段留在 extras（endReason 只取 kind，其余字段不许丢）。
    this.pushLeftovers(turn, record, CONSUMED_DATA_KEYS['turn/end'] ?? new Set());
    this.currentTurn = undefined;
    this.currentStep = undefined;
  }

  private onStepStart(record: ParsedRecord): void {
    const data = record.data ?? {};
    const turnNumber = numberOrUndefined(data.turn);
    const stepNumber = numberOrUndefined(data.step);
    const turn = this.getOrCreateTurn(turnNumber, record.timeUnixNano);
    const step = this.createStep(turn, record.timeUnixNano);
    if (stepNumber !== undefined) step.extras.step_number = stepNumber;
    if (turnNumber !== undefined && stepNumber !== undefined) {
      this.stepsByKey.set(stepKey(turnNumber, stepNumber), step);
    }
    this.currentTurn = turn;
    this.currentStep = step;
    this.addRef(step, record);
    this.pushLeftovers(step, record, CONSUMED_DATA_KEYS['step/start'] ?? new Set());
  }

  private onStepEnd(record: ParsedRecord): void {
    const data = record.data ?? {};
    const step = this.currentStep ?? this.lookupStep(
      numberOrUndefined(data.turn),
      numberOrUndefined(data.step),
    );
    if (step !== undefined) {
      if (record.timeUnixNano !== undefined) step.endTimeUnixNano = record.timeUnixNano;
      this.addRef(step, record);
      this.pushLeftovers(step, record, CONSUMED_DATA_KEYS['step/end'] ?? new Set());
    } else {
      // 找不到所属 step：不伪造结构，原文挂当前轮/会话（计数照旧归类）。
      const target: ExtraNode = this.currentTurn ?? this.tree;
      this.addRef(target, record);
      this.pushLeftovers(target, record, new Set());
    }
    // 步结束即清当前 step：之后迟到的事件靠 callId / 编号索引归位（实证有 35 例）。
    this.currentStep = undefined;
  }

  private onInputMessage(record: ParsedRecord): void {
    const data = record.data ?? {};
    const message = data.message !== undefined
      ? data.message
      : omitKeys(data, ['turn', 'step']);
    const step = this.currentStep ?? this.getOrCreateStep(
      numberOrUndefined(data.turn),
      numberOrUndefined(data.step),
      record.timeUnixNano,
    );
    if (step === undefined) {
      // 还没有步可落：挂起，等下一步建出来并入（createStep 里 flush）。
      this.pendingInputs.push({ record, message });
      return;
    }
    if (message !== undefined) {
      if (step.inputMessages === undefined) step.inputMessages = [];
      step.inputMessages.push(message);
    }
    if (record.timeUnixNano !== undefined && step.startTimeUnixNano === undefined) {
      step.startTimeUnixNano = record.timeUnixNano;
    }
    this.addRef(step, record);
    this.pushLeftovers(step, record, CONSUMED_DATA_KEYS[record.type] ?? new Set());
  }

  private onAssistantMessage(record: ParsedRecord): void {
    const data = record.data ?? {};
    const message = data.message;
    const step = this.currentStep ?? this.getOrCreateStep(
      numberOrUndefined(data.turn),
      numberOrUndefined(data.step),
      record.timeUnixNano,
    );
    if (step === undefined) {
      const target: ExtraNode = this.currentTurn ?? this.tree;
      this.addRef(target, record);
      this.pushLeftovers(target, record, new Set());
      return;
    }
    if (message !== undefined) {
      if (step.outputMessages === undefined) step.outputMessages = [];
      step.outputMessages.push(message);
    }
    if (isJsonObject(message)) {
      const source = message.source;
      if (isJsonObject(source)) {
        const model = stringOrUndefined(source.model);
        if (model !== undefined && step.model === undefined) step.model = model;
      }
    }
    if (step.startTimeUnixNano === undefined && record.timeUnixNano !== undefined) {
      step.startTimeUnixNano = record.timeUnixNano;
    }
    this.setEndTime(step, record.timeUnixNano);
    if (data.usage !== undefined) this.applyUsage(step, data.usage);
    this.addRef(step, record);
    this.pushLeftovers(step, record, CONSUMED_DATA_KEYS['assistant/message'] ?? new Set());
  }

  /**
   * usage 口径（DESIGN §5、R1/R11/R15/R16）：唯一来源是 `assistant/message.data.usage`。
   * 非负整数校验失败的原始值不猜，原样进 extras；`totalTokens` 不重算（R11）。
   */
  private applyUsage(step: StepNode, rawUsage: unknown): void {
    if (!isJsonObject(rawUsage)) {
      appendEventExtra(step.extras, { type: 'assistant/message', usage: rawUsage });
      return;
    }
    const mapped: Usage = {};
    for (const [key, value] of Object.entries(rawUsage)) {
      switch (key) {
        case 'inputTokens':
        case 'outputTokens':
        case 'reasoningTokens':
        case 'cacheReadTokens':
        case 'cacheWriteTokens':
          {
            const n = nonNegativeIntegerOrUndefined(value);
            if (n === undefined) putScalarExtra(step.extras, `usage.${key}`, value);
            else if (key === 'inputTokens') mapped.inputTokens = n;
            else if (key === 'outputTokens') mapped.outputTokens = n;
            else if (key === 'reasoningTokens') mapped.reasoningTokens = n;
            else if (key === 'cacheReadTokens') mapped.cacheReadTokens = n;
            else mapped.cacheWriteTokens = n;
          }
          break;
        case 'totalTokens':
          // R11：含 cacheRead，与 input+output 不自洽是正常的，不重算。
          putScalarExtra(step.extras, 'usage.total_tokens', value);
          break;
        default:
          putScalarExtra(step.extras, `usage.${key}`, value);
      }
    }
    if (Object.keys(mapped).length === 0) return;
    if (step.usage !== undefined) {
      // 同步里的第二个 usage（正常数据每步一条）：保留第一条，第二条原文进 extras 待审。
      this.stats.duplicateUsage += 1;
      appendEventExtra(step.extras, { type: 'assistant/message', usage: rawUsage });
      return;
    }
    step.usage = mapped;
  }

  private onAssistantAttempt(record: ParsedRecord): void {
    const data = record.data ?? {};
    const step = this.currentStep ?? this.getOrCreateStep(
      numberOrUndefined(data.turn),
      numberOrUndefined(data.step),
      record.timeUnixNano,
    );
    const target: ExtraNode = step ?? this.currentTurn ?? this.tree;
    // R16：assistant/attempt 不取 usage；stream 等整段原文进 extras（不截断）。
    this.addRef(target, record);
    this.pushLeftovers(target, record, CONSUMED_DATA_KEYS['assistant/attempt'] ?? new Set());
  }

  private onToolCall(record: ParsedRecord): void {
    const data = record.data ?? {};
    const callId = stringOrUndefined(data.callId);
    const toolName = stringOrUndefined(data.name) ?? UNKNOWN_TOOL_NAME;
    const step = this.currentStep ?? this.getOrCreateStep(
      numberOrUndefined(data.turn),
      numberOrUndefined(data.step),
      record.timeUnixNano,
    );
    if (step === undefined) {
      const target: ExtraNode = this.currentTurn ?? this.tree;
      this.addRef(target, record);
      this.pushLeftovers(target, record, new Set());
      return;
    }
    const tool: ToolNode = { sourceRefs: [], extras: {}, toolName, pairing: 'orphan_call' };
    if (callId !== undefined) {
      tool.toolCallId = callId;
      this.toolByCallId.set(callId, tool);
    }
    const args = data.arguments;
    if (typeof args === 'string') tool.argsText = args;
    else if (args !== undefined) tool.argsText = stringifyJson(args);
    if (record.timeUnixNano !== undefined) tool.startTimeUnixNano = record.timeUnixNano;
    this.addRef(tool, record);
    this.pushLeftovers(tool, record, CONSUMED_DATA_KEYS['tool/call'] ?? new Set());
    step.tools.push(tool);
  }

  private onToolResult(record: ParsedRecord): void {
    const data = record.data ?? {};
    const message = isJsonObject(data.message) ? data.message : undefined;
    const callId = message !== undefined
      ? stringOrUndefined(message.toolCallId) ??
        (isJsonObject(message.source) ? stringOrUndefined(message.source.callId) : undefined)
      : stringOrUndefined(data.callId);
    const resultText = contentToText(message?.content);
    const isError = deriveIsError(message, data.error);
    const time = record.timeUnixNano;

    const attached = callId !== undefined ? this.toolByCallId.get(callId) : undefined;
    if (attached !== undefined) {
      // 已配过对（paired）再来一条结果即重复：不论首份结果是否为空文本都按重复记。
      const alreadyPaired = attached.pairing === 'paired' || attached.pairing === 'duplicate';
      if (!alreadyPaired) {
        if (resultText !== undefined) attached.resultText = resultText;
        attached.pairing = 'paired';
      } else {
        // 重复结果合法（DESIGN §6）：标 duplicate，保留首份结果，重复原文进 extras。
        attached.pairing = 'duplicate';
      }
      if (isError !== undefined && attached.isError === undefined) attached.isError = isError;
      this.setEndTime(attached, time);
      this.addRef(attached, record);
      this.pushToolResultLeftovers(attached, record, message);
      return;
    }

    // 没有对应调用：孤儿结果合法，单独成一个 tool 节点并计数（pairing 在 finalize 统计）。
    const step = this.currentStep ?? this.getOrCreateStep(
      numberOrUndefined(data.turn),
      numberOrUndefined(data.step),
      time,
    );
    if (step === undefined) {
      const target: ExtraNode = this.currentTurn ?? this.tree;
      this.addRef(target, record);
      this.pushLeftovers(target, record, new Set());
      return;
    }
    const tool: ToolNode = {
      sourceRefs: [],
      extras: {},
      toolName: UNKNOWN_TOOL_NAME,
      pairing: 'orphan_result',
    };
    if (callId !== undefined) tool.toolCallId = callId;
    if (resultText !== undefined) tool.resultText = resultText;
    if (isError !== undefined) tool.isError = isError;
    if (time !== undefined) {
      tool.startTimeUnixNano = time;
      tool.endTimeUnixNano = time;
    }
    this.addRef(tool, record);
    this.pushToolResultLeftovers(tool, record, message);
    step.tools.push(tool);
  }

  /** tool/result 的 extras：message 去掉已消费的 content，其余（error/meta/…）原样。 */
  private pushToolResultLeftovers(
    tool: ToolNode,
    record: ParsedRecord,
    message: JsonObject | undefined,
  ): void {
    const entry = this.baseLeftoverEntry(record);
    if (message !== undefined) entry.message = omitKeys(message, ['content']);
    if (record.data !== undefined) {
      for (const [key, value] of Object.entries(record.data)) {
        if (key === 'turn' || key === 'step' || key === 'message') continue;
        entry[key] = value;
      }
    }
    if (Object.keys(entry).length > 1) appendEventExtra(tool.extras, entry);
  }

  // -- 非结构事件 -----------------------------------------------------------

  private onOtherEvent(record: ParsedRecord): void {
    if (!KNOWN_EVENT_TYPES.has(record.type)) {
      this.stats.unknownEventTypes[record.type] =
        (this.stats.unknownEventTypes[record.type] ?? 0) + 1;
    }
    const data = record.data;
    if (record.type === 'request/context' && data !== undefined) {
      const model = stringOrUndefined(data.model);
      if (model !== undefined && this.currentStep !== undefined && this.currentStep.model === undefined) {
        this.currentStep.model = model;
      }
    }
    const target = SESSION_SCOPED_EVENT_TYPES.has(record.type)
      ? this.tree
      : this.resolveEventTarget(record.type, data);
    // compact 边界标记（R9）：用量单独成 span 由组装层做，解析层只打标 + 原文全留。
    if (record.type.startsWith('compaction/')) this.markCompact(data);
    // 整条事件原文进 extras（含 type/seq/time/data 与 surfaceOp），一个字都不丢；
    // surfaceOp 统一归一到 {op, startSeq, endSeq}（原始 start/end 仍保留）。
    const entry: JsonObject = { ...record.record };
    if (entry.surfaceOp !== undefined) entry.surfaceOp = normalizeSurfaceOp(entry.surfaceOp);
    appendEventExtra(target.extras, entry);
    this.addRef(target, record);
  }

  /** compact 边界标记（R9）：只给已存在的 turn 打标，不为压缩事件凭空造轮。 */
  private markCompact(data: JsonObject | undefined): void {
    const turnNumber = data !== undefined ? numberOrUndefined(data.turn) : undefined;
    const turn = turnNumber !== undefined
      ? this.turnsByNumber.get(turnNumber)
      : this.currentTurn;
    if (turn !== undefined) turn.compact = true;
  }

  /** 非结构事件挂点：工具事件优先找 tool 节点，其次按 turn/step 编号，最后当前上下文。 */
  private resolveEventTarget(
    type: string,
    data: JsonObject | undefined,
  ): SessionNode | TurnNode | StepNode | ToolNode {
    if (data !== undefined) {
      if (type.startsWith('job/') || type === 'deliverables/presented') {
        const callId = extractToolCallId(data);
        const tool = callId !== undefined ? this.toolByCallId.get(callId) : undefined;
        if (tool !== undefined) return tool;
      }
      const turnNumber = numberOrUndefined(data.turn);
      if (turnNumber !== undefined) {
        const step = this.lookupStep(turnNumber, numberOrUndefined(data.step));
        if (step !== undefined) return step;
        const turn = this.turnsByNumber.get(turnNumber);
        if (turn !== undefined) return turn;
      }
    }
    return this.currentStep ?? this.currentTurn ?? this.tree;
  }
}

// ---------------------------------------------------------------------------
// 组装：一个会话组（同 session id + agent 的镜像文件）→ 一棵会话树
// ---------------------------------------------------------------------------

/** 信头里已被语义槽消费的字段；其余原样进 extras（三去向纪律）。 */
const CONSUMED_HEADER_KEYS: ReadonlySet<string> = new Set([
  'type',
  'version',
  'id',
  'createdAt',
  'cwd',
  'isSeeded',
  'delegationDepth',
  'agentPreset',
  'parentSession',
  'origin',
]);

function pickIdentityFile(raws: readonly RawSessionFile[]): RawSessionFile | undefined {
  for (const raw of raws) {
    if ((raw.headerVersion ?? -1) >= MIN_SUPPORTED_FORMAT_VERSION) return raw;
  }
  return raws.find((raw) => raw.header !== undefined) ?? raws[0];
}

function maxHeaderVersion(raws: readonly RawSessionFile[]): number | undefined {
  let max: number | undefined;
  for (const raw of raws) {
    if (raw.headerVersion === undefined) continue;
    if (max === undefined || raw.headerVersion > max) max = raw.headerVersion;
  }
  return max;
}

function buildSessionTree(raws: readonly RawSessionFile[]): SessionNode {
  const identity = pickIdentityFile(raws);
  const header = identity?.header;
  const version = maxHeaderVersion(raws);
  const stats = emptyStats();

  const headerId = header !== undefined ? stringOrUndefined(header.id) : undefined;

  const tree: SessionNode = {
    sourceRefs: [],
    extras: {},
    tool: DSH_TOOL_NAME,
    sessionId: '',
    agentLabel: 'main',
    turns: [],
    stats,
  };

  // 身份字段（R4/R6）：id 缺失用文件名顶替并标记来源；agent 标识用 origin ?? 'main'。
  if (headerId !== undefined && headerId !== '') {
    tree.sessionId = headerId;
  } else {
    tree.sessionId = identity !== undefined ? sessionIdFromFileName(identity.path) : '';
    tree.extras.session_id_source = 'filename';
  }
  const origin = header !== undefined ? stringOrUndefined(header.origin) : undefined;
  tree.agentLabel = origin ?? 'main';
  if (origin !== undefined) tree.origin = origin;
  if (version !== undefined) tree.formatVersion = version;

  if (header !== undefined) {
    const cwd = stringOrUndefined(header.cwd);
    if (cwd !== undefined) tree.cwd = cwd;
    const agentPreset = stringOrUndefined(header.agentPreset);
    if (agentPreset !== undefined) tree.agentPreset = agentPreset;
    const parentSession = stringOrUndefined(header.parentSession);
    if (parentSession !== undefined) tree.parentSession = parentSession;
    const delegationDepth = nonNegativeIntegerOrUndefined(header.delegationDepth);
    if (delegationDepth !== undefined) tree.delegationDepth = delegationDepth;
    if (typeof header.isSeeded === 'boolean') tree.isSeeded = header.isSeeded;
    const createdAt = nonNegativeIntegerOrUndefined(header.createdAt);
    if (createdAt !== undefined) tree.createdAtMs = createdAt;
    else if (header.createdAt !== undefined) putScalarExtra(tree.extras, 'session.createdAt', header.createdAt);
    // 信头里契约之外的字段原样保留。
    for (const [key, value] of Object.entries(header)) {
      if (CONSUMED_HEADER_KEYS.has(key)) continue;
      putScalarExtra(tree.extras, `session.${key}`, value);
    }
  }

  const supported = version !== undefined && version >= MIN_SUPPORTED_FORMAT_VERSION;
  if (!supported) {
    // R5：v3 及以下整文件跳过（计数不猜）：仍产出只含统计的会话树，无 turn/step。
    for (const raw of raws) {
      stats.inputRecords += raw.inputRecords;
      stats.badLines += raw.badLines;
      stats.frames += raw.frames;
      stats.failedFrames += raw.failedFrames;
      stats.skippedRecords += raw.inputRecords;
      if (raw.headerVersion !== undefined && raw.headerVersion < MIN_SUPPORTED_FORMAT_VERSION) {
        stats.skippedV3 += 1;
      } else if (raw.headerVersion === undefined) {
        // 文件里连信头都没有：不是可判版的会话，按解析错误计数（不猜版本）。
        stats.parseErrors += 1;
      }
      if (raw.header !== undefined) appendEventExtra(tree.extras, raw.header);
    }
    stats.producedSpans = 1;
    return tree;
  }

  const builder = new DshTreeBuilder(tree);
  let headerAccounted = false;
  for (const raw of raws) {
    stats.inputRecords += raw.inputRecords;
    stats.badLines += raw.badLines;
    stats.frames += raw.frames;
    stats.failedFrames += raw.failedFrames;

    if (raw.headerVersion === undefined) {
      stats.parseErrors += 1;
      stats.skippedRecords += raw.inputRecords;
      continue;
    }
    if (raw.headerVersion < MIN_SUPPORTED_FORMAT_VERSION) {
      // 同组里更低版本的镜像文件：只读最高 vN（DESIGN §5），整文件计跳过。
      stats.skippedV3 += 1;
      stats.skippedRecords += raw.inputRecords;
      continue;
    }
    if (raw.header !== undefined && raw.headerLine !== undefined) {
      if (!headerAccounted) {
        const ref: SourceRef = {
          file: raw.path,
          line: raw.headerLine,
          recordType: 'session',
        };
        tree.sourceRefs.push(ref);
        headerAccounted = true;
      } else {
        // 镜像副本的信头：计入去重（其余行由 seq 去重处理）。
        stats.deduped += 1;
        stats.skippedRecords += 1;
      }
    }
    stats.skippedRecords += raw.badLines;
    for (const record of raw.records) builder.dispatch(record);
  }
  builder.finalize();
  return tree;
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

/** 解析选项：帧级保护参数（见 frames.ts）。 */
export type DshParseOptions = FrameDecodeOptions;

/** 单会话身份（跨文件分组键）。 */
interface SessionGroupKey {
  sessionId: string;
  agentLabel: string;
}

function identityOf(raw: RawSessionFile): SessionGroupKey {
  const header = raw.header;
  const id = header !== undefined ? stringOrUndefined(header.id) : undefined;
  const origin = header !== undefined ? stringOrUndefined(header.origin) : undefined;
  return {
    sessionId: id ?? sessionIdFromFileName(raw.path),
    agentLabel: origin ?? 'main',
  };
}

/**
 * 解析一个 DSH 会话文件（或会话目录，取其中最高版本文件）→ 一棵会话树。
 * 坏行/坏帧/撕裂尾帧/未知事件只计数不抛；文件 IO 错误照常抛（调用方路径问题）。
 * 来源契约同 `resolveSessionSource`：物理只读盘，逻辑进输出（R4）。
 */
export function parseDshSession(
  source: string | SessionSource,
  options: DshParseOptions = {},
): SessionNode {
  const resolved = resolveSessionSource(source);
  const raw = readSessionFile(resolved, options);
  return buildSessionTree([raw]);
}

/**
 * 批量解析：按 (session_id, agent) 分组，同组镜像文件合到一棵树并按
 * `(session_id, seq)` 去重（DESIGN §5 镜像条款、R17）。组顺序 = 输入里首次出现顺序，
 * 保证确定性输出。不做任何目录扫描（调用方传什么算什么）。
 *
 * R8：单个文件读失败（路径不存在、不是 zstd、权限…）不中断整批——该路径单独产出一棵
 * 只含错误统计的空树（`extras.parse_error` + `stats.parseErrors=1`），其余文件照常解析。
 * 单文件入口 `parseDshSession` 保持严格：IO 错误照常抛，方便 CLI 判路径问题。
 */
export function parseDshSessions(
  sources: readonly (string | SessionSource)[],
  options: DshParseOptions = {},
): SessionNode[] {
  const errorTrees: Array<{ order: number; tree: SessionNode }> = [];
  const groups = new Map<string, RawSessionFile[]>();
  const groupOrder = new Map<string, number>();

  sources.forEach((source, order) => {
    let raw: RawSessionFile;
    try {
      raw = readSessionFile(resolveSessionSource(source), options);
    } catch (error) {
      // 错误树写逻辑路径：归档成员的临时目录名不得进输出（R4/R7）。
      const logical = asSessionSource(source).logicalPath;
      errorTrees.push({ order, tree: buildFileErrorTree(logical, error) });
      return;
    }
    const identity = identityOf(raw);
    const key = `${identity.sessionId}\u0000${identity.agentLabel}`;
    const bucket = groups.get(key);
    if (bucket === undefined) {
      groups.set(key, [raw]);
      groupOrder.set(key, order);
    } else {
      bucket.push(raw);
    }
  });

  const trees: Array<{ order: number; tree: SessionNode }> = [];
  for (const [key, bucket] of groups) {
    trees.push({ order: groupOrder.get(key) ?? 0, tree: buildSessionTree(bucket) });
  }
  trees.push(...errorTrees);
  // 按输入里首次出现的次序排序：错误树与正常树混排时也保持确定顺序。
  trees.sort((a, b) => a.order - b.order);
  return trees.map((item) => item.tree);
}

/** 单文件读失败时的占位树：只有一个错误计数，不猜任何语义（R8）。 */
function buildFileErrorTree(path: string, error: unknown): SessionNode {
  const stats = emptyStats();
  stats.parseErrors = 1;
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return {
    sourceRefs: [],
    extras: { parse_error: { path, message } },
    tool: DSH_TOOL_NAME,
    sessionId: sessionIdFromFileName(path),
    agentLabel: 'main',
    turns: [],
    stats,
  };
}
