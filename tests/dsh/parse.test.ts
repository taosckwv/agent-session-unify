/**
 * dsh/parse.ts 单测（DESIGN §4.3/§5/§6/§9/§10/§11、RESEARCH §5、t1 裁决 R1/R3/R5/R6/R11/R16/R17）。
 *
 * 样本全部合成（`tests/dsh/synthetic.ts`），覆盖任务书点名的六类坏样本：
 * 坏行、坏帧、撕裂尾帧（帧层见 frames.test.ts）、重复 seq、usage 来源、未知事件；
 * 外加 v3 跳过、镜像去重、surfaceOp 两种写法、孤儿工具、时间精度、确定性。
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { msToUnixNano, type SessionNode } from '../../src/core/model.js';
import {
  MIN_SUPPORTED_FORMAT_VERSION,
  parseDshSession,
  parseDshSessions,
  pickHighestVersionSessionFile,
  sessionFileVersion,
} from '../../src/dsh/parse.js';
import { assertConservation, assertDeterministic, assertFieldCoverage } from '../helpers.js';
import {
  BASE_MS,
  compressFrames,
  event,
  makeSessionDir,
  sessionText,
  writeSessionFile,
  type SyntheticSession,
} from './synthetic.js';

/** 取第一个元素并断言非空（测试里比 `!` 更早给出定位信息）。 */
function first<T>(items: readonly T[], what = '元素'): T {
  const value = items[0];
  if (value === undefined) throw new Error(`期望至少一个${what}，实际为空`);
  return value;
}

/** extras.events 流水（事件级/未知字段的原文桶）。 */
function eventsOf(extras: Record<string, unknown>): Array<Record<string, unknown>> {
  const value = extras.events;
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

/** 按 type 过滤 extras.events。 */
function entriesOf(
  extras: Record<string, unknown>,
  type: string,
): Array<Record<string, unknown>> {
  return eventsOf(extras).filter((entry) => entry.type === type);
}

/** bigint 安全的序列化器（assertDeterministic 默认用 JSON.stringify，bigint 会抛）。 */
function serializeTree(tree: SessionNode): string {
  return JSON.stringify(tree, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

/** 标准合成会话：1 轮 / 1 步 / 1 工具，覆盖结构事件与非结构事件。 */
function canonicalSession(): SyntheticSession {
  return {
    id: 'sess-1',
    origin: 'subagent',
    headerExtra: { parentSession: 'sess-0' },
    events: [
      event('turn/start', 1, 1000, { turn: 1 }),
      // 实际数据里 user/message 常不带 turn/step，且先于 step/start 到达。
      event('user/message', 2, 1100, {
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'user' },
        role: 'user',
        id: 'm1',
      }),
      event('step/start', 3, 1200, { turn: 1, step: 1 }),
      event(
        'request/header',
        4,
        1250,
        { header: { config: { provider: 'p', model: 'm-1' }, tools: [] }, reason: 'initial' },
        // surfaceOp 对象写法：start/end 要归一到 startSeq/endSeq。
        { surfaceOp: { op: 'replace', start: 1, end: 1 } },
      ),
      event(
        'assistant/message',
        5,
        1500,
        {
          turn: 1,
          step: 1,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'hello' }],
            source: { kind: 'model', provider: 'p', model: 'm-1' },
            id: 'a1',
          },
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, totalTokens: 18 },
          stream: [{ chunk: 'he' }],
        },
        // surfaceOp 字符串写法。
        { surfaceOp: 'append' },
      ),
      event('tool/call', 6, 1600, {
        turn: 1,
        step: 1,
        callId: 'c1',
        name: 'read_file',
        arguments: '{"path":"a.txt"}',
      }),
      event('tool/result', 7, 1700, {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          toolCallId: 'c1',
          content: [{ type: 'text', text: 'ok' }],
          id: 't1',
          source: { kind: 'tool', callId: 'c1' },
        },
        meta: { path: 'a.txt', lines: 1 },
      }),
      event('step/end', 8, 1800, { turn: 1, step: 1 }),
      event('turn/end', 9, 1900, { turn: 1, reason: { kind: 'completed' } }),
      event('mystery/thing', 10, 1950, { x: 1 }),
      event('session/title', 11, 1960, { title: 'T', messageSeqs: [2, 5], source: 'llm' }),
    ],
  };
}

