/**
 * Claude Code 记录 → 会话树（DESIGN §4.3/§6/§9；t1 裁决 R2/R4/R9/R12）。
 *
 * 输入口径（DESIGN §6）：
 * - 按文件传 `projects/<项目目录>/*.jsonl`；`.orphaned-*` / `.superseded-*`
 *   重写副本整文件跳过（行数计 skippedRecords，R7），产物是一棵仅统计的空树。
 * - 2.1.3xx 一条 assistant 记录只装一个 content block、多条共享 message.id：
 *   按 message.id 聚合成一个 step，usage 仍只记一次（逐条累加会把 token 放大
 *   2–5 倍）。子 agent 文件里这些记录是**流式快照**：首条 output_tokens=0、
 *   缺 thinking/cache_creation，末条才是最终值（t9 修订 R2）。故取文件顺序
 *   **最后一条带 usage 的记录**；若末条 output_tokens 小于同 id 之前的最大值
 *   （乱序回退），改取 output_tokens 最大的那条。全部快照留在
 *   `extras.usageSnapshots` 待审，与权威条不一致的计入 stats.duplicateUsage。
 *   快照条数计入 stats.usageSnapshots。
 * - 用户消息切 turn；`message.content` 是块数组且含 tool_result 的 user 记录
 *   是结果回传，不开新 turn。
 * - `tool_use.id ↔ tool_result.tool_use_id` 配对；孤儿/重复结果合法，
 *   pairing 标 orphan_call / orphan_result / duplicate（组装层据此写
 *   `asu.pending_or_interrupted`）。
 * - `compact_boundary` 的 `parentUuid=null` 是重接：真实前驱在
 *   `logicalParentUuid`。边界标记落在紧随其后的 turn 上（compact=true），
 *   并把 logicalParentUuid 解析成 turn 序号，链不断（R9）。
 * - 无 `version` 记录不猜版本（DESIGN §6）：CC 版本是记录级 semver 字符串，
 *   SessionNode.formatVersion 是 number 不好无损表达，故留空；版本原文按出现
 *   顺序留在 `extras.versions`。
 * - 认不出的记录类型：原文进 `extras.unknownRecords` 并计入
 *   stats.unknownEventTypes；坏行只计数不抛（DESIGN §4.4）。
 *
 * 本模块不 import core/redact（脱敏唯一入口在组装层，t1 §6）。
 */

import { readFileSync } from 'node:fs';
import { sha256Hex } from '../core/ids.js';
import {
  asSessionSource,
  emptyStats,
  isoToUnixNano,
  msToUnixNano,
  type SessionNode,
  type SessionSource,
  type SourceRef,
  type Stats,
  type StepNode,
  type ToolNode,
  type TurnNode,
  type UnixNano,
  type Usage,
} from '../core/model.js';

/** 重写副本文件前缀（RESEARCH §3.3：会话发现要避开它们）。 */
const REWRITE_FILE_PREFIXES = ['.orphaned-', '.superseded-'] as const;

/**
 * 孤儿 tool_result 无 tool_use 可查时的占位工具名。它是显式未知标记，不是猜出来
 * 的工具名；配对的另一端若到达会据此认出「这条结果没有调用记录」。
 */
export const CC_PLACEHOLDER_TOOL_NAME = '(unknown)';

/** 记录信封里由会话/节点强类型槽吸收的键（不进 recordMeta，避免重复）。 */
const RECORD_CONSUMED_KEYS: ReadonlySet<string> = new Set([
  'type',
  'timestamp',
  'message',
  'sessionId',
  'cwd',
  'version',
  'isSidechain',
  'gitBranch',
  'userType',
  'entrypoint',
]);

/** message 信封里由 step 强类型槽吸收的键（其余原样进 extras.messageMeta）。 */
const MESSAGE_CONSUMED_KEYS: ReadonlySet<string> = new Set([
  'id',
  'type',
  'role',
  'model',
  'content',
  'usage',
  'stop_reason',
  'stop_sequence',
]);

/** 块排序键里「没有 apiBlockIndex」的基准值：有号的永远排前面，再按行号稳定排序。 */
const NO_BLOCK_INDEX_ORDER_BASE = 1_000_000_000;

/** sidechain agentLabel 前缀（t9 R4 修订：每文件唯一，文件名与 span key 都用它）。 */
const SIDECHAIN_LABEL_PREFIX = 'sidechain-';

/** agentLabel 长度上限：文件名 `<sessionId>__<agentLabel>.json` 保持可读。 */
const AGENT_LABEL_MAX_LENGTH = 64;

/** agentLabel 允许字符（Windows/跨平台文件名与 span key 都安全）。 */
const AGENT_LABEL_DISALLOWED = /[^A-Za-z0-9._-]/g;

/** 超长 agentId 截断后追加的 hash 长度：避免共享前缀的 id 截断后互撞。 */
const AGENT_LABEL_HASH_LENGTH = 8;

type RawRecord = Record<string, unknown>;

interface RecordTime {
  nano?: UnixNano;
  ms?: number;
}

