/**
 * DSH v4 会话集成测试夹具（tests/fixtures/dsh.ts）。
 *
 * 约束（AGENTS.md 数据纪律）：
 * - 全部为**合成**记录，不含真实会话内容、真实路径、真实凭据；
 * - 不落盘 `.jsonl` / `.zstd`（.gitignore 会吞掉），只导出内存对象，
 *   由 tests/integration/helpers.ts 在运行时压成 zstd 帧写临时目录；
 * - 不 import src/ 下的任何解析器/夹具工具，避免用实现验证实现。
 */

/** 夹具时间基准（与 tests/dsh/synthetic.ts 一致的 2025-11 时间点，便于人工核对）。 */
export const DSH_FIXTURE_BASE_MS = 1763856000000;

export type JsonObject = Record<string, unknown>;

/** 会话头（v4）：`type=session` 的首行即 header，其余字段按需覆盖。 */
export function dshSessionHeader(overrides: JsonObject = {}): JsonObject {
  return {
    type: 'session',
    version: 4,
    id: 'dsh-fixture-main',
    cwd: 'C:\\fixture\\proj',
    createdAt: DSH_FIXTURE_BASE_MS,
    agentPreset: 'fixture-preset',
    ...overrides,
  };
}

export interface DshEventOptions {
  /** 去重键（R17）；省略即不带 seq。 */
  seq?: number;
  /** 相对 DSH_FIXTURE_BASE_MS 的毫秒偏移；null / 省略 = 不带时间戳（缺时间场景）。 */
  offsetMs?: number | null;
  /** 事件 data（原样进 record.data）。 */
  data?: unknown;
  /** 其余信封字段（surfaceOp 等）。 */
  extra?: JsonObject;
}

/** 构造一条 DSH 事件记录（JSON 对象，可在测试中直接 JSON.stringify）。 */
export function dshEvent(type: string, options: DshEventOptions = {}): JsonObject {
  const record: JsonObject = { type };
  if (options.seq !== undefined) record.seq = options.seq;
  if (options.offsetMs !== undefined && options.offsetMs !== null) {
    record.time = DSH_FIXTURE_BASE_MS + options.offsetMs;
  }
  if (options.data !== undefined) record.data = options.data;
  if (options.extra !== undefined) Object.assign(record, options.extra);
  return record;
}

/**
 * 把记录数组拼成 JSONL 文本；字符串原样作为一行（用于构造坏行）。
 *
 * `trailingNewline: true` 用于**按文本切片再分帧**的场景：多帧容器的语义是
 * 「各帧解压输出首尾拼接成完整文本」，所以切点两侧必须自带分隔符，否则两行会被
 * 粘成一行非法 JSON（这不是解析器的错，是夹具切法错了）。
 */
export function dshJsonl(
  records: Array<JsonObject | string>,
  options: { trailingNewline?: boolean } = {},
): string {
  const text = records
    .map((record) => (typeof record === 'string' ? record : JSON.stringify(record)))
    .join('\n');
  return options.trailingNewline === true ? `${text}\n` : text;
}

// ---------------------------------------------------------------------------
// 场景 1：主会话（正例基线）：1 turn / 1 step / 1 tool + 未知事件 + 去重 + 无时间
// ---------------------------------------------------------------------------

/**
 * 主会话记录序列（13 行）：
 * header / turn / user / step / request / assistant(usage) / tool.call /
 * tool.result / step.end / turn.end / 未知事件 / session.title（无时间）/ 重复 seq。
 *
 * 预期输出（tests/integration/dsh.test.ts 独立断言）：
 * - 4 个四层 span（session/turn/step/tool），0 个 compaction span；
 * - input_records=13、skipped_records=1（重复 seq）、deduped=1、bad_lines=0；
 * - unknown_event_types['mystery/fixture']=1；
 * - source_refs 合计 12（header 1 + turn 2 + step 5 + tool 2 + session 2）。
 */