describe('会话身份与运行信息（DESIGN §4.1、R4、R6）', () => {
  it('信头字段进语义槽：id/version/origin/cwd/agentPreset/delegationDepth/isSeeded/parentSession/createdAt', () => {
    const dir = makeSessionDir();
    const tree = parseDshSession(writeSessionFile(dir, canonicalSession()));
    expect(tree.tool).toBe('dsh');
    expect(tree.sessionId).toBe('sess-1');
    expect(tree.agentLabel).toBe('subagent');
    expect(tree.origin).toBe('subagent');
    expect(tree.formatVersion).toBe(4);
    expect(tree.cwd).toBe('D:/work/demo');
    expect(tree.agentPreset).toBe('default');
    expect(tree.delegationDepth).toBe(0);
    expect(tree.isSeeded).toBe(false);
    expect(tree.parentSession).toBe('sess-0');
    expect(tree.createdAtMs).toBe(BASE_MS);
    expect(tree.extras.session_id_source).toBeUndefined();
  });

  it('缺 id 时用文件名去扩展名顶替，并标 session_id_source=filename（R6）', () => {
    const dir = makeSessionDir();
    // 主会话（无 origin）才回退到 'main'；这里单独造一个不带 origin 的会话。
    const session: SyntheticSession = {
      id: '',
      events: [event('turn/start', 1, 0, { turn: 1 })],
    };
    const path = writeSessionFile(dir, session, 'session-abc.jsonl.zstd');
    const tree = parseDshSession(path);
    expect(tree.sessionId).toBe('session-abc');
    expect(tree.extras.session_id_source).toBe('filename');
    expect(tree.agentLabel).toBe('main');
  });

  it('信头里契约之外的字段原样进 extras（session.<key>）', () => {
    const dir = makeSessionDir();
    const tree = parseDshSession(
      writeSessionFile(dir, {
        ...canonicalSession(),
        headerExtra: { brandNewField: { nested: true } },
      }),
    );
    expect(tree.extras['session.brandNewField']).toEqual({ nested: true });
  });
});

describe('事件 → 会话树四层（DESIGN §4.1/§5）', () => {
  it('轮 / 步 / 工具三层都建出来，编号与起止时间来自事件自带时间（R12/R13）', () => {
    const dir = makeSessionDir();
    const tree = parseDshSession(writeSessionFile(dir, canonicalSession()));

    expect(tree.turns).toHaveLength(1);
    const turn = first(tree.turns, '轮');
    expect(turn.extras.turn_number).toBe(1);
    expect(turn.startTimeUnixNano).toBe(msToUnixNano(BASE_MS + 1000));
    expect(turn.endTimeUnixNano).toBe(msToUnixNano(BASE_MS + 1900));
    expect(turn.endReason).toBe('completed');

    const step = first(turn.steps, '步');
    expect(step.extras.step_number).toBe(1);
    expect(step.startTimeUnixNano).toBe(msToUnixNano(BASE_MS + 1200));
    expect(step.endTimeUnixNano).toBe(msToUnixNano(BASE_MS + 1800));
    expect(step.model).toBe('m-1');

    const tool = first(step.tools, '工具');
    expect(tool.toolName).toBe('read_file');
    expect(tool.toolCallId).toBe('c1');
    expect(tool.argsText).toBe('{"path":"a.txt"}');
    expect(tool.resultText).toBe('ok');
    expect(tool.isError).toBeUndefined();
    expect(tool.pairing).toBe('paired');
    expect(tool.startTimeUnixNano).toBe(msToUnixNano(BASE_MS + 1600));
    expect(tool.endTimeUnixNano).toBe(msToUnixNano(BASE_MS + 1700));
  });

  it('输入消息并入下一步的 inputMessages（先到先挂，不串味）', () => {
    const dir = makeSessionDir();
    const step = first(first(parseDshSession(writeSessionFile(dir, canonicalSession())).turns, '轮').steps, '步');
    expect(step.inputMessages).toHaveLength(1);
    expect(JSON.stringify(step.inputMessages)).toContain('hi');
  });

  it('assistant/message 原文进 outputMessages（不截断、不改写）', () => {
    const dir = makeSessionDir();
    const step = first(first(parseDshSession(writeSessionFile(dir, canonicalSession())).turns, '轮').steps, '步');
    expect(step.outputMessages).toHaveLength(1);
    const message = first(step.outputMessages ?? [], '输出消息') as Record<string, unknown>;
    expect(message.id).toBe('a1');
    expect(message.role).toBe('assistant');
  });

  it('surfaceOp 两种写法都认：字符串 → {op}；对象 start/end → startSeq/endSeq', () => {
    const dir = makeSessionDir();
    const tree = parseDshSession(writeSessionFile(dir, canonicalSession()));
    const step = first(first(tree.turns, '轮').steps, '步');

    const assistantEntry = first(entriesOf(step.extras, 'assistant/message'), 'assistant 事件流水');
    expect(assistantEntry.surfaceOp).toEqual({ op: 'append' });

    const requestEntry = first(entriesOf(step.extras, 'request/header'), 'request/header 事件流水');
    expect(requestEntry.surfaceOp).toEqual({ op: 'replace', start: 1, end: 1, startSeq: 1, endSeq: 1 });
    // 非结构事件存整条原文：data 原样保留（含 header / reason）。
    const requestData = requestEntry.data as Record<string, unknown>;
    expect(requestData.reason).toBe('initial');
    expect(requestData.header).toBeDefined();
  });

  it('tool/result 的 meta / message 其余字段（除 content）原样进 extras', () => {
    const dir = makeSessionDir();
    const step = first(first(parseDshSession(writeSessionFile(dir, canonicalSession())).turns, '轮').steps, '步');
    const tool = first(step.tools, '工具');
    const entry = first(entriesOf(tool.extras, 'tool/result'), 'tool/result 事件流水');
    expect(entry.meta).toEqual({ path: 'a.txt', lines: 1 });
    expect(entry.message).toMatchObject({ id: 't1', role: 'tool', toolCallId: 'c1' });
    expect(entry.message).not.toHaveProperty('content');
  });
});