interface BlockEntry {
  block: unknown;
  /** 排序键：apiBlockIndex（有号时）或 NO_BLOCK_INDEX_ORDER_BASE + 行号。 */
  orderKey: number;
  line: number;
}

interface MessageBase {
  [key: string]: unknown;
}

/** 一个 step 的聚合中间态：多条共享 message.id 的 assistant 记录汇入同一个。 */
interface StepState {
  step: StepNode;
  messageId?: string;
  /** 首条 message 的 id/type/role/model 原样（没有的键不补）。 */
  messageBase: MessageBase;
  blocks: BlockEntry[];
  contentStrings: string[];
  /** message.content 既不是数组也不是字符串时的原文（不丢字段）。 */
  rawContents: Array<{ line: number; content: unknown }>;
  /** 同一 message.id 的全部 usage 快照，按文件顺序（流式快照，R2 修订）。 */
  usages: Array<{ line: number; usage: RawRecord }>;
  stopReasonPresent: boolean;
  stopReasonValue?: unknown;
  stopSequencePresent: boolean;
  stopSequenceValue?: unknown;
  stopReasons: unknown[];
  stopSequences: unknown[];
  messageMeta: Array<Record<string, unknown>>;
  messageMissing: boolean;
}

interface CompactBoundaryState {
  ref: SourceRef;
  line: number;
  record: RawRecord;
  logicalParentUuid?: string;
  resumedFromTurnIndex?: number;
  uuid?: string;
}

/**
 * 该文件是否是 CC 的 `.orphaned-*` / `.superseded-*` 重写副本（整文件跳过）。
 *
 * 取文件名时**两种分隔符都认**：`node:path` 的 basename 按运行平台判，
 * POSIX 上 `C:\p\.orphaned-x.jsonl` 会把整个串当文件名（真实报错案例）。
 * 逻辑路径可能来自任意平台的归档成员，所以这里不依赖平台 path 实现。
 */
