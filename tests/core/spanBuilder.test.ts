/**
 * core/spanBuilder.ts 单元测试（t5 合同）：
 * - span 数与四层父链（session→turn→step→tool + compaction 子 span）；
 * - 字段三去向：gen_ai.*（model/usage/messages/tool）、asu.*（extras/pairing）、
 *   asu.stats.*（R18 字符串标量）；
 * - 脱敏唯一入口：messages/extras/argsText 里的凭据替换占位符；输入树不被修改；
 * - 键序：每 span 属性键码点升序；两次序列化字节相同（确定性）；
 * - 时间回填：缺起点取下一事件时间；全缺失 → '0' 且 asu.stats.unknown_times 计数；
 * - id 派生：traceId 全树一致；spanId = deriveSpanId(sessionKey, path)（t1 §7）；
 * - 跨文件父引用（含 CC sidechain 从 extras 提升 parentSession）；
 * - compaction 事件提成专用子 span（不并入 step.usage）；
 * - v3 空树（R10）仍产出单根 span + stats。
 */

import { describe, expect, it } from 'vitest';
import {
  deriveParentSpanRef,
  deriveSpanId,
  deriveTraceId,
  sessionKey,
  sessionSpanPath,
  stepSpanPath,
  toolSpanPath,
  turnSpanPath,
} from '../../src/core/ids.js';
import { emptyStats, type SessionNode, type Stats } from '../../src/core/model.js';
import {
  buildSpans,
} from '../../src/core/spanBuilder.js';
import { serializeTracesData, type Span } from '../../src/core/otlp.js';
import {
  ASU_REDACTED_PREFIX,
} from '../../src/core/redact.js';
import { hashPlaceholder } from '../../src/core/ids.js';

// -- 工厂 ---------------------------------------------------------------------

function makeStats(overrides: Partial<Stats> = {}): Stats {
  return { ...emptyStats(), ...overrides };
}

function makeSession(overrides: Partial<SessionNode> = {}): SessionNode {
  return {
    sourceRefs: [],
    extras: {},
    tool: 'dsh',
    sessionId: 'sess-1',
    agentLabel: 'main',
    turns: [],
    stats: makeStats(),
    ...overrides,
  };
}

/** 富树：2 轮，turn0 含 2 步（2 工具 + 1 工具），turn1 空（无 step）。 */
function makeRichTree(overrides: Partial<SessionNode> = {}): SessionNode {
  const tree: SessionNode = {
    ...makeSession(),
    createdAtMs: 1_000,
    turns: [
      {
        sourceRefs: [{ file: 'a.jsonl', seq: 3, recordType: 'turn/start' }],
        extras: { turn_number: 1 },
        startTimeUnixNano: 1_000_000_000n,
        endTimeUnixNano: 1_900_000_000n,
        steps: [
          {
            sourceRefs: [{ file: 'a.jsonl', seq: 4, recordType: 'step/start' }],
            extras: { step_number: 1 },
            startTimeUnixNano: 1_100_000_000n,
            endTimeUnixNano: 1_500_000_000n,
            model: 'deepseek-chat',
            usage: {
              inputTokens: 100,
              outputTokens: 40,
              reasoningTokens: 10,
              cacheReadTokens: 7,
              cacheWriteTokens: 5,
            },
            inputMessages: [{ role: 'user', content: 'hello' }],
            outputMessages: [{ role: 'assistant', content: 'hi' }],
            tools: [
              {
                sourceRefs: [{ file: 'a.jsonl', seq: 5, recordType: 'tool/call' }],
                extras: {},
                startTimeUnixNano: 1_200_000_000n,
                endTimeUnixNano: 1_300_000_000n,
                toolName: 'Read',
                toolCallId: 'call-1',
                argsText: '{"file_path":"x.ts"}',
                resultText: 'file content',
                pairing: 'paired',
              },
              {
                sourceRefs: [],
                extras: {},
                startTimeUnixNano: 1_400_000_000n,
                endTimeUnixNano: 1_450_000_000n,
                toolName: 'Bash',
                pairing: 'orphan_call',
              },
            ],
          },
          {
            sourceRefs: [],
            extras: {},
            tools: [],
          },
        ],
      },
      {
        sourceRefs: [],
        extras: {},
        steps: [],
      },
    ],
    stats: makeStats({
      inputRecords: 10,
      skippedRecords: 2,
      badLines: 1,
      frames: 3,
      unknownEventTypes: { 'model/selection': 2, 'assistant/attempt': 1 },
    }),
  };
  return { ...tree, ...overrides };
}

/** 全部 span（扁平）与属性访问助手。 */
function allSpans(tree: SessionNode): Span[] {
  return buildSpans(tree).resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
}