describe('usage 口径（DESIGN §5、R1/R11/R15/R16）', () => {
  it('只取 assistant/message.data.usage，并映射到 Usage 五字段；totalTokens 进 extras 不重算', () => {
    const dir = makeSessionDir();
    const step = first(first(parseDshSession(writeSessionFile(dir, canonicalSession())).turns, '轮').steps, '步');
    expect(step.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 });
    expect(step.extras['usage.total_tokens']).toBe(18);
    expect(step.usage?.reasoningTokens).toBeUndefined();
    expect(step.usage?.cacheWriteTokens).toBeUndefined();
  });

  it('assistant/attempt 的 usage 不进 step.usage（R16：否则重复计账）', () => {
    const dir = makeSessionDir();
    const session: SyntheticSession = {
      id: 'sess-attempt',
      events: [
        event('turn/start', 1, 0, { turn: 1 }),
        event('step/start', 2, 10, { turn: 1, step: 1 }),
        event('assistant/attempt', 3, 20, { turn: 1, step: 1, stream: [], usage: { inputTokens: 999 } }),
        event('step/end', 4, 30, { turn: 1, step: 1 }),
        event('turn/end', 5, 40, { turn: 1, reason: { kind: 'completed' } }),
      ],
    };
    const tree = parseDshSession(writeSessionFile(dir, session));
    const step = first(first(tree.turns, '轮').steps, '步');
    expect(step.usage).toBeUndefined();
    const entry = first(entriesOf(step.extras, 'assistant/attempt'), 'assistant/attempt 流水');
    expect(entry.usage).toEqual({ inputTokens: 999 });
  });

  it('非负整数校验失败的原样进 extras，不猜、不填 0', () => {
    const dir = makeSessionDir();
    const session: SyntheticSession = {
      id: 'sess-bad-usage',
      events: [
        event('turn/start', 1, 0, { turn: 1 }),
        event('step/start', 2, 10, { turn: 1, step: 1 }),
        event('assistant/message', 3, 20, {
          turn: 1,
          step: 1,
          message: { role: 'assistant', content: [], id: 'a1' },
          usage: { inputTokens: '12', outputTokens: -3 },
        }),
      ],
    };
    const step = first(first(parseDshSession(writeSessionFile(dir, session)).turns, '轮').steps, '步');
    expect(step.usage).toBeUndefined();
    expect(step.extras['usage.inputTokens']).toBe('12');
    expect(step.extras['usage.outputTokens']).toBe(-3);
  });

  it('同一步出现第二条 usage：保留第一条，计 duplicateUsage，第二条原文进 extras', () => {
    const dir = makeSessionDir();
    const session: SyntheticSession = {
      id: 'sess-dup-usage',
      events: [
        event('turn/start', 1, 0, { turn: 1 }),
        event('step/start', 2, 10, { turn: 1, step: 1 }),
        event('assistant/message', 3, 20, {
          turn: 1,
          step: 1,
          message: { role: 'assistant', content: [], id: 'a1' },
          usage: { inputTokens: 10 },
        }),
        event('assistant/message', 4, 30, {
          turn: 1,
          step: 1,
          message: { role: 'assistant', content: [], id: 'a2' },
          usage: { inputTokens: 20 },
        }),
      ],
    };
    const tree = parseDshSession(writeSessionFile(dir, session));
    const step = first(first(tree.turns, '轮').steps, '步');
    expect(step.usage).toEqual({ inputTokens: 10 });
    expect(tree.stats.duplicateUsage).toBe(1);
    expect(entriesOf(step.extras, 'assistant/message').some((entry) => JSON.stringify(entry.usage) === '{"inputTokens":20}')).toBe(true);
  });
});