export function dshMainRecords(): JsonObject[] {
  return [
    dshSessionHeader(),
    dshEvent('turn/start', { seq: 1, offsetMs: 0, data: { turn: 1 } }),
    // 真实数据里 user/message 不携带 turn/step（实证样例 6734bc36 第 11-13 行），
    // 解析器会先挂起、等 step/start 建出步后并入——按真实形态构造，不造出
    // 「先按编号建步、随后 step/start 又建一步」的伪造双步。
    dshEvent('user/message', {
      seq: 2,
      offsetMs: 10,
      data: {
        message: { role: 'user', content: [{ type: 'text', text: '请读取 a.txt' }] },
      },
    }),
    dshEvent('step/start', { seq: 3, offsetMs: 20, data: { turn: 1, step: 1 } }),
    dshEvent('request/header', {
      seq: 4,
      offsetMs: 30,
      data: { turn: 1, step: 1, model: 'fixture-model' },
    }),
    dshEvent('assistant/message', {
      seq: 5,
      offsetMs: 40,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          source: { model: 'fixture-model' },
          content: [{ type: 'text', text: '好的' }],
        },
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          reasoningTokens: 5,
          cacheReadTokens: 7,
          cacheWriteTokens: 3,
          totalTokens: 127,
        },
      },
    }),
    dshEvent('tool/call', {
      seq: 6,
      offsetMs: 50,
      data: { turn: 1, step: 1, callId: 'call-1', name: 'read_file', arguments: { path: 'a.txt' } },
    }),
    dshEvent('tool/result', {
      seq: 7,
      offsetMs: 60,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          toolCallId: 'call-1',
          content: [{ type: 'text', text: '文件内容' }],
        },
      },
    }),
    dshEvent('step/end', { seq: 8, offsetMs: 70, data: { turn: 1, step: 1 } }),
    dshEvent('turn/end', { seq: 9, offsetMs: 80, data: { turn: 1, reason: { kind: 'completed' } } }),
    // 未知事件：必须原样进 extras.events + stats.unknown_event_types，不中断解析。
    dshEvent('mystery/fixture', { seq: 10, offsetMs: 90, data: { keep: 'untouched-payload' } }),
    // 已知但会话级、且无时间戳：不得崩溃、不得伪造节点时间。
    dshEvent('session/title', { seq: 11, data: { title: 'fixture title 标题' } }),
    // 重复 seq：按 (session, seq) 去重，只计 deduped/skipped，不重复建节点。
    dshEvent('step/start', { seq: 3, offsetMs: 95, data: { turn: 9, step: 9 } }),
  ];
}

/** 主会话 + 一行坏 JSON（坏行只计数、不中断整份文件）。 */
export function dshMainRecordsWithBadLine(): Array<JsonObject | string> {
  return [...dshMainRecords(), '{ this is not json'];
}

// ---------------------------------------------------------------------------
// 场景 2：compaction 用量独立 span（R9 / t5 裁决）
// ---------------------------------------------------------------------------

/**
 * 1 turn / 1 step / 1 tool + 一条 compaction/summary（带 usage）。
 * compaction 记录不带 step，落在 turn 上 → 组装成 turn 的子 span；
 * step 自己的 usage 不能被 compaction usage 覆盖。
 */
export function dshCompactionRecords(): JsonObject[] {
  return [
    dshSessionHeader({ id: 'dsh-fixture-compaction' }),
    dshEvent('turn/start', { seq: 1, offsetMs: 0, data: { turn: 1 } }),
    dshEvent('user/message', {
      seq: 2,
      offsetMs: 10,
      data: { message: { role: 'user', content: [{ type: 'text', text: '压缩前对话' }] } },
    }),
    dshEvent('step/start', { seq: 3, offsetMs: 20, data: { turn: 1, step: 1 } }),
    dshEvent('assistant/message', {
      seq: 4,
      offsetMs: 30,
      data: {
        turn: 1,
        step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: '压缩前回答' }] },
        usage: { inputTokens: 100, outputTokens: 20 },
      },
    }),
    dshEvent('compaction/summary', {
      seq: 5,
      offsetMs: 40,
      data: { turn: 1, usage: { inputTokens: 900, outputTokens: 50, totalTokens: 950 } },
    }),
    dshEvent('step/end', { seq: 6, offsetMs: 50, data: { turn: 1, step: 1 } }),
    dshEvent('turn/end', { seq: 7, offsetMs: 60, data: { turn: 1, reason: { kind: 'compacted' } } }),
  ];
}

// ---------------------------------------------------------------------------
// 场景 3：v3（不支持的格式版本 → 仅统计空树，R5/R10）
// ---------------------------------------------------------------------------

export function dshV3Records(): JsonObject[] {
  return [
    dshSessionHeader({ version: 3, id: 'dsh-fixture-v3' }),
    dshEvent('turn/start', { seq: 1, offsetMs: 0, data: { turn: 1 } }),
    dshEvent('assistant/message', {
      seq: 2,
      offsetMs: 10,
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [] } },
    }),
    dshEvent('turn/end', { seq: 3, offsetMs: 20, data: { turn: 1 } }),
  ];
}