function attrsOf(span: Span): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const { key, value } of span.attributes ?? []) {
    if ('stringValue' in value) map.set(key, value.stringValue);
    else if ('intValue' in value) map.set(key, value.intValue);
    else if ('boolValue' in value) map.set(key, value.boolValue);
    else if ('doubleValue' in value) map.set(key, value.doubleValue);
  }
  return map;
}

function findSpan(spans: Span[], name: string): Span {
  const span = spans.find((s) => s.name === name);
  expect(span, `span 未找到：${name}`).toBeDefined();
  return span as Span;
}

// -- span 数与四层父链 ----------------------------------------------------------

describe('buildSpans — span 数与父链', () => {
  it('富树：7 个四层 span（1 session + 2 turn + 2 step + 2 tool）', () => {
    const spans = allSpans(makeRichTree());
    expect(spans.length).toBe(7);
  });

  it('span 顺序 = 文档序（pre-order）：session, turn 0, step 0/0, Read, Bash, step 0/1, turn 1', () => {
    const spans = allSpans(makeRichTree());
    expect(spans.map((s) => s.name)).toEqual([
      'session sess-1',
      'turn 0',
      'step 0/0',
      'Read',
      'Bash',
      'step 0/1',
      'turn 1',
    ]);
  });

  it('父链：turn→session、step→turn、tool→step（parentSpanId 精确指向）', () => {
    const spans = allSpans(makeRichTree());
    const session = findSpan(spans, 'session sess-1');
    const turn0 = findSpan(spans, 'turn 0');
    const step00 = findSpan(spans, 'step 0/0');
    const read = findSpan(spans, 'Read');
    const bash = findSpan(spans, 'Bash');
    const step01 = findSpan(spans, 'step 0/1');
    const turn1 = findSpan(spans, 'turn 1');

    expect(session.parentSpanId).toBeUndefined(); // 根（跨文件父只走属性）
    expect(turn0.parentSpanId).toBe(session.spanId);
    expect(turn1.parentSpanId).toBe(session.spanId);
    expect(step00.parentSpanId).toBe(turn0.spanId);
    expect(step01.parentSpanId).toBe(turn0.spanId);
    expect(read.parentSpanId).toBe(step00.spanId);
    expect(bash.parentSpanId).toBe(step00.spanId);
  });

  it('trace_id 全树一致且 = deriveTraceId(sessionId)', () => {
    const tree = makeRichTree();
    const spans = allSpans(tree);
    const expected = deriveTraceId('sess-1');
    for (const span of spans) expect(span.traceId).toBe(expected);
  });

  it('span_id = deriveSpanId(sessionKey, path)（t1 §7：键含 agentLabel）', () => {
    const tree = makeRichTree();
    const spans = allSpans(tree);
    const key = sessionKey('sess-1', 'main');

    expect(findSpan(spans, 'session sess-1').spanId).toBe(
      deriveSpanId(key, sessionSpanPath()),
    );
    expect(findSpan(spans, 'turn 0').spanId).toBe(deriveSpanId(key, turnSpanPath(0)));
    expect(findSpan(spans, 'turn 1').spanId).toBe(deriveSpanId(key, turnSpanPath(1)));
    expect(findSpan(spans, 'step 0/0').spanId).toBe(deriveSpanId(key, stepSpanPath(0, 0)));
    expect(findSpan(spans, 'step 0/1').spanId).toBe(deriveSpanId(key, stepSpanPath(0, 1)));
    expect(findSpan(spans, 'Read').spanId).toBe(deriveSpanId(key, toolSpanPath(0, 0, 0)));
    expect(findSpan(spans, 'Bash').spanId).toBe(deriveSpanId(key, toolSpanPath(0, 0, 1)));
  });

  it('同 session 不同 agent：traceId 相同、spanId 不同（§7 硬约束）', () => {
    const main = allSpans(makeRichTree());
    const side = allSpans(makeRichTree({ agentLabel: 'sidechain-agent1' }));
    expect(main[0]?.traceId).toBe(side[0]?.traceId);
    expect(main[0]?.spanId).not.toBe(side[0]?.spanId);
    expect(side[0]?.spanId).toBe(
      deriveSpanId(sessionKey('sess-1', 'sidechain-agent1'), sessionSpanPath()),
    );
  });

  it('空树（R10）：仅 1 个根 span，属性含 stats；produced_spans=1', () => {
    const tree = makeSession({ stats: makeStats({ skippedV3: 1, skippedRecords: 42 }) });
    const spans = allSpans(tree);
    expect(spans.length).toBe(1);
    const attrs = attrsOf(spans[0] as Span);
    expect(attrs.get('asu.stats.skipped_v3')).toBe('1');
    expect(attrs.get('asu.stats.produced_spans')).toBe('1');
    expect(attrs.get('asu.stats.skipped_records')).toBe('42');
  });
});