describe('compact 边界（DESIGN §5、R9）', () => {
  it('compaction 的用量不混进 step.usage；turn 打 compact 标记，原文全留', () => {
    const dir = makeSessionDir();
    const session: SyntheticSession = {
      id: 'sess-compact',
      events: [
        event('turn/start', 1, 0, { turn: 1 }),
        event('step/start', 2, 10, { turn: 1, step: 1 }),
        event('assistant/message', 3, 20, {
          turn: 1,
          step: 1,
          message: { role: 'assistant', content: [], id: 'a1' },
          usage: { inputTokens: 10, outputTokens: 2 },
        }),
        event('compaction/start', 4, 30, { compactionId: 'k1', turn: 1 }),
        event('compaction/summary', 5, 40, {
          compactionId: 'k1',
          turn: 1,
          summary: [{ type: 'text', text: '摘要' }],
          shadowedRange: { start: 1, end: 3 },
          shadowedSeqs: [1, 5],
          shadowedTokenCount: 900,
          provider: 'deepseek-official',
          model: 'deepseek-flash',
          maxTokens: 1024,
          usage: { inputTokens: 777, outputTokens: 88, cacheReadTokens: 66 },
        }),
        event('compaction/end', 6, 50, { compactionId: 'k1', turn: 1 }),
        event('step/end', 7, 60, { turn: 1, step: 1 }),
        event('turn/end', 8, 70, { turn: 1, reason: { kind: 'completed' } }),
      ],
    };
    const tree = parseDshSession(writeSessionFile(dir, session));
    const turn = first(tree.turns, '轮');
    const step = first(turn.steps, '步');
    expect(step.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
    expect(tree.stats.duplicateUsage).toBe(0);
    expect(turn.compact).toBe(true);
    // 压缩用量与遮蔽范围原样留在轮 extras，等组装层单独成 span。
    const summaryEntry = first(entriesOf(turn.extras, 'compaction/summary'), '压缩摘要流水');
    const summaryData = summaryEntry.data as Record<string, unknown>;
    expect(summaryData.usage).toEqual({ inputTokens: 777, outputTokens: 88, cacheReadTokens: 66 });
    expect(summaryData.shadowedSeqs).toEqual([1, 5]);
    expect(step.extras.compact).toBeUndefined();
  });
});

describe('工具配对（DESIGN §6：孤儿与重复结果合法）', () => {
  it('孤儿结果 → orphan_result，并计入 unpairedTools', () => {
    const dir = makeSessionDir();
    const session: SyntheticSession = {
      id: 'sess-orphan-result',
      events: [
        event('turn/start', 1, 0, { turn: 1 }),
        event('step/start', 2, 10, { turn: 1, step: 1 }),
        event('tool/result', 3, 20, {
          turn: 1,
          step: 1,
          message: { role: 'tool', toolCallId: 'nope', content: [{ type: 'text', text: 'late' }], id: 't1' },
        }),
      ],
    };
    const tree = parseDshSession(writeSessionFile(dir, session));
    const tool = first(first(first(tree.turns, '轮').steps, '步').tools, '工具');
    expect(tool.pairing).toBe('orphan_result');
    expect(tool.resultText).toBe('late');
    expect(tree.stats.unpairedTools).toBe(1);
  });

  it('迟到结果（step/end 之后到达）仍按 callId 配回原工具', () => {
    const dir = makeSessionDir();
    const session: SyntheticSession = {
      id: 'sess-late-result',
      events: [
        event('turn/start', 1, 0, { turn: 1 }),
        event('step/start', 2, 10, { turn: 1, step: 1 }),
        event('tool/call', 3, 20, { turn: 1, step: 1, callId: 'c1', name: 'run', arguments: '{}' }),
        event('step/end', 4, 30, { turn: 1, step: 1 }),
        event('tool/result', 5, 40, { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'done' }], id: 't1' } }),
        event('turn/end', 6, 50, { turn: 1, reason: { kind: 'completed' } }),
      ],
    };
    const tree = parseDshSession(writeSessionFile(dir, session));
    const tool = first(first(first(tree.turns, '轮').steps, '步').tools, '工具');
    expect(tool.pairing).toBe('paired');
    expect(tool.resultText).toBe('done');
    expect(tool.endTimeUnixNano).toBe(msToUnixNano(BASE_MS + 40));
    expect(tree.stats.unpairedTools).toBe(0);
  });

  it('重复结果 → duplicate，保留首份结果，重复原文进 extras（不吞不猜）', () => {
    const dir = makeSessionDir();
    const session: SyntheticSession = {
      id: 'sess-dup-result',
      events: [
        event('turn/start', 1, 0, { turn: 1 }),
        event('step/start', 2, 10, { turn: 1, step: 1 }),
        event('tool/call', 3, 20, { turn: 1, step: 1, callId: 'c1', name: 'run', arguments: '{}' }),
        event('tool/result', 4, 30, {
          turn: 1,
          step: 1,
          message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'first' }], id: 't1' },
        }),
        event('tool/result', 5, 40, {
          turn: 1,
          step: 1,
          message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'second' }], id: 't2' },
        }),
      ],
    };
    const tree = parseDshSession(writeSessionFile(dir, session));
    const tool = first(first(first(tree.turns, '轮').steps, '步').tools, '工具');
    expect(tool.pairing).toBe('duplicate');
    expect(tool.resultText).toBe('first');
    // 重复的那条结果原文不许丢：留在 extras 事件流水里（首份结果也在，两份都可对账）。
    const resultEntries = entriesOf(tool.extras, 'tool/result');
    expect(resultEntries.some((entry) => (entry.message as Record<string, unknown>).id === 't2')).toBe(true);
    // 重复结果不是「配对干净」，DESIGN §6 口径与孤儿同类计数。
    expect(tree.stats.unpairedTools).toBe(1);
  });

  it('调用无结果 → orphan_call，并计入 unpairedTools', () => {
    const dir = makeSessionDir();
    const session: SyntheticSession = {
      id: 'sess-orphan-call',
      events: [
        event('turn/start', 1, 0, { turn: 1 }),
        event('step/start', 2, 10, { turn: 1, step: 1 }),
        event('tool/call', 3, 20, { turn: 1, step: 1, callId: 'c9', name: 'wait', arguments: '{}' }),
      ],
    };
    const tree = parseDshSession(writeSessionFile(dir, session));
    expect(first(first(first(tree.turns, '轮').steps, '步').tools, '工具').pairing).toBe('orphan_call');
    expect(tree.stats.unpairedTools).toBe(1);
  });

  it('isError 从 data.error 推出（message 上没有 isError 时）', () => {
    const dir = makeSessionDir();
    const session: SyntheticSession = {
      id: 'sess-error',
      events: [
        event('turn/start', 1, 0, { turn: 1 }),
        event('step/start', 2, 10, { turn: 1, step: 1 }),
        event('tool/call', 3, 20, { turn: 1, step: 1, callId: 'c1', name: 'edit', arguments: '{}' }),
        event('tool/result', 4, 30, {
          turn: 1,
          step: 1,
          error: { name: 'FsError', code: 'FS_AMBIGUOUS_EDIT' },
          message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'failed' }], id: 't1' },
        }),
      ],
    };
    const tool = first(first(first(parseDshSession(writeSessionFile(dir, session)).turns, '轮').steps, '步').tools, '工具');
    expect(tool.isError).toBe(true);
  });
});

