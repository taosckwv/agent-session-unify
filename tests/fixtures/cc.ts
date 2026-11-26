/**
 * Claude Code 会话集成测试夹具（tests/fixtures/cc.ts）。
 *
 * 约束（AGENTS.md 数据纪律）：
 * - 全部为**合成**记录；不含真实会话内容/真实凭据。凭据形字符串只用于
 *   验证脱敏（tests/integration/redaction.test.ts），且都是公开文档里的
 *   示例形态，不是可用凭据；
 * - 不落盘 `.jsonl`（.gitignore 会吞掉），只导出内存对象，由
 *   tests/integration/helpers.ts 在运行时写临时目录；
 * - 不 import src/，避免用实现验证实现。
 */

export type JsonObject = Record<string, unknown>;

/** 夹具时间基准：2026-11-25T03:00:00Z 起每秒一条。 */
export const CC_FIXTURE_BASE_MS = Date.UTC(2026, 10, 25, 3, 0, 0);

/** 第 second 秒的 ISO 时间串（CC 记录自带字段）。 */
export function ccTimestamp(second: number): string {
  return new Date(CC_FIXTURE_BASE_MS + second * 1000).toISOString();
}

/** 每条记录共享的信封字段。 */
export function ccEnvelope(overrides: JsonObject = {}): JsonObject {
  return {
    sessionId: 'cc-fixture-main',
    cwd: 'C:\\fixture\\cc-proj',
    version: '2.1.303',
    isSidechain: false,
    userType: 'external',
    entrypoint: 'cli',
    gitBranch: 'main',
    ...overrides,
  };
}

export interface CcUseOptions {
  uuid: string;
  timestamp?: string | null;
  extra?: JsonObject;
}

/** 用户提示记录（非 tool_result → 开新 turn）。 */
export function ccPrompt(content: unknown, options: CcUseOptions): JsonObject {
  const record: JsonObject = {
    ...ccEnvelope(),
    type: 'user',
    message: { role: 'user', content },
    uuid: options.uuid,
    ...(options.extra ?? {}),
  };
  if (options.timestamp !== null && options.timestamp !== undefined) record.timestamp = options.timestamp;
  return record;
}

export interface CcToolResultOptions extends CcUseOptions {
  isError?: boolean;
}

/** 工具结果记录（message.content 是 tool_result 块 → 不开 turn）。 */
export function ccToolResult(
  toolUseId: string,
  content: unknown,
  options: CcToolResultOptions,
): JsonObject {
  const block: JsonObject = { type: 'tool_result', tool_use_id: toolUseId, content };
  if (options.isError !== undefined) block.is_error = options.isError;
  return ccPrompt([block], options) as JsonObject;
}

export interface CcAssistantOptions {
  uuid: string;
  /** message.id：同 id 的多条记录聚成一个 step（R2 修订）。 */
  messageId: string;
  blocks: unknown[];
  /** 该条记录自带的 usage 快照；省略 = 这条记录没有 usage。 */
  usage?: JsonObject;
  /** content 数组里该块的 apiBlockIndex（决定块顺序）。 */
  apiBlockIndex?: number;
  model?: string;
  stopReason?: string | null;
  timestamp?: string | null;
  parentUuid?: string | null;
  extra?: JsonObject;
}

/** assistant 记录（一条记录 = message 的一个流式快照/一个 content block 片段）。 */
export function ccAssistant(options: CcAssistantOptions): JsonObject {
  const message: JsonObject = {
    id: options.messageId,
    type: 'message',
    role: 'assistant',
    model: options.model ?? 'cc-fixture-model',
    content: options.blocks,
    stop_reason: options.stopReason ?? null,
    stop_sequence: null,
  };
  if (options.usage !== undefined) message.usage = options.usage;
  const record: JsonObject = {
    ...ccEnvelope(),
    type: 'assistant',
    message,
    uuid: options.uuid,
    ...(options.extra ?? {}),
  };
  if (options.apiBlockIndex !== undefined) record.apiBlockIndex = options.apiBlockIndex;
  if (options.timestamp !== null && options.timestamp !== undefined) record.timestamp = options.timestamp;
  if (options.parentUuid !== undefined) record.parentUuid = options.parentUuid;
  return record;
}

/** compact_boundary 记录（parentUuid=null 表示重接，真实前驱在 logicalParentUuid）。 */
export function ccCompactBoundary(options: {
  uuid: string;
  logicalParentUuid: string;
  timestamp?: string | null;
  metadata?: JsonObject;
}): JsonObject {
  const record: JsonObject = {
    ...ccEnvelope(),
    type: 'system',
    subtype: 'compact_boundary',
    uuid: options.uuid,
    parentUuid: null,
    logicalParentUuid: options.logicalParentUuid,
  };
  if (options.timestamp !== null && options.timestamp !== undefined) record.timestamp = options.timestamp;
  if (options.metadata !== undefined) record.compactMetadata = options.metadata;
  return record;
}