// -- 字段三去向 ------------------------------------------------------------------

describe('buildSpans — 字段三去向', () => {
  it('step：model → gen_ai.request.model 与 gen_ai.response.model', () => {
    const spans = allSpans(makeRichTree());
    const attrs = attrsOf(findSpan(spans, 'step 0/0'));
    expect(attrs.get('gen_ai.request.model')).toBe('deepseek-chat');
    expect(attrs.get('gen_ai.response.model')).toBe('deepseek-chat');
  });

  it('step：usage → R1 映射表（reasoning/cache_read/cache_write 三个键名）', () => {
    const spans = allSpans(makeRichTree());
    const attrs = attrsOf(findSpan(spans, 'step 0/0'));
    expect(attrs.get('gen_ai.usage.input_tokens')).toBe(100);
    expect(attrs.get('gen_ai.usage.output_tokens')).toBe(40);
    expect(attrs.get('gen_ai.usage.output_tokens.reasoning_tokens')).toBe(10);
    expect(attrs.get('gen_ai.token_count.cache_read')).toBe(7);
    expect(attrs.get('asu.usage.cache_write')).toBe(5);
  });

  it('step：usage 缺键不补 0（R15：实测 0 保留，缺失不填）', () => {
    const tree = makeRichTree();
    (tree.turns[0]?.steps[0] as { usage: unknown }).usage = { inputTokens: 0 };
    const attrs = attrsOf(findSpan(allSpans(tree), 'step 0/0'));
    expect(attrs.get('gen_ai.usage.input_tokens')).toBe(0); // 实测 0 保留
    expect(attrs.has('gen_ai.usage.output_tokens')).toBe(false); // 缺失不填
  });

  it('step：messages → gen_ai.input/output.messages（JSON 字符串，内容不截断）', () => {
    const spans = allSpans(makeRichTree());
    const attrs = attrsOf(findSpan(spans, 'step 0/0'));
    expect(JSON.parse(attrs.get('gen_ai.input.messages') as string)).toEqual([
      { role: 'user', content: 'hello' },
    ]);
    expect(JSON.parse(attrs.get('gen_ai.output.messages') as string)).toEqual([
      { role: 'assistant', content: 'hi' },
    ]);
  });

  it('tool：gen_ai.tool.name / call.id / call.arguments / call.result', () => {
    const spans = allSpans(makeRichTree());
    const read = attrsOf(findSpan(spans, 'Read'));
    expect(read.get('gen_ai.tool.name')).toBe('Read');
    expect(read.get('gen_ai.tool.call.id')).toBe('call-1');
    expect(read.get('gen_ai.tool.call.arguments')).toBe('{"file_path":"x.ts"}');
    expect(read.get('gen_ai.tool.call.result')).toBe('file content');
    expect(read.get('asu.tool.pairing')).toBe('paired');
  });

  it('tool：pairing != paired → asu.pending_or_interrupted=true', () => {
    const spans = allSpans(makeRichTree());
    const bash = attrsOf(findSpan(spans, 'Bash'));
    expect(bash.get('asu.tool.pairing')).toBe('orphan_call');
    expect(bash.get('asu.pending_or_interrupted')).toBe(true);
    const read = attrsOf(findSpan(spans, 'Read'));
    expect(read.has('asu.pending_or_interrupted')).toBe(false);
  });

  it('tool：isError=true → asu.tool.is_error + status ERROR（否则无 status）', () => {
    const tree = makeRichTree();
    (tree.turns[0]?.steps[0]?.tools[0] as { isError?: boolean }).isError = true;
    const spans = allSpans(tree);
    const read = findSpan(spans, 'Read');
    expect(read.status?.code).toBe('STATUS_CODE_ERROR');
    expect(attrsOf(read).get('asu.tool.is_error')).toBe(true);
    const bash = findSpan(spans, 'Bash');
    expect(bash.status).toBeUndefined();
  });

  it('turn：compact / end_reason 属性', () => {
    const tree = makeRichTree();
    const turn = tree.turns[0];
    if (turn) {
      turn.compact = true;
      turn.endReason = 'stop';
    }
    const attrs = attrsOf(findSpan(allSpans(tree), 'turn 0'));
    expect(attrs.get('asu.turn.compact')).toBe(true);
    expect(attrs.get('asu.turn.end_reason')).toBe('stop');
  });

  it('resource：service.name + asu.session.*（present-only，键升序）', () => {
    const tree = makeSession({
      formatVersion: 4,
      cwd: '/home/x',
      agentPreset: 'p1',
    });
    const rs = buildSpans(tree).resourceSpans[0];
    const keys = (rs?.resource.attributes ?? []).map((a) => a.key);
    expect(keys).toEqual([
      'asu.session.agent_label',
      'asu.session.agent_preset',
      'asu.session.cwd',
      'asu.session.format_version',
      'asu.session.id',
      'service.name',
    ]);
    const map = new Map((rs?.resource.attributes ?? []).map((a) => [a.key, a.value] as const));
    expect(map.get('service.name')).toEqual({ stringValue: 'dsh' });
    expect(map.get('asu.session.format_version')).toEqual({ intValue: 4 });
  });

  it('root：delegation_depth / is_seeded / origin / source_ref_count', () => {
    const tree = makeRichTree();
    tree.delegationDepth = 2;
    tree.isSeeded = false;
    tree.origin = 'sub';
    const attrs = attrsOf(findSpan(allSpans(tree), 'session sess-1'));
    expect(attrs.get('asu.session.delegation_depth')).toBe(2);
    expect(attrs.get('asu.session.is_seeded')).toBe(false);
    expect(attrs.get('asu.session.origin')).toBe('sub');
    expect(attrs.get('asu.source_ref_count')).toBe(0);
  });
});