describe('坏样本容错（AGENTS：跳过并计数，不抛）', () => {
  it('坏行不抛异常并计数，好行照常入树', () => {
    const dir = makeSessionDir();
    const path = writeSessionFile(dir, {
      ...canonicalSession(),
      rawLines: ['{ this is not json', '["array","is","not","object"]'],
    });
    const tree = parseDshSession(path);
    expect(tree.stats.badLines).toBe(2);
    expect(tree.stats.skippedRecords).toBeGreaterThanOrEqual(2);
    expect(tree.turns).toHaveLength(1);
    assertConservation(tree);
  });

  it('坏帧只丢该帧内容，其余帧的行照常解析并计 failedFrames', () => {
    const dir = makeSessionDir();
    const session: SyntheticSession = {
      id: 'sess-bad-frame',
      events: [
        event('turn/start', 1, 0, { turn: 1 }),
        event('step/start', 2, 10, { turn: 1, step: 1 }),
        event('step/end', 3, 20, { turn: 1, step: 1 }),
        event('turn/end', 4, 30, { turn: 1, reason: { kind: 'completed' } }),
      ],
    };
    const lines = sessionText(session).split('\n').filter((line) => line !== '');
    const path = join(dir, 'session.v4.jsonl.zstd');
    // 前两行一帧 + 一个坏帧 + 其余行一帧。
    writeFileSync(
      path,
      Buffer.concat([
        compressFrames([`${lines[0]}\n${lines[1]}\n`]),
        Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01, 0x02, 0x03]),
        compressFrames([`${lines.slice(2).join('\n')}\n`]),
      ]),
    );
    const tree = parseDshSession(path);
    expect(tree.stats.failedFrames).toBe(1);
    expect(tree.stats.frames).toBe(2);
    expect(tree.turns).toHaveLength(1);
    expect(first(tree.turns, '轮').steps).toHaveLength(1);
    assertConservation(tree);
  });

  it('重复 seq 只算一次：deduped 计数，树里不重复建节点', () => {
    const dir = makeSessionDir();
    const session: SyntheticSession = {
      id: 'sess-dup-seq',
      events: [
        event('turn/start', 1, 0, { turn: 1 }),
        event('step/start', 2, 10, { turn: 1, step: 1 }),
        event('tool/call', 3, 20, { turn: 1, step: 1, callId: 'c1', name: 'run', arguments: '{}' }),
        // 同 seq 的镜像副本（模拟镜像目录重复行）
        event('tool/call', 3, 20, { turn: 1, step: 1, callId: 'c1', name: 'run', arguments: '{}' }),
      ],
    };
    const tree = parseDshSession(writeSessionFile(dir, session));
    expect(tree.stats.deduped).toBe(1);
    expect(tree.stats.skippedRecords).toBe(1);
    expect(first(first(tree.turns, '轮').steps, '步').tools).toHaveLength(1);
    assertConservation(tree);
  });

  it('未知事件类型：计数 + 原文保留进 extras，不猜语义', () => {
    const dir = makeSessionDir();
    const tree = parseDshSession(writeSessionFile(dir, canonicalSession()));
    expect(tree.stats.unknownEventTypes).toEqual({ 'mystery/thing': 1 });
    const raw = first(entriesOf(tree.extras, 'mystery/thing'), '未知事件原文');
    expect(raw.data).toEqual({ x: 1 });
    expect(raw.seq).toBe(10);
  });

  it('19 位纳秒级 time：不猜，节点时间缺省、原文留在 extras（R12）', () => {
    const dir = makeSessionDir();
    const session: SyntheticSession = {
      id: 'sess-big-time',
      events: [
        event('turn/start', 1, 0, { turn: 1 }, { time: '1763856001000000000' }),
        event('step/start', 2, 10, { turn: 1, step: 1 }),
      ],
    };
    const tree = parseDshSession(writeSessionFile(dir, session));
    const turn = first(tree.turns, '轮');
    expect(turn.startTimeUnixNano).toBeUndefined();
    const entry = first(entriesOf(turn.extras, 'turn/start'), 'turn/start 流水');
    expect(entry.time).toBe('1763856001000000000');
    assertConservation(tree);
  });
});