/** 无法识别类型的记录（必须原样保留并计数，不得丢弃）。 */
export function ccUnknownRecord(extra: JsonObject = {}): JsonObject {
  return {
    ...ccEnvelope(),
    type: 'mystery_fixture',
    note: 'keep-me-untouched',
    timestamp: ccTimestamp(5),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// 场景 1：主会话（usage 最终快照 / 块排序 / 工具配对 / 未知记录 / 坏行）
// ---------------------------------------------------------------------------

/** R2 修订：同 message.id 两条 usage 快照，首条 output=0（流式中间态），末条才是最终值。 */
export const CC_FIXTURE_USAGE_FIRST: JsonObject = {
  input_tokens: 100,
  output_tokens: 0,
  cache_read_input_tokens: 10,
  cache_creation_input_tokens: 3,
};

export const CC_FIXTURE_USAGE_FINAL: JsonObject = {
  input_tokens: 100,
  output_tokens: 60,
  cache_read_input_tokens: 10,
  cache_creation_input_tokens: 3,
  output_tokens_details: { thinking_tokens: 5 },
};

/**
 * 主会话记录（7 行）：prompt / assistant(msg-1, block 0) / assistant(msg-1, block 1,
 * tool_use) / tool_result / assistant(msg-2) / 未知记录 / 坏行。
 *
 * 预期输出：1 turn / 2 step / 1 tool = 4 个四层 span；
 * input_records=7、skipped_records=1（坏行）、bad_lines=1；
 * step1 权威 usage output_tokens=60，usage_snapshots=2、duplicate_usage=1。
 */
export function ccMainRecords(): Array<JsonObject | string> {
  return [
    ccPrompt([{ type: 'text', text: '请读取 a.txt' }], { uuid: 'u1', timestamp: ccTimestamp(0) }),
    ccAssistant({
      uuid: 'a1',
      messageId: 'msg-1',
      blocks: [{ type: 'thinking', thinking: '想一想' }],
      apiBlockIndex: 0,
      usage: CC_FIXTURE_USAGE_FIRST,
      stopReason: 'tool_use',
      timestamp: ccTimestamp(1),
    }),
    ccAssistant({
      uuid: 'a2',
      messageId: 'msg-1',
      blocks: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: { path: 'a.txt' } }],
      apiBlockIndex: 1,
      usage: CC_FIXTURE_USAGE_FINAL,
      stopReason: 'tool_use',
      timestamp: ccTimestamp(2),
      parentUuid: 'a1',
    }),
    ccToolResult('call-1', '文件内容', { uuid: 'u2', timestamp: ccTimestamp(3) }),
    ccAssistant({
      uuid: 'a3',
      messageId: 'msg-2',
      blocks: [{ type: 'text', text: '完成' }],
      apiBlockIndex: 0,
      usage: { input_tokens: 120, output_tokens: 8 },
      stopReason: 'end_turn',
      timestamp: ccTimestamp(4),
    }),
    ccUnknownRecord(),
    '{ this is not json',
  ];
}

// ---------------------------------------------------------------------------
// 场景 2：compact_boundary 重接（R9）
// ---------------------------------------------------------------------------

/**
 * turn1（u1/a1）→ compact_boundary（parentUuid=null，logicalParentUuid=u1）→ turn2（u2/a2）。
 * 预期：turn2 span 带 asu.turn.compact=true，extras 里 resumedFromTurnIndex=0、
 * compactParentUuid=null（键存在、值为 null，是证据而不是删除）。
 */
export function ccCompactRecords(): JsonObject[] {
  return [
    ccPrompt([{ type: 'text', text: '压缩前问题' }], { uuid: 'u1', timestamp: ccTimestamp(0) }),
    ccAssistant({
      uuid: 'a1',
      messageId: 'msg-1',
      blocks: [{ type: 'text', text: '压缩前回答' }],
      apiBlockIndex: 0,
      usage: { input_tokens: 10, output_tokens: 4 },
      stopReason: 'end_turn',
      timestamp: ccTimestamp(1),
    }),
    ccCompactBoundary({
      uuid: 'b1',
      logicalParentUuid: 'u1',
      timestamp: ccTimestamp(2),
      metadata: { trigger: 'auto', preTokens: 1234 },
    }),
    ccPrompt([{ type: 'text', text: '压缩后问题' }], { uuid: 'u2', timestamp: ccTimestamp(3) }),
    ccAssistant({
      uuid: 'a2',
      messageId: 'msg-2',
      blocks: [{ type: 'text', text: '压缩后回答' }],
      apiBlockIndex: 0,
      usage: { input_tokens: 11, output_tokens: 5 },
      stopReason: 'end_turn',
      timestamp: ccTimestamp(4),
    }),
  ];
}