// -- stats（R18）----------------------------------------------------------------

describe('buildSpans — asu.stats.*', () => {
  it('全部 stats 键输出（字符串标量，R18），produced_spans 用实际 span 数', () => {
    const spans = allSpans(makeRichTree());
    const attrs = attrsOf(findSpan(spans, 'session sess-1'));
    expect(attrs.get('asu.stats.produced_spans')).toBe('7');
    expect(attrs.get('asu.stats.input_records')).toBe('10');
    expect(attrs.get('asu.stats.skipped_records')).toBe('2');
    expect(attrs.get('asu.stats.bad_lines')).toBe('1');
    expect(attrs.get('asu.stats.frames')).toBe('3');
    expect(attrs.get('asu.stats.compaction_spans')).toBe('0');
    expect(attrs.get('asu.stats.usage_snapshots')).toBe('0'); // t10 字段兜底可见
  });

  it('unknownEventTypes 拆键：asu.stats.unknown_event_types.<type>（按类型名升序）', () => {
    const spans = allSpans(makeRichTree());
    const root = findSpan(spans, 'session sess-1');
    const keys = (root.attributes ?? [])
      .filter((a) => a.key.startsWith('asu.stats.unknown_event_types.'))
      .map((a) => a.key);
    expect(keys).toEqual([
      'asu.stats.unknown_event_types.assistant/attempt',
      'asu.stats.unknown_event_types.model/selection',
    ]);
    const attrs = attrsOf(root);
    expect(attrs.get('asu.stats.unknown_event_types.model/selection')).toBe('2');
    expect(attrs.get('asu.stats.unknown_event_types.assistant/attempt')).toBe('1');
  });

  it('未来新增 Stats 字段自动落地（Object.entries 兜底，m00114 队长要求）', () => {
    const tree = makeSession();
    (tree.stats as unknown as Record<string, unknown>).futureCount = 9;
    const attrs = attrsOf(findSpan(allSpans(tree), 'session sess-1'));
    expect(attrs.get('asu.stats.future_count')).toBe('9');
  });
});

// -- 脱敏唯一入口 ------------------------------------------------------------------