describe('版本判定（DESIGN §2/§5、R5）', () => {
  it('v3 会话整文件跳过：仍产出只含统计的会话树，无轮/步（计数不猜）', () => {
    const dir = makeSessionDir();
    const tree = parseDshSession(
      writeSessionFile(dir, {
        version: 3,
        id: 'sess-v3',
        events: [
          event('turn/start', 1, 0, { turn: 1 }),
          event('user/message', 2, 10, { content: [{ type: 'text', text: 'old' }], role: 'user', id: 'm1' }),
        ],
      }),
    );
    expect(tree.formatVersion).toBe(3);
    expect(tree.turns).toEqual([]);
    expect(tree.stats.skippedV3).toBe(1);
    expect(tree.stats.producedSpans).toBe(1);
    expect(tree.stats.skippedRecords).toBe(tree.stats.inputRecords);
    expect(tree.sourceRefs).toEqual([]);
    assertConservation(tree);
  });

  it('缺信头（无法判版）：计 parseErrors，整文件跳过，不猜版本', () => {
    const dir = makeSessionDir();
    const path = writeSessionFile(
      dir,
      {
        version: null,
        events: [event('turn/start', 1, 0, { turn: 1 })],
      },
      'session-orphan.jsonl.zstd',
    );
    const tree = parseDshSession(path);
    expect(tree.formatVersion).toBeUndefined();
    expect(tree.stats.parseErrors).toBe(1);
    expect(tree.stats.skippedRecords).toBe(tree.stats.inputRecords);
    expect(tree.turns).toEqual([]);
    assertConservation(tree);
  });

  it('目录输入只读最高版本文件（v4 胜过 v3）', () => {
    const dir = makeSessionDir();
    writeSessionFile(dir, { ...canonicalSession(), version: 3, id: 'mirror' }, 'session.v3.jsonl.zstd');
    writeSessionFile(dir, { ...canonicalSession(), version: 4 }, 'session.v4.jsonl.zstd');
    const tree = parseDshSession(dir);
    expect(tree.formatVersion).toBe(4);
    expect(tree.stats.skippedV3).toBe(0);
  });

  it('目录内没有会话文件时抛明确错误（不静默返回空）', () => {
    const dir = makeSessionDir();
    writeFileSync(join(dir, 'notes.txt'), 'x');
    expect(() => parseDshSession(dir)).toThrow(/没有 session/);
  });

  it('sessionFileVersion / pickHighestVersionSessionFile 按版本规则工作', () => {
    expect(sessionFileVersion('session.jsonl.zstd')).toBe(0);
    expect(sessionFileVersion('session.v4.jsonl.zstd')).toBe(4);
    expect(sessionFileVersion('session.v11.jsonl.zstd')).toBe(11);
    expect(sessionFileVersion('session.v4.jsonl')).toBeUndefined();
    expect(
      pickHighestVersionSessionFile([
        '/s/session.v3.jsonl.zstd',
        '/s/session.v10.jsonl.zstd',
        '/s/session.v4.jsonl.zstd',
      ]),
    ).toBe('/s/session.v10.jsonl.zstd');
    expect(pickHighestVersionSessionFile(['/s/other.txt'])).toBeUndefined();
    expect(MIN_SUPPORTED_FORMAT_VERSION).toBe(4);
  });
});