// ---------------------------------------------------------------------------
// 场景 3：脱敏（只放 V1 规则覆盖得到的位置；中段凭据的已知限制单独记录）
// ---------------------------------------------------------------------------

/**
 * 覆盖位置：提示正文（sk-/JWT 前缀）、工具结果（AKIA/…）、recordMeta 里的
 * password 字段（字段名规则）；同时放入必须保留的中文正文与路径。
 * **不放** tool_use.input 里的凭据：argsText 是 JSON 串（以 `{` 开头），
 * V1 前缀规则覆盖不到，属 DESIGN §8 已知风险，不当泄露缺陷。
 */
export function ccRedactionRecords(): JsonObject[] {
  return [
    ccPrompt(
      [
        { type: 'text', text: 'sk-live-ABCDEFGHIJKLMNOPQRSTUVWX' },
        { type: 'text', text: '请保留这段中文' },
        { type: 'text', text: 'JWT eyJhbGciOiJIUzI1NiJ9.payload.signature' },
      ],
      { uuid: 'u1', timestamp: ccTimestamp(0), extra: { password: 'hunter2-fixture', note: 'keep note' } },
    ),
    ccAssistant({
      uuid: 'a1',
      messageId: 'msg-1',
      blocks: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: { path: 'a.txt' } }],
      apiBlockIndex: 0,
      usage: { input_tokens: 10, output_tokens: 5 },
      stopReason: 'tool_use',
      timestamp: ccTimestamp(1),
    }),
    ccToolResult('call-1', 'AKIAIOSFODNN7EXAMPLE', { uuid: 'u2', timestamp: ccTimestamp(2) }),
    ccAssistant({
      uuid: 'a2',
      messageId: 'msg-2',
      blocks: [{ type: 'text', text: 'Bearer abcdefghijklmnopqrstuvwx' }],
      apiBlockIndex: 0,
      usage: { input_tokens: 12, output_tokens: 3 },
      stopReason: 'end_turn',
      timestamp: ccTimestamp(3),
    }),
    ccAssistant({
      uuid: 'a3',
      messageId: 'msg-3',
      blocks: [{ type: 'text', text: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' }],
      apiBlockIndex: 0,
      usage: { input_tokens: 13, output_tokens: 2 },
      timestamp: ccTimestamp(4),
    }),
    ccAssistant({
      uuid: 'a4',
      messageId: 'msg-4',
      blocks: [{ type: 'text', text: 'xoxb-1234567890-abcdefghij' }],
      apiBlockIndex: 0,
      usage: { input_tokens: 14, output_tokens: 1 },
      timestamp: ccTimestamp(5),
    }),
  ];
}

// ---------------------------------------------------------------------------
// 场景 4：全无时间戳（回填 0 + unknown_times 计数）
// ---------------------------------------------------------------------------

export function ccNoTimeRecords(): JsonObject[] {  return [
    ccPrompt([{ type: 'text', text: '无时间提示' }], { uuid: 'u1', timestamp: null }),
    ccAssistant({
      uuid: 'a1',
      messageId: 'msg-1',
      blocks: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: { path: 'a.txt' } }],
      apiBlockIndex: 0,
      usage: { input_tokens: 10, output_tokens: 5 },
      timestamp: null,
    }),
    ccToolResult('call-1', '无时间结果', { uuid: 'u2', timestamp: null }),
    ccAssistant({
      uuid: 'a2',
      messageId: 'msg-2',
      blocks: [{ type: 'text', text: '无时间回答' }],
      apiBlockIndex: 0,
      usage: { input_tokens: 11, output_tokens: 6 },
      timestamp: null,
    }),
  ];
}

// ---------------------------------------------------------------------------
// 场景 5：sidechain 子 agent（R4 修订：同名 sessionId 的多文件必须互不覆盖）
// ---------------------------------------------------------------------------

/**
 * 子 agent 会话记录（isSidechain=true，带 agentId）。
 *
 * 同一 sessionId 可以对应多个 subagent 文件（真实数据里确实如此），
 * 解析层必须用 `sidechain-<agentId>` 生成唯一 agentLabel，
 * 否则输出文件名与 spanId 会互相覆盖（t9 修补点）。
 */
export function ccSidechainRecords(agentId: string, sessionId = 'cc-fixture-shared'): JsonObject[] {
  const extra = { isSidechain: true, agentId, sessionId };
  return [
    ccPrompt([{ type: 'text', text: `子 agent ${agentId} 的提示` }], {
      uuid: 'u1',
      timestamp: ccTimestamp(0),
      extra,
    }),
    ccAssistant({
      uuid: 'a1',
      messageId: 'msg-1',
      blocks: [{ type: 'text', text: '子回答' }],
      apiBlockIndex: 0,
      usage: { input_tokens: 10, output_tokens: 4 },
      stopReason: 'end_turn',
      timestamp: ccTimestamp(1),
      extra,
    }),
  ];
}