describe('buildSpans — 脱敏（§4.4 唯一入口）', () => {
  it('messages 里的凭据串 → asu.redacted.<16hex> 占位符（内容可对账不可逆推）', () => {
    const tree = makeRichTree();
    const step = tree.turns[0]?.steps[0];
    if (step) {
      step.inputMessages = [{ role: 'user', content: 'sk-abc123secret' }];
    }
    const attrs = attrsOf(findSpan(allSpans(tree), 'step 0/0'));
    const parsed = JSON.parse(attrs.get('gen_ai.input.messages') as string);
    const placeholder = (parsed as Array<{ content: string }>)[0]?.content;
    expect(placeholder).toBe(`${ASU_REDACTED_PREFIX}.${hashPlaceholder('sk-abc123secret')}`);
    expect(placeholder).not.toContain('abc123');
  });

  it('tool argsText / resultText 过 redactString', () => {
    const tree = makeRichTree();
    const tool = tree.turns[0]?.steps[0]?.tools[0];
    if (tool) {
      tool.argsText = 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig';
    }
    const attrs = attrsOf(findSpan(allSpans(tree), 'Read'));
    expect(attrs.get('gen_ai.tool.call.arguments')).toBe(
      `${ASU_REDACTED_PREFIX}.${hashPlaceholder('Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig')}`,
    );
  });

  it('extras 嵌套对象：敏感字段名（token/apiKey/password/secret）的字符串值无条件替换', () => {
    const tree = makeRichTree();
    tree.turns[0]?.steps[0] && (tree.turns[0].steps[0].extras = {
      config: { apiKey: 'plain-value-no-prefix', model: 'd' },
    });
    const attrs = attrsOf(findSpan(allSpans(tree), 'step 0/0'));
    const parsed = JSON.parse(attrs.get('asu.config') as string) as {
      apiKey: string;
      model: string;
    };
    expect(parsed.apiKey).toBe(
      `${ASU_REDACTED_PREFIX}.${hashPlaceholder('plain-value-no-prefix')}`,
    );
    expect(parsed.model).toBe('d'); // 非敏感键原样
  });

  it('字符串属性过 redact（session id 命中凭据前缀时，属性值替换为占位符）', () => {
    const tree = makeSession({ sessionId: 'sk-supersecret12345' });
    // resource 属性里 asu.session.id 原值以 sk- 开头 → 占位符
    const rs = buildSpans(tree).resourceSpans[0];
    const map = new Map((rs?.resource.attributes ?? []).map((a) => [a.key, a.value] as const));
    expect(map.get('asu.session.id')).toEqual({
      stringValue: `${ASU_REDACTED_PREFIX}.${hashPlaceholder('sk-supersecret12345')}`,
    });
    // span 名 'session sk-…' 不以凭据前缀开头（t2 redactString 只匹配串首前缀）：
    // 冻结行为——名不替换，属性值替换。以本测试钉住该口径。
    expect((allSpans(tree)[0] as Span).name).toBe('session sk-supersecret12345');
  });

  it('输入树不被修改（纯函数，不原地脱敏）', () => {
    const tree = makeRichTree();
    const step = tree.turns[0]?.steps[0];
    if (step) {
      step.inputMessages = [{ role: 'user', content: 'sk-abc123secret' }];
      step.extras = { apiKey: 'raw' };
    }
    const before = structuredClone(tree);
    buildSpans(tree);
    expect(tree).toEqual(before);
  });
});

// -- 确定性 ------------------------------------------------------------------------

describe('buildSpans — 确定性', () => {
  it('同树两次构建 + 序列化字节完全一致', () => {
    const tree = makeRichTree();
    const a = serializeTracesData(buildSpans(tree));
    const b = serializeTracesData(buildSpans(tree));
    expect(a).toBe(b);
  });

  it('structuredClone 树（同结构不同对象）序列化字节完全一致', () => {
    const tree = makeRichTree();
    const a = serializeTracesData(buildSpans(tree));
    const b = serializeTracesData(buildSpans(structuredClone(tree)));
    expect(a).toBe(b);
  });

  it('每 span 属性键码点升序', () => {
    const spans = allSpans(makeRichTree());
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) {
      const keys = (span.attributes ?? []).map((a) => a.key);
      const sorted = [...keys].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
      expect(keys).toEqual(sorted);
    }
  });
});

// -- 时间回填（DESIGN §10）----------------------------------------------------------