describe('镜像去重与批量（R17）', () => {
  it('R8：单个文件读失败不中断整批，该文件单独出错误树', () => {
    const dir = makeSessionDir();
    const good = writeSessionFile(dir, canonicalSession());
    const missing = join(dir, 'session-dead', 'session.v4.jsonl.zstd');
    const trees = parseDshSessions([good, missing]);
    expect(trees).toHaveLength(2);
    // 输入次序即输出次序：好的在前，坏的在后。
    const goodTree = first(trees, '会话树');
    expect(goodTree.sessionId).toBe('sess-1');
    expect(goodTree.turns).toHaveLength(1);
    const errorTree = trees[1] as SessionNode;
    expect(errorTree.turns).toHaveLength(0);
    expect(errorTree.stats.parseErrors).toBe(1);
    expect(errorTree.stats.producedSpans).toBe(0);
    // 文件名是版本名，会话标识取所在目录名（不同会话不撞 id）。
    expect(errorTree.sessionId).toBe('session-dead');
    const parseError = errorTree.extras.parse_error as Record<string, unknown>;
    expect(parseError.path).toBe(missing);
    expect(String(parseError.message)).toMatch(/ENOENT|no such file/i);
  });

  it('同 session 的镜像文件合成一棵树：按 (session_id, seq) 去重', () => {
    const dirA = makeSessionDir();
    const dirB = makeSessionDir();
    const session = canonicalSession();
    const pathA = writeSessionFile(dirA, session);
    const pathB = writeSessionFile(dirB, session);
    const trees = parseDshSessions([pathA, pathB]);
    expect(trees).toHaveLength(1);
    const tree = first(trees, '会话树');
    expect(tree.turns).toHaveLength(1);
    expect(first(tree.turns, '轮').steps).toHaveLength(1);
    // 第二份副本的信头 + 全部事件都算去重。
    expect(tree.stats.deduped).toBe(1 + session.events.length);
    expect(tree.stats.inputRecords).toBe(2 * (1 + session.events.length));
    assertConservation(tree);
  });

  it('不同 session 不合并；同 id 不同 agent 也各自成树（R4）', () => {
    const dirA = makeSessionDir();
    const dirB = makeSessionDir();
    const dirC = makeSessionDir();
    const main = writeSessionFile(dirA, { ...canonicalSession(), id: 'same', origin: 'subagent' });
    const sub = writeSessionFile(dirB, {
      ...canonicalSession(),
      id: 'same',
      origin: 'subagent',
      headerExtra: {},
    });
    const other = writeSessionFile(dirC, { ...canonicalSession(), id: 'other' });
    const trees = parseDshSessions([main, sub, other]);
    // 前两个同 (id, agent) → 合并成 1；第三个 id 不同 → 另 1。
    expect(trees).toHaveLength(2);
    expect(trees.map((tree) => tree.sessionId)).toEqual(['same', 'other']);
  });

  it('同组内低版本镜像文件整文件计 skippedV3，不参与建树', () => {
    const dirA = makeSessionDir();
    const dirB = makeSessionDir();
    const v4 = writeSessionFile(dirA, { ...canonicalSession(), version: 4 });
    const v3 = writeSessionFile(dirB, { ...canonicalSession(), version: 3 }, 'session.v3.jsonl.zstd');
    const trees = parseDshSessions([v4, v3]);
    expect(trees).toHaveLength(1);
    const tree = first(trees, '会话树');
    expect(tree.formatVersion).toBe(4);
    expect(tree.stats.skippedV3).toBe(1);
    expect(tree.turns).toHaveLength(1);
    assertConservation(tree);
  });
});

describe('确定性输出（DESIGN §10）', () => {
  it('同输入解析两次，结构逐字节一致（含 bigint 时间）', async () => {
    const dir = makeSessionDir();
    const path = writeSessionFile(dir, canonicalSession());
    await assertDeterministic(() => parseDshSession(path), {
      serialize: serializeTree,
      reason: 'canonical v4 session',
    });
  });
});

describe('三件套断言（DESIGN §4.5/§9）', () => {
  it('标准会话：条数守恒 + 字段齐全', () => {
    const dir = makeSessionDir();
    const tree = parseDshSession(writeSessionFile(dir, canonicalSession()));
    assertConservation(tree);
    assertFieldCoverage(tree);
    expect(tree.stats.frames).toBe(1);
    expect(tree.stats.failedFrames).toBe(0);
    expect(tree.stats.producedSpans).toBe(4); // 根 + 1 轮 + 1 步 + 1 工具
    // 消费掉的字段不应再在 extras 里重复出现。
    const step = first(first(tree.turns, '轮').steps, '步');
    const assistantEntry = first(entriesOf(step.extras, 'assistant/message'), 'assistant 流水');
    expect(assistantEntry.message).toBeUndefined();
    expect(assistantEntry.usage).toBeUndefined();
  });
});