export function isCcSkippedSessionFile(filePath: string): boolean {
  const name = ccFileNameOf(filePath).toLowerCase();
  return REWRITE_FILE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** 取文件名（`/` 与 `\` 都当分隔符；不依赖运行平台）。 */
function ccFileNameOf(filePath: string): string {
  const cut = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return cut >= 0 ? filePath.slice(cut + 1) : filePath;
}

/**
 * 读一个 CC 会话文件并解析成会话树（t1 §2 契约入口）。
 *
 * 来源契约（t1 裁决 R4）：`physicalPath` 只用于读盘；`logicalPath` 进一切输出
 * （sessionId 回退、`extras.sessionFile`、agentLabel 的 hash 种子）。归档成员
 * 的逻辑路径形如 `<归档参数>!/<成员相对路径>`，临时目录名绝不进结果。
 * 字符串入参等价于 phys == logical（既有调用方零改动）。
 *
 * 重写副本不解析内容：仍读文件统计行数（R7 输入口径 = 文件行数），产一棵
 * 只带统计的空树，`skippedRecords` 等于行数。读取失败直接抛给调用方（index.ts
 * 负责按文件计数 parseErrors，R8）。
 */
export function parseCcSession(source: string | SessionSource): SessionNode {
  const resolved = asSessionSource(source);
  const text = readFileSync(resolved.physicalPath, 'utf8');
  if (isCcSkippedSessionFile(resolved.logicalPath)) {
    return buildSkippedTree(text, resolved.logicalPath);
  }
  return parseCcJsonl(text, resolved.logicalPath);
}

/** 仅统计的空树：重写副本、或将来整文件无法解析时的落点（不猜内容）。 */
function buildSkippedTree(text: string, logicalPath: string): SessionNode {
  const stats = emptyStats();
  const inputRecords = countRecords(text);
  stats.inputRecords = inputRecords;
  stats.skippedRecords = inputRecords;
  stats.producedSpans = 1; // 会话根 span 仍在（统计要挂根）
  return {
    tool: 'claude-code',
    sessionId: sessionIdFromFileName(logicalPath),
    agentLabel: 'main',
    sourceRefs: [],
    extras: { skippedRewriteFile: true },
    turns: [],
    stats,
  };
}

/**
 * 纯解析入口：jsonl 文本 + 来源路径 → 会话树（无文件 IO，便于合成记录测试）。
 * 第二参是**逻辑**来源路径（写入输出，见 `parseCcSession`）。
 */
export function parseCcJsonl(text: string, filePath: string): SessionNode {
  const normalized = text.replace(/^\uFEFF/, '');
  const lines = splitRecords(normalized);

  const stats = emptyStats();
  stats.inputRecords = lines.length;

  const session: SessionNode = {
    tool: 'claude-code',
    sessionId: sessionIdFromFileName(filePath),
    agentLabel: 'main',
    sourceRefs: [],
    extras: {},
    turns: [],
    stats,
  };

  /** 会话身份（记录级首次出现的值；null/缺失不覆盖）。 */
  let recordSessionId: string | undefined;
  let recordCwd: string | undefined;
  let recordAgentId: string | undefined;
  let recordGitBranch: string | undefined;
  let recordUserType: string | undefined;
  let recordEntrypoint: string | undefined;
  let recordSlug: string | undefined;
  let recordParentSession: string | undefined;
  let sidechainSeen = false;
  let earliestTimeMs: number | undefined;
  const versions: string[] = [];
  const sessionIds: string[] = [];

  const unknownRecords: Array<{
    line: number;
    recordType: string;
    record: RawRecord;
  }> = [];
  const orphanCompactBoundaries: Array<{ line: number; record: RawRecord }> = [];
  const stepStates: StepState[] = [];
  const toolsById = new Map<string, ToolNode>();
  const toolsWithResult = new Set<ToolNode>();
  const uuidToTurn = new Map<string, TurnNode>();

  let currentTurn: TurnNode | undefined;
  let currentTurnSteps = new Map<string, StepState>();
  let currentTurnEnd: UnixNano | undefined;
  let pendingInputs: unknown[] = [];
  let pendingCompact: CompactBoundaryState | undefined;

  // ── 小工具 ────────────────────────────────────────────────────────────────

  function noteTime(time: RecordTime): void {
    if (time.ms !== undefined) {
      if (earliestTimeMs === undefined || time.ms < earliestTimeMs) {
        earliestTimeMs = time.ms;
      }
    }
  }

  function touchTurn(nano: UnixNano | undefined): void {
    if (currentTurn === undefined || nano === undefined) return;
    if (currentTurnEnd === undefined || nano > currentTurnEnd) currentTurnEnd = nano;
  }

  function appendRecordMeta(
    extras: Record<string, unknown>,
    line: number,
    rest: Record<string, unknown>,
  ): void {
    if (Object.keys(rest).length === 0) return;
    const list = (extras['recordMeta'] as unknown[] | undefined) ?? [];
    list.push({ line, ...rest });
    extras['recordMeta'] = list;
  }

  function attachPendingCompact(turn: TurnNode): void {
    if (pendingCompact === undefined) return;
    const boundary = pendingCompact;
    pendingCompact = undefined;
    turn.compact = true;
    turn.extras['compactBoundary'] = true;
    turn.extras['compactRecord'] = boundary.record;
    const metadata = boundary.record['compactMetadata'];
    if (metadata !== undefined) turn.extras['compactMetadata'] = metadata;
    if (boundary.logicalParentUuid !== undefined) {
      turn.extras['logicalParentUuid'] = boundary.logicalParentUuid;
    }
    // parentUuid=null 本身是「重接而非删除」的证据，显式保留；键缺失则不造值。
    if ('parentUuid' in boundary.record) {
      turn.extras['compactParentUuid'] = boundary.record['parentUuid'];
    }
    if (boundary.resumedFromTurnIndex !== undefined) {
      turn.extras['resumedFromTurnIndex'] = boundary.resumedFromTurnIndex;
    } else {
      turn.extras['resumedFromTurnUnresolved'] = true;
    }
    turn.sourceRefs.push(boundary.ref);
    if (boundary.uuid !== undefined) uuidToTurn.set(boundary.uuid, turn);
  }

  function flushPendingCompact(): void {
    if (pendingCompact === undefined) return;
    const boundary = pendingCompact;
    pendingCompact = undefined;
    session.sourceRefs.push(boundary.ref);
    orphanCompactBoundaries.push({
      line: boundary.line,
      record: boundary.record,
    });
    session.extras['orphanCompactBoundaries'] = orphanCompactBoundaries;
  }

  function closeTurn(): void {
    if (currentTurn === undefined) return;
    const turn = currentTurn;
    const end = currentTurnEnd ?? turn.startTimeUnixNano;
    if (end !== undefined) turn.endTimeUnixNano = end;
    const lastStep = turn.steps[turn.steps.length - 1];
    const stopReason = lastStep?.extras['stopReason'];
    if (typeof stopReason === 'string') turn.endReason = stopReason;
    if (pendingInputs.length > 0) {
      turn.extras['unassignedInputMessages'] = pendingInputs;
      pendingInputs = [];
    }
    currentTurn = undefined;
    currentTurnSteps = new Map();
    currentTurnEnd = undefined;
  }

  function startTurn(
    extras: Record<string, unknown>,
    startNano: UnixNano | undefined,
  ): TurnNode {
    closeTurn();
    const turn: TurnNode = { sourceRefs: [], extras, steps: [] };
    if (startNano !== undefined) turn.startTimeUnixNano = startNano;
    currentTurn = turn;
    currentTurnSteps = new Map();
    currentTurnEnd = startNano;
    session.turns.push(turn);
    attachPendingCompact(turn);
    return turn;
  }

  function ensureAssistantTurn(startNano: UnixNano | undefined): TurnNode {
    if (currentTurn !== undefined) return currentTurn;
    return startTurn({ leadingAssistant: true }, startNano);
  }

  function ensureToolResultTurn(startNano: UnixNano | undefined): TurnNode {
    if (currentTurn !== undefined) return currentTurn;
    return startTurn({ leadingToolResult: true }, startNano);
  }

  /** 结果回传找不到对应 assistant 记录时，挂到当前 turn 最后一步（必要时建占位步）。 */
  function stepForOrphanResult(turn: TurnNode): StepNode {
    const lastStep = turn.steps[turn.steps.length - 1];
    if (lastStep !== undefined) return lastStep;
    const step: StepNode = {
      sourceRefs: [],
      extras: { orphanResultStep: true },
      tools: [],
    };
    turn.steps.push(step);
    return step;
  }

  function addToolUse(
    step: StepNode,
    block: RawRecord,
    startNano: UnixNano | undefined,
  ): void {
    const name = asString(block['name']);
    const toolCallId = asString(block['id']);
    const tool: ToolNode = {
      sourceRefs: [],
      extras: {},
      toolName: name ?? CC_PLACEHOLDER_TOOL_NAME,
      pairing: 'orphan_call',
    };
    if (name === undefined) tool.extras['toolNameMissing'] = true;
    if (toolCallId !== undefined) tool.toolCallId = toolCallId;
    const argsText = textOf(block['input']);
    if (argsText !== undefined) tool.argsText = argsText;
    if (startNano !== undefined) tool.startTimeUnixNano = startNano;
    if (toolCallId !== undefined) {
      if (toolsById.has(toolCallId)) {
        // 同一 id 出现两次调用：后一条不覆盖配对目标，标记待审，不丢。
        tool.extras['duplicateToolUseId'] = true;
      } else {
        toolsById.set(toolCallId, tool);
      }
    }
    step.tools.push(tool);
  }

  function setResult(
    tool: ToolNode,
    block: RawRecord,
    endNano: UnixNano | undefined,
  ): void {
    const resultText = textOf(block['content']);
    if (resultText !== undefined) tool.resultText = resultText;
    // Anthropic tool_result 的 is_error 省略即成功；有结果后写布尔值，
    // 没有结果（pending/interrupted）时保持 undefined，不伪造。
    tool.isError = block['is_error'] === true;
    tool.pairing = 'paired';
    if (endNano !== undefined) tool.endTimeUnixNano = endNano;
    toolsWithResult.add(tool);
  }

  function stepStateFor(
    turn: TurnNode,
    message: RawRecord | undefined,
    line: number,
    startNano: UnixNano | undefined,
  ): StepState {
    const messageId = message !== undefined ? asString(message['id']) : undefined;
    const key = messageId !== undefined ? `id:${messageId}` : `line:${line}`;
    const existing = currentTurnSteps.get(key);
    if (existing !== undefined) return existing;

    const step: StepNode = { sourceRefs: [], extras: {}, tools: [] };
    if (startNano !== undefined) {
      step.startTimeUnixNano = startNano;
      step.endTimeUnixNano = startNano;
    }
    const state: StepState = {
      step,
      messageBase: {},
      blocks: [],
      contentStrings: [],
      rawContents: [],
      usages: [],
      stopReasonPresent: false,
      stopSequencePresent: false,
      stopReasons: [],
      stopSequences: [],
      messageMeta: [],
      messageMissing: message === undefined,
    };
    if (messageId !== undefined) state.messageId = messageId;
    currentTurnSteps.set(key, state);
    stepStates.push(state);
    turn.steps.push(step);

    // 输入侧消息（prompt / 上一条 tool_result / compact summary）交给本 step；
    // 取走即清空，后续 step 只剩增量。
    if (pendingInputs.length > 0) {
      step.inputMessages = pendingInputs;
      pendingInputs = [];
    }
    return state;
  }

  // ── 各类记录 ──────────────────────────────────────────────────────────────

  function handleAssistant(
    record: RawRecord,
    line: number,
    ref: SourceRef,
    time: RecordTime,
  ): void {
    if (time.nano === undefined) stats.unknownTimes += 1;
    const turn = ensureAssistantTurn(time.nano);
    touchTurn(time.nano);
    const message = asRecord(record['message']);
    const state = stepStateFor(turn, message, line, time.nano);
    const step = state.step;

    step.sourceRefs.push(ref);
    if (time.nano !== undefined) {
      if (step.startTimeUnixNano === undefined || time.nano < step.startTimeUnixNano) {
        step.startTimeUnixNano = time.nano;
      }
      if (step.endTimeUnixNano === undefined || time.nano > step.endTimeUnixNano) {
        step.endTimeUnixNano = time.nano;
      }
    }
    appendRecordMeta(step.extras, line, withoutKeys(record, RECORD_CONSUMED_KEYS));

    if (message === undefined) {
      state.messageMissing = true;
      return;
    }

    // message 的 id/type/role/model：取首条原值，缺失不补。
    for (const key of ['id', 'type', 'role', 'model'] as const) {
      if (state.messageBase[key] === undefined && message[key] !== undefined) {
        state.messageBase[key] = message[key];
      }
    }
    const model = asString(message['model']);
    if (model !== undefined && step.model === undefined) step.model = model;

    const messageMeta = withoutKeys(message, MESSAGE_CONSUMED_KEYS);
    if (Object.keys(messageMeta).length > 0) {
      state.messageMeta.push({ line, ...messageMeta });
      step.extras['messageMeta'] = state.messageMeta;
    }

    const usage = asRecord(message['usage']);
    if (usage !== undefined) {
      // 流式快照：全部按文件顺序留存，权威条在收尾时统一挑选（R2 修订）。
      state.usages.push({ line, usage });
    }

    if ('stop_reason' in message) {
      const value = message['stop_reason'];
      if (!state.stopReasonPresent) {
        state.stopReasonPresent = true;
        state.stopReasonValue = value;
        state.stopReasons.push(value);
        if (typeof value === 'string') step.extras['stopReason'] = value;
      } else if (!deepEqual(state.stopReasonValue, value)) {
        if (!state.stopReasons.some((seen) => deepEqual(seen, value))) {
          state.stopReasons.push(value);
        }
        step.extras['stopReasonValues'] = state.stopReasons;
      }
    }
    if ('stop_sequence' in message) {
      const value = message['stop_sequence'];
      if (!state.stopSequencePresent) {
        state.stopSequencePresent = true;
        state.stopSequenceValue = value;
        state.stopSequences.push(value);
      } else if (!deepEqual(state.stopSequenceValue, value)) {
        if (!state.stopSequences.some((seen) => deepEqual(seen, value))) {
          state.stopSequences.push(value);
        }
        step.extras['stopSequenceValues'] = state.stopSequences;
      }
    }

    const content = message['content'];
    const apiBlockIndex = asFiniteNumber(record['apiBlockIndex']);
    const orderKey =
      apiBlockIndex ?? NO_BLOCK_INDEX_ORDER_BASE + line;
    if (Array.isArray(content)) {
      for (const block of content) {
        state.blocks.push({ block, orderKey, line });
        const blockRecord = asRecord(block);
        if (blockRecord !== undefined && blockRecord['type'] === 'tool_use') {
          addToolUse(step, blockRecord, time.nano);
        }
      }
    } else if (typeof content === 'string') {
      state.contentStrings.push(content);
    } else if (content !== undefined) {
      state.rawContents.push({ line, content });
      step.extras['contentRaw'] = state.rawContents;
    }
  }

  function handlePrompt(
    record: RawRecord,
    line: number,
    ref: SourceRef,
    time: RecordTime,
  ): void {
    if (time.nano === undefined) stats.unknownTimes += 1;
    const turn = startTurn({}, time.nano);
    turn.sourceRefs.push(ref);
    appendRecordMeta(turn.extras, line, withoutKeys(record, RECORD_CONSUMED_KEYS));
    if (record['isCompactSummary'] === true) turn.extras['compactSummary'] = true;

    const message = asRecord(record['message']);
    pendingInputs = message !== undefined ? [message] : [];
    if (message === undefined) turn.extras['userMessageMissing'] = true;

    const uuid = asString(record['uuid']);
    if (uuid !== undefined) uuidToTurn.set(uuid, turn);
  }

  function handleToolResults(
    record: RawRecord,
    line: number,
    ref: SourceRef,
    time: RecordTime,
  ): void {
    if (time.nano === undefined) stats.unknownTimes += 1;
    const turn = ensureToolResultTurn(time.nano);
    touchTurn(time.nano);
    const message = asRecord(record['message']);
    const content = message !== undefined ? message['content'] : undefined;
    const blocks = Array.isArray(content)
      ? content.filter((block): block is RawRecord => asRecord(block) !== undefined)
      : [];
    const resultBlocks = blocks.filter((block) => block['type'] === 'tool_result');

    // 记录信封（toolUseResult / sourceToolAssistantUUID / permissionDecision…）
    // 挂在第一条结果所属工具上，且只挂一次；来源序号也只记一次（条数守恒）。
    const recordMeta = withoutKeys(record, RECORD_CONSUMED_KEYS);
    let refOwner: ToolNode | undefined;

    for (const block of resultBlocks) {
      const toolUseId = asString(block['tool_use_id']);
      const tool = toolUseId !== undefined ? toolsById.get(toolUseId) : undefined;
      if (tool !== undefined) {
        if (!toolsWithResult.has(tool)) {
          setResult(tool, block, time.nano);
        } else {
          // 重复结果合法：首条结果留作 resultText，后到的原文进 extras 待审。
          tool.pairing = 'duplicate';
          const duplicates =
            (tool.extras['duplicateResults'] as unknown[] | undefined) ?? [];
          duplicates.push({
            line,
            tool_use_id: toolUseId,
            content: block['content'],
            is_error: block['is_error'],
          });
          tool.extras['duplicateResults'] = duplicates;
          if (
            time.nano !== undefined &&
            (tool.endTimeUnixNano === undefined || time.nano > tool.endTimeUnixNano)
          ) {
            tool.endTimeUnixNano = time.nano;
          }
        }
        refOwner ??= tool;
        continue;
      }

      // 孤儿结果：没有对应 tool_use，建独立工具节点（不猜工具名，用占位标记）。
      const step = stepForOrphanResult(turn);
      const orphan: ToolNode = {
        sourceRefs: [],
        extras: { orphanResult: true },
        toolName: CC_PLACEHOLDER_TOOL_NAME,
        pairing: 'orphan_result',
      };
      if (toolUseId !== undefined) orphan.toolCallId = toolUseId;
      const resultText = textOf(block['content']);
      if (resultText !== undefined) orphan.resultText = resultText;
      orphan.isError = block['is_error'] === true;
      if (time.nano !== undefined) {
        orphan.startTimeUnixNano = time.nano;
        orphan.endTimeUnixNano = time.nano;
      }
      step.tools.push(orphan);
      refOwner ??= orphan;
    }

    if (refOwner !== undefined) {
      refOwner.sourceRefs.push(ref);
      if (Object.keys(recordMeta).length > 0) {
        appendRecordMeta(refOwner.extras, line, recordMeta);
      }
    }
    // 结果回传是下一轮 step 的输入侧消息（原文保留）。
    if (message !== undefined) pendingInputs.push(message);
  }

  function handleCompactBoundary(
    record: RawRecord,
    line: number,
    ref: SourceRef,
  ): void {
    flushPendingCompact();
    const logicalParentUuid = asString(record['logicalParentUuid']);
    const uuid = asString(record['uuid']);
    const boundary: CompactBoundaryState = { ref, record, line };
    if (logicalParentUuid !== undefined) {
      boundary.logicalParentUuid = logicalParentUuid;
      const parentTurn = uuidToTurn.get(logicalParentUuid);
      if (parentTurn !== undefined) {
        boundary.resumedFromTurnIndex = session.turns.indexOf(parentTurn);
      }
    }
    if (uuid !== undefined) boundary.uuid = uuid;
    pendingCompact = boundary;
    // 记录全部字段随 compactRecord 保留在接上的 turn 上，等下一个 turn 落位。
  }

  function handleUnknown(
    record: RawRecord,
    line: number,
    ref: SourceRef,
    typeKey: string,
  ): void {
    stats.unknownEventTypes[typeKey] = (stats.unknownEventTypes[typeKey] ?? 0) + 1;
    session.sourceRefs.push(ref);
    unknownRecords.push({ line, recordType: typeKey, record });
    session.extras['unknownRecords'] = unknownRecords;
  }

  function processRecord(record: RawRecord, line: number): void {
    const type = asString(record['type']);
    const recordType = type ?? '(missing)';
    const ref: SourceRef = { file: filePath, line, recordType };
    const time = readTime(record);
    noteTime(time);

    // 会话级身份字段（记录级首次值；null/缺失不覆盖）。
    const sessionId = asString(record['sessionId']);
    if (sessionId !== undefined) {
      recordSessionId ??= sessionId;
      if (!sessionIds.includes(sessionId)) sessionIds.push(sessionId);
    }
    recordCwd ??= asString(record['cwd']);
    recordAgentId ??= asString(record['agentId']);
    recordGitBranch ??= asString(record['gitBranch']);
    recordUserType ??= asString(record['userType']);
    recordEntrypoint ??= asString(record['entrypoint']);
    recordSlug ??= asString(record['slug']);
    recordParentSession ??= asString(record['parentSession']);
    if (record['isSidechain'] === true) sidechainSeen = true;
    const version = asString(record['version']);
    if (version !== undefined && !versions.includes(version)) versions.push(version);

    switch (recordType) {
      case 'assistant':
        handleAssistant(record, line, ref, time);
        break;
      case 'user': {
        const message = asRecord(record['message']);
        const content = message !== undefined ? message['content'] : undefined;
        const isToolResult =
          Array.isArray(content) &&
          content.some((block) => {
            const blockRecord = asRecord(block);
            return blockRecord !== undefined && blockRecord['type'] === 'tool_result';
          });
        if (isToolResult) handleToolResults(record, line, ref, time);
        else handlePrompt(record, line, ref, time);
        break;
      }
      case 'system': {
        const subtype = asString(record['subtype']);
        if (subtype === 'compact_boundary') {
          handleCompactBoundary(record, line, ref);
        } else {
          handleUnknown(record, line, ref, subtype !== undefined ? `system/${subtype}` : 'system');
        }
        break;
      }
      default:
        handleUnknown(record, line, ref, recordType);
        break;
    }

    const uuid = asString(record['uuid']);
    if (uuid !== undefined && currentTurn !== undefined) {
      uuidToTurn.set(uuid, currentTurn);
    }
  }

  // ── 主循环 ────────────────────────────────────────────────────────────────

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.text);
    } catch {
      stats.badLines += 1;
      stats.skippedRecords += 1;
      continue;
    }
    const record = asRecord(parsed);
    if (record === undefined) {
      stats.badLines += 1;
      stats.skippedRecords += 1;
      continue;
    }
    processRecord(record, line.number);
  }

  // ── 收尾：关 turn、装配聚合 step、会话身份与统计 ───────────────────────────

  closeTurn();
  flushPendingCompact();
  finishSteps(stepStates, stats);

  if (recordSessionId !== undefined) session.sessionId = recordSessionId;
  else session.extras['session_id_source'] = 'filename';
  if (recordCwd !== undefined) session.cwd = recordCwd;
  if (recordAgentId !== undefined) session.extras['agentId'] = recordAgentId;
  if (recordParentSession !== undefined) session.extras['parentSession'] = recordParentSession;
  if (recordGitBranch !== undefined) session.extras['gitBranch'] = recordGitBranch;
  if (recordUserType !== undefined) session.extras['userType'] = recordUserType;
  if (recordEntrypoint !== undefined) session.extras['entrypoint'] = recordEntrypoint;
  if (recordSlug !== undefined) session.extras['slug'] = recordSlug;
  // 来源路径是 sidechain 唯一化与排障的凭据，始终保留（t9 要求）；只写逻辑
  // 路径，归档成员的临时目录名不得进输出（R4/R6）。
  session.extras['sessionFile'] = filePath;
  if (versions.length > 0) session.extras['versions'] = versions;
  if (sessionIds.length > 1) session.extras['sessionIds'] = sessionIds;
  if (sidechainSeen) {
    // t9 R4 修订：sidechain 文件共享父 sessionId，agentLabel 必须每文件唯一。
    // 有 agentId 用它（同一 agent 跨文件稳定）；没有则用文件名 stem；二者都
    // 清洗成文件安全字符并限制长度，超长追加稳定 hash 防截断互撞。
    if (recordAgentId !== undefined) {
      session.agentLabel = buildSidechainLabel(recordAgentId, recordAgentId);
      session.extras['agentLabelSource'] = 'agentId';
    } else {
      const fileStem = sessionIdFromFileName(filePath);
      // hash 种子也用逻辑路径：物理路径带 mkdtemp 目录名，会让同一归档两次
      // 运行产出不同 agentLabel（进而改变 span id 与文件名，R4）。
      session.agentLabel = buildSidechainLabel(fileStem, filePath);
      session.extras['agentLabelSource'] = 'fileStem';
    }
  }
  if (earliestTimeMs !== undefined) session.createdAtMs = earliestTimeMs;

  let stepCount = 0;
  let toolCount = 0;
  let unpairedTools = 0;
  for (const turn of session.turns) {
    stepCount += turn.steps.length;
    for (const step of turn.steps) {
      toolCount += step.tools.length;
      for (const tool of step.tools) {
        if (tool.pairing !== 'paired') unpairedTools += 1;
      }
    }
  }
  stats.producedSpans = 1 + session.turns.length + stepCount + toolCount;
  stats.unpairedTools = unpairedTools;

  return session;
}

/**
 * 结束所有 step 的聚合：content 排序、outputMessages 装配、usage 权威快照挑选。
 *
 * usage（R2 修订，t9）：同一 message.id 的多条记录是流式快照，权威条取文件顺序
 * 最后一条带 usage 的；若末条 output_tokens 小于同 id 之前的最大值（乱序回退），
 * 改取最大值那条。全部快照留 extras，只映射一次、不重复计账。
 */
function finishSteps(stepStates: StepState[], stats: Stats): void {
  for (const state of stepStates) {
    const step = state.step;
    const orderedBlocks = [...state.blocks].sort(
      (a, b) => a.orderKey - b.orderKey || a.line - b.line,
    );
    const message: RawRecord = { ...state.messageBase };
    if (orderedBlocks.length > 0) {
      message['content'] = orderedBlocks.map((entry) => entry.block);
    } else if (state.contentStrings.length === 1) {
      message['content'] = state.contentStrings[0];
    } else if (state.contentStrings.length > 1) {
      message['content'] = state.contentStrings;
    }
    if (state.stopReasonPresent) message['stop_reason'] = state.stopReasonValue;
    if (state.stopSequencePresent) message['stop_sequence'] = state.stopSequenceValue;
    if (Object.keys(message).length > 0) {
      step.outputMessages = [message];
    }
    if (state.messageMissing) step.extras['messageMissing'] = true;

    if (state.usages.length > 0) {
      const authoritativeIndex = chooseAuthoritativeUsage(state.usages);
      const authoritative = state.usages[authoritativeIndex];
      if (authoritative !== undefined) {
        const mapped = mapUsage(authoritative.usage);
        if (mapped !== undefined) step.usage = mapped;
        // 权威条原文 + 全部快照（含权威标记），不丢任何一次观测。
        step.extras['usageRaw'] = authoritative.usage;
        step.extras['usageSnapshots'] = state.usages.map((snapshot, index) => ({
          line: snapshot.line,
          usage: snapshot.usage,
          authoritative: index === authoritativeIndex,
        }));
        stats.usageSnapshots += state.usages.length;
        for (const [index, snapshot] of state.usages.entries()) {
          if (index === authoritativeIndex) continue;
          if (!deepEqual(snapshot.usage, authoritative.usage)) {
            stats.duplicateUsage += 1;
          }
        }
      }
    }
  }
}

/**
 * 挑选权威 usage 快照（R2 修订）。返回在 usages 中的下标；空数组返回 -1。
 * - 默认取文件顺序最后一条；
 * - 末条 output_tokens 缺失或小于同 id 历史最大值 → 取最大值那条（并列取最晚）。
 */
function chooseAuthoritativeUsage(
  usages: Array<{ line: number; usage: RawRecord }>,
): number {
  const lastIndex = usages.length - 1;
  const lastOutput = outputTokensOf(usages[lastIndex]?.usage);
  let maxOutput = -1;
  let maxIndex = -1;
  for (let index = 0; index < usages.length; index += 1) {
    const value = outputTokensOf(usages[index]?.usage);
    if (value !== undefined && value >= maxOutput) {
      maxOutput = value;
      maxIndex = index;
    }
  }
  if (maxIndex !== -1 && (lastOutput === undefined || maxOutput > lastOutput)) {
    return maxIndex;
  }
  return lastIndex;
}

function outputTokensOf(usage: RawRecord | undefined): number | undefined {
  return usage === undefined ? undefined : asNonNegativeInt(usage['output_tokens']);
}

/** 清洗 agentLabel 片段：保留 [A-Za-z0-9._-]，其余替换为下划线。 */
function sanitizeAgentLabelPart(value: string): string {
  return value.replace(AGENT_LABEL_DISALLOWED, '_');
}

/**
 * 生成每文件唯一的 sidechain agentLabel（t9 R4 修订）。
 * 超长时截断并追加来源的稳定 hash，避免共享前缀的 agentId 截断后互撞。
 */
function buildSidechainLabel(source: string, hashSeed: string): string {
  const sanitized = sanitizeAgentLabelPart(source);
  const budget = AGENT_LABEL_MAX_LENGTH - SIDECHAIN_LABEL_PREFIX.length;
  if (sanitized.length <= budget && sanitized.length > 0) {
    return `${SIDECHAIN_LABEL_PREFIX}${sanitized}`;
  }
  const hash = sha256Hex(hashSeed).slice(0, AGENT_LABEL_HASH_LENGTH);
  const kept = sanitized.slice(0, budget - AGENT_LABEL_HASH_LENGTH - 1);
  return `${SIDECHAIN_LABEL_PREFIX}${kept.length > 0 ? `${kept}-` : ''}${hash}`;
}

/** usage 字段映射（R1）：CC 实测字段 → 统一口径；非负整数校验失败不进强类型槽。 */
function mapUsage(raw: RawRecord): Usage | undefined {
  const usage: Usage = {};
  const input = asNonNegativeInt(raw['input_tokens']);
  if (input !== undefined) usage.inputTokens = input;
  const output = asNonNegativeInt(raw['output_tokens']);
  if (output !== undefined) usage.outputTokens = output;
  const details = asRecord(raw['output_tokens_details']);
  const thinking =
    details !== undefined ? asNonNegativeInt(details['thinking_tokens']) : undefined;
  if (thinking !== undefined) usage.reasoningTokens = thinking;
  const cacheRead = asNonNegativeInt(raw['cache_read_input_tokens']);
  if (cacheRead !== undefined) usage.cacheReadTokens = cacheRead;
  const cacheWrite = asNonNegativeInt(raw['cache_creation_input_tokens']);
  if (cacheWrite !== undefined) usage.cacheWriteTokens = cacheWrite;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

// ── 通用纯函数 ──────────────────────────────────────────────────────────────

function asRecord(value: unknown): RawRecord | undefined {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as RawRecord;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asNonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/** 原文转文本：字符串原样；其余结构 JSON 序列化（不截断）；undefined 不造值。 */
function textOf(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  const json = JSON.stringify(value);
  return json === undefined ? undefined : json;
}

function withoutKeys(record: RawRecord, consumed: ReadonlySet<string>): RawRecord {
  const out: RawRecord = {};
  for (const [key, value] of Object.entries(record)) {
    if (!consumed.has(key)) out[key] = value;
  }
  return out;
}

/** 记录自带时间（CC 是 ISO 字符串；容忍 epoch 毫秒数字）。解析失败返回空。 */
function readTime(record: RawRecord): RecordTime {
  const value = record['timestamp'];
  if (typeof value === 'string') {
    const nano = isoToUnixNano(value);
    if (nano === undefined) return {};
    const ms = Date.parse(value);
    return { nano, ms };
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { nano: msToUnixNano(value), ms: value };
  }
  return {};
}

/** 拆行：空行不算记录（R7 输入口径 = 非空行行数），行号保持文件物理行号。 */
function splitRecords(text: string): Array<{ text: string; number: number }> {
  const out: Array<{ text: string; number: number }> = [];
  const raw = text.split(/\r?\n/);
  for (let index = 0; index < raw.length; index += 1) {
    const line = raw[index] ?? '';
    if (line.trim() === '') continue;
    out.push({ text: line, number: index + 1 });
  }
  return out;
}

function countRecords(text: string): number {
  return splitRecords(text).length;
}

function sessionIdFromFileName(filePath: string): string {
  // 同一理由（见 isCcSkippedSessionFile）：逻辑路径可能带 Windows 分隔符。
  const name = ccFileNameOf(filePath);
  const stem = name.replace(/\.jsonl$/i, '');
  return stem.length > 0 ? stem : name;
}

/** 结构相等的确定性比较（只用于 JSON 值：usage / stop_reason 等审计）。 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  const recordA = asRecord(a);
  const recordB = asRecord(b);
  if (recordA !== undefined && recordB !== undefined) {
    const keysA = Object.keys(recordA);
    const keysB = Object.keys(recordB);
    if (keysA.length !== keysB.length) return false;
    return keysA.every(
      (key) => Object.prototype.hasOwnProperty.call(recordB, key) && deepEqual(recordA[key], recordB[key]),
    );
  }
  return false;
}