describe('buildSpans — 时间回填', () => {
  it('正常树：时间来自事件（纳秒字符串，BigInt 精度）', () => {
    const spans = allSpans(makeRichTree());
    const session = findSpan(spans, 'session sess-1');
    expect(session.startTimeUnixNano).toBe('1000000000'); // createdAtMs=1000 → 1000ms × 1e6
    expect(session.endTimeUnixNano).toBe('1900000000'); // 全树最大 = turn0.end 1.9e9ns
    expect(findSpan(spans, 'turn 0').startTimeUnixNano).toBe('1000000000');
    expect(findSpan(spans, 'Read').endTimeUnixNano).toBe('1300000000');
  });

  it('BigInt 精度：createdAtMs 大毫秒值 × 1e6 不丢位（R13）', () => {
    const tree = makeSession({ createdAtMs: 1_790_071_548_428 });
    const spans = allSpans(tree);
    expect((spans[0] as Span).startTimeUnixNano).toBe('1790071548428000000');
  });

  it('缺 turn.start：回填自身 end（零时长落点）；缺 step.start：前向首个已知', () => {
    const tree = makeSession({
      turns: [
        {
          sourceRefs: [],
          extras: {},
          endTimeUnixNano: 5_000_000_000n,
          steps: [
            {
              sourceRefs: [],
              extras: {},
              startTimeUnixNano: 7_000_000_000n,
              endTimeUnixNano: 8_000_000_000n,
              tools: [],
            },
          ],
        },
      ],
    });
    const spans = allSpans(tree);
    expect(findSpan(spans, 'turn 0').startTimeUnixNano).toBe('5000000000');
    expect(findSpan(spans, 'step 0/0').startTimeUnixNano).toBe('7000000000');
    // 自身 end 已知（5e9）优先于子树最大：DESIGN §10 终点用事件自带值，不用子树覆盖
    expect(findSpan(spans, 'turn 0').endTimeUnixNano).toBe('5000000000');
    expect(findSpan(spans, 'step 0/0').endTimeUnixNano).toBe('8000000000');
  });

  it("全部时间缺失：全 '0' 且 unknown_times = 解析器计数 + 组装增量", () => {
    const tree = makeSession({
      stats: makeStats({ unknownTimes: 1 }),
      turns: [
        {
          sourceRefs: [],
          extras: {},
          steps: [
            { sourceRefs: [], extras: {}, tools: [] },
            { sourceRefs: [], extras: {}, tools: [] },
          ],
        },
        { sourceRefs: [], extras: {}, steps: [] },
      ],
    });
    const spans = allSpans(tree);
    // 1 session + 2 turn + 2 step = 5
    expect(spans.length).toBe(5);
    for (const span of spans) {
      expect(span.startTimeUnixNano).toBe('0');
      expect(span.endTimeUnixNano).toBe('0');
    }
    const attrs = attrsOf(findSpan(spans, 'session sess-1'));
    // 组装增量：session + turn0 + step0/0 + step0/1 + turn1 = 5 个起点未知
    expect(attrs.get('asu.stats.unknown_times')).toBe('6'); // 1 解析器 + 5 组装
  });

  it("v3 空树无时间：根 span '0'，unknown_times = 1", () => {
    const tree = makeSession({ stats: makeStats({ skippedV3: 1 }) });
    const spans = allSpans(tree);
    expect((spans[0] as Span).startTimeUnixNano).toBe('0');
    expect(attrsOf(spans[0] as Span).get('asu.stats.unknown_times')).toBe('1');
  });
});

// -- 跨文件父引用 --------------------------------------------------------------------

describe('buildSpans — 跨文件父引用', () => {
  it('跨 trace（DSH 子会话，父 id ≠ 本 id）：省略 parentSpanId，保留 asu.parent_session.* 四件套（t12）', () => {
    const tree = makeRichTree({ parentSession: 'parent-sess' });
    const root = findSpan(allSpans(tree), 'session sess-1');
    // 跨 trace：OTLP parentSpanId 须同 trace，写入即悬空 → 省略
    expect(root.parentSpanId).toBeUndefined();
    const attrs = attrsOf(root);
    expect(attrs.get('asu.parent_session.id')).toBe('parent-sess');
    expect(attrs.get('asu.parent_session.trace_id')).toBe(deriveTraceId('parent-sess'));
    expect(attrs.get('asu.parent_session.span_id')).toBe(
      deriveSpanId(sessionKey('parent-sess', 'main'), sessionSpanPath()),
    );
    expect(attrs.get('asu.parent_session.agent_label')).toBe('main');
  });

  it('同 trace（parentSession === 本 sessionId）：写 parentSpanId，与父 main 文件 session span 精确对上（t12）', () => {
    // CC sidechain 场景：子会话与父共享 sessionId
    const childTree = makeRichTree({
      agentLabel: 'sidechain-agent1',
      parentSession: 'sess-1',
    });
    const childRoot = findSpan(allSpans(childTree), 'session sess-1');
    expect(childRoot.parentSpanId).not.toBeUndefined();
    const mainRoot = findSpan(allSpans(makeRichTree()), 'session sess-1');
    expect(childRoot.parentSpanId).toBe(mainRoot.spanId);
    const attrs = attrsOf(childRoot);
    expect(attrs.get('asu.parent_session.id')).toBe('sess-1');
    expect(attrs.get('asu.parent_session.trace_id')).toBe(deriveTraceId('sess-1'));
  });

  it('CC sidechain：extras.parentSession 提升（t4 口径：树字段不设）→ 同 trace 有 parentSpanId', () => {
    const tree = makeRichTree({
      agentLabel: 'sidechain-agent1',
      extras: { parentSession: 'sess-1' },
    });
    const root = findSpan(allSpans(tree), 'session sess-1');
    expect(root.parentSpanId).not.toBeUndefined();
    const attrs = attrsOf(root);
    expect(attrs.get('asu.parent_session.id')).toBe('sess-1');
    // 与父 main 文件（同 sessionId）的 session span 对上：同 trace 精确父子
    const mainRoot = findSpan(allSpans(makeRichTree()), 'session sess-1');
    expect(root.parentSpanId).toBe(mainRoot.spanId);
  });

  it('无 parentSession：parentSpanId 缺省，无 asu.parent_session.*', () => {
    const root = findSpan(allSpans(makeRichTree()), 'session sess-1');
    expect(root.parentSpanId).toBeUndefined();
    expect([...attrsOf(root).keys()].some((k) => k.startsWith('asu.parent_session'))).toBe(false);
  });
});