// ---------------------------------------------------------------------------
// 场景 4：跨 trace 的子会话（parentSession ≠ 本 sessionId）
// ---------------------------------------------------------------------------

/**
 * 子会话：parentSession 指向另一个 sessionId → 输出**不得**写 parentSpanId
 * （否则 OTLP 里是悬空引用），但必须保留 asu.parent_session.* 四属性。
 */
export function dshChildRecords(): JsonObject[] {
  return [
    dshSessionHeader({
      id: 'dsh-fixture-child',
      parentSession: 'dsh-fixture-parent',
      delegationDepth: 1,
    }),
    dshEvent('turn/start', { seq: 1, offsetMs: 0, data: { turn: 1 } }),
    dshEvent('assistant/message', {
      seq: 2,
      offsetMs: 10,
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '子会话回答' }] } },
    }),
    dshEvent('turn/end', { seq: 3, offsetMs: 20, data: { turn: 1, reason: { kind: 'completed' } } }),
  ];
}

// ---------------------------------------------------------------------------
// 场景 5：全无时间戳（时间回填 0 + unknown_times 计数）
// ---------------------------------------------------------------------------

export function dshNoTimeRecords(): JsonObject[] {
  const header = dshSessionHeader({ id: 'dsh-fixture-no-time' });
  delete header.createdAt;
  return [
    header,
    dshEvent('turn/start', { seq: 1, data: { turn: 1 } }),
    dshEvent('user/message', {
      seq: 2,
      data: { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'text', text: '无时间' }] } },
    }),
    dshEvent('step/start', { seq: 3, data: { turn: 1, step: 1 } }),
    dshEvent('assistant/message', {
      seq: 4,
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '也没有' }] } },
    }),
    dshEvent('step/end', { seq: 5, data: { turn: 1, step: 1 } }),
    dshEvent('turn/end', { seq: 6, data: { turn: 1 } }),
  ];
}

// ---------------------------------------------------------------------------
// 场景 6：脱敏（只放 V1 规则覆盖得到的位置）
// ---------------------------------------------------------------------------

/**
 * 凭据分布在：用户消息正文（串首 sk-）、工具结果（整串 AKIA）、助手正文
 * （Bearer）、以及会话级事件的 data 字段名 `apiKey`（字段名规则）。
 * 同时放入必须保留的正文（中文、路径、普通文本），证明不是「一律清空」。
 *
 * **不放** tool/call.arguments 里的凭据：那里是 JSON 串（以 `{` 开头），
 * V1 前缀规则覆盖不到，属 DESIGN §8 已知风险，单独在 redaction.test.ts 记录。
 */
export function dshRedactionRecords(): JsonObject[] {
  return [
    dshSessionHeader({ id: 'dsh-fixture-redaction' }),
    dshEvent('model/selection', {
      seq: 0,
      offsetMs: 0,
      data: { model: 'fixture-model', apiKey: 'sk-dsh-fixture-ABCDEFGHIJKLMNOP' },
    }),
    dshEvent('turn/start', { seq: 1, offsetMs: 0, data: { turn: 1 } }),
    dshEvent('user/message', {
      seq: 2,
      offsetMs: 10,
      data: {
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'sk-live-ABCDEFGHIJKLMNOPQRSTUVWX' },
            { type: 'text', text: '请保留这段中文 a.txt' },
          ],
        },
      },
    }),
    dshEvent('step/start', { seq: 3, offsetMs: 20, data: { turn: 1, step: 1 } }),
    dshEvent('assistant/message', {
      seq: 4,
      offsetMs: 30,
      data: {
        turn: 1,
        step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Bearer abcdefghijklmnopqrstuvwx' }] },
        usage: { inputTokens: 10, outputTokens: 2 },
      },
    }),
    dshEvent('tool/call', {
      seq: 5,
      offsetMs: 40,
      data: { turn: 1, step: 1, callId: 'call-r1', name: 'read_file', arguments: '{"path":"a.txt"}' },
    }),
    dshEvent('tool/result', {
      seq: 6,
      offsetMs: 50,
      data: {
        turn: 1,
        step: 1,
        message: { toolCallId: 'call-r1', content: [{ type: 'text', text: 'AKIAIOSFODNN7EXAMPLE' }] },
      },
    }),
    dshEvent('step/end', { seq: 7, offsetMs: 60, data: { turn: 1, step: 1 } }),
    dshEvent('turn/end', { seq: 8, offsetMs: 70, data: { turn: 1, reason: { kind: 'completed' } } }),
  ];
}