// -- compaction 子 span（m00114 队长要求）---------------------------------------------

describe('buildSpans — compaction 专用 span', () => {
  function treeWithCompactionEvent(node: 'session' | 'turn' | 'step'): SessionNode {
    const tree = makeRichTree();
    const entry = {
      type: 'compaction/end',
      time: 2_500,
      data: { turn: 0, usage: { inputTokens: 300, outputTokens: 60, totalTokens: 360 } },
    };
    if (node === 'session') tree.extras.events = [entry];
    if (node === 'turn' && tree.turns[0]) tree.turns[0].extras.events = [entry];
    if (node === 'step' && tree.turns[0]?.steps[0]) {
      tree.turns[0].steps[0].extras.events = [entry];
    }
    return tree;
  }

  it('带 usage 的 compaction 事件 → 专用子 span（asu.compaction=true，R1 usage 映射）', () => {
    const tree = treeWithCompactionEvent('turn');
    const spans = allSpans(tree);
    expect(spans.length).toBe(8); // 7 四层 + 1 compaction
    const compaction = findSpan(spans, 'compaction');
    expect(compaction.parentSpanId).toBe(findSpan(spans, 'turn 0').spanId);
    const attrs = attrsOf(compaction);
    expect(attrs.get('asu.compaction')).toBe(true);
    expect(attrs.get('asu.compaction.event_type')).toBe('compaction/end');
    expect(attrs.get('gen_ai.usage.input_tokens')).toBe(300);
    expect(attrs.get('gen_ai.usage.output_tokens')).toBe(60);
    expect(attrs.get('asu.usage.total_tokens')).toBe(360);
    expect(compaction.startTimeUnixNano).toBe('2500000000'); // time=2500ms → 2.5e9ns
    expect(compaction.endTimeUnixNano).toBe('2500000000');
  });

  it('不并入 step.usage：step 0/0 的 gen_ai.usage.input_tokens 仍是 100', () => {
    const tree = treeWithCompactionEvent('step');
    const spans = allSpans(tree);
    expect(attrsOf(findSpan(spans, 'step 0/0')).get('gen_ai.usage.input_tokens')).toBe(100);
    expect(findSpan(spans, 'compaction').parentSpanId).toBe(
      findSpan(spans, 'step 0/0').spanId,
    );
  });

  it('session 级 compaction 事件也提成子 span（挂根下）', () => {
    const spans = allSpans(treeWithCompactionEvent('session'));
    expect(spans.length).toBe(8);
    expect(findSpan(spans, 'compaction').parentSpanId).toBe(
      findSpan(spans, 'session sess-1').spanId,
    );
  });

  it('无 usage 的 compaction 事件不建 span（原文仍在 asu.events）', () => {
    const tree = makeRichTree();
    tree.turns[0]?.steps[0] && (tree.turns[0].steps[0].extras.events = [
      { type: 'compaction/prune', data: { turn: 0 } },
    ]);
    const spans = allSpans(tree);
    expect(spans.length).toBe(7);
    const attrs = attrsOf(findSpan(spans, 'step 0/0'));
    expect(attrs.has('asu.events')).toBe(true); // 原文保留
  });

  it('compaction span 的时间参与根 span 终点最大值', () => {
    const tree = treeWithCompactionEvent('turn');
    const root = findSpan(allSpans(tree), 'session sess-1');
    // compaction time=2500ms → 2.5e9ns > 树内最大 1.9e9ns
    expect(root.endTimeUnixNano).toBe('2500000000');
  });

  it('span 计数口径：produced_spans = 实际 span 总数；compaction_spans 单计', () => {
    const tree = treeWithCompactionEvent('turn');
    const attrs = attrsOf(findSpan(allSpans(tree), 'session sess-1'));
    expect(attrs.get('asu.stats.produced_spans')).toBe('8');
    expect(attrs.get('asu.stats.compaction_spans')).toBe('1');
  });

  it('compaction 事件无 time：span 时间 0 且 unknown_times 递增', () => {
    const tree = makeRichTree();
    tree.turns[0] && (tree.turns[0].extras.events = [
      { type: 'compaction/end', data: { usage: { inputTokens: 1 } } },
    ]);
    const spans = allSpans(tree);
    const compaction = findSpan(spans, 'compaction');
    expect(compaction.startTimeUnixNano).toBe('0');
    const attrs = attrsOf(findSpan(spans, 'session sess-1'));
    // turn1 无任何时间（前向无已知槽）→ 组装计 1；compaction 无 time → 再计 1
    expect(attrs.get('asu.stats.unknown_times')).toBe('2');
  });

  it('compaction span id = deriveSpanId(key, <父路径>/compaction/<序号>)（与四层路径不撞）', () => {
    const tree = treeWithCompactionEvent('turn');
    const spans = allSpans(tree);
    const key = sessionKey('sess-1', 'main');
    expect(findSpan(spans, 'compaction').spanId).toBe(
      deriveSpanId(key, 'turn/0/compaction/0'),
    );
  });
});

// -- extras 映射 -----------------------------------------------------------------------

describe('buildSpans — extras → asu.*', () => {
  it('extras 键加 asu. 前缀，键名不改；null → 空串；对象 → JSON 字符串', () => {
    const tree = makeRichTree();
    const step = tree.turns[0]?.steps[0];
    if (step) {
      step.extras = { step_number: 1, label: null, meta: { x: 1 } };
    }
    const attrs = attrsOf(findSpan(allSpans(tree), 'step 0/0'));
    expect(attrs.get('asu.step_number')).toBe(1);
    expect(attrs.get('asu.label')).toBe('');
    expect(JSON.parse(attrs.get('asu.meta') as string)).toEqual({ x: 1 });
  });

  it('数组 extras → JSON 字符串（保序）', () => {
    const tree = makeRichTree();
    tree.extras.versions = ['2.1.303', '2.1.88'];
    const attrs = attrsOf(findSpan(allSpans(tree), 'session sess-1'));
    expect(JSON.parse(attrs.get('asu.versions') as string)).toEqual(['2.1.303', '2.1.88']);
  });

  it('源码边界：spanBuilder 是唯一 import redact 的 src 模块（§4.4）', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const srcRoot = fileURLToPath(new URL('../../src', import.meta.url));
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(p));
        else if (entry.name.endsWith('.ts')) out.push(p);
      }
      return out;
    };
    const violators: string[] = [];
    for (const file of walk(srcRoot)) {
      if (file.replaceAll('\\', '/').endsWith('/core/spanBuilder.ts')) continue;
      const source = readFileSync(file, 'utf8');
      for (const line of source.split('\n')) {
        if (/^\s*import\b/.test(line) && /redact/.test(line)) violators.push(file);
      }
    }
    expect(violators).toEqual([]);
  });
});

// -- 序列化键序（切片 marker 法）----------------------------------------------------------

describe('buildSpans — 输出键序（切片断言）', () => {
  it('span 字段序：traceId → spanId → name → kind → startTime → endTime → attributes', () => {
    const json = serializeTracesData(buildSpans(makeRichTree()));
    // 切出根 span 的对象文本（从 { 到 name 后第一个 } 前足够远）
    const rootStart = json.indexOf('{"traceId"');
    expect(rootStart).toBeGreaterThan(0);
    const rootName = json.indexOf('"name":"session sess-1"', rootStart);
    expect(rootName).toBeGreaterThan(rootStart);
    // name 之前只有 traceId 与 spanId（根无 parentSpanId），且序为 traceId < spanId
    const before = json.slice(rootStart, rootName);
    expect(before.indexOf('"traceId"')).toBeGreaterThanOrEqual(0);
    expect(before.indexOf('"spanId"')).toBeGreaterThan(before.indexOf('"traceId"'));
    // name 之后到该 span 结束：kind < startTime < endTime < attributes（首个出现序）
    const after = json.slice(rootName);
    const kind = after.indexOf('"kind"');
    const start = after.indexOf('"startTimeUnixNano"');
    const end = after.indexOf('"endTimeUnixNano"');
    const attributes = after.indexOf('"attributes"');
    expect(kind).toBeGreaterThan(0);
    expect(start).toBeGreaterThan(kind);
    expect(end).toBeGreaterThan(start);
    expect(attributes).toBeGreaterThan(end);
  });

  it('子 span 的 parentSpanId 在 spanId 与 name 之间', () => {
    const json = serializeTracesData(buildSpans(makeRichTree()));
    const anchor = json.indexOf('"name":"turn 0"');
    const slice = json.slice(anchor - 300, anchor);
    const spanId = slice.lastIndexOf('"spanId"');
    const parentSpanId = slice.lastIndexOf('"parentSpanId"');
    expect(spanId).toBeGreaterThan(0);
    expect(parentSpanId).toBeGreaterThan(spanId);
  });

  it('序列化产物可 JSON.parse（结构合法）', () => {
    const json = serializeTracesData(buildSpans(makeRichTree()));
    expect(() => JSON.parse(json)).not.toThrow();
  });
});
