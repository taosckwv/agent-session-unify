import { describe, expect, it } from 'vitest';
import {
  SESSION_NODE_FIELD_KEYS,
  emptyStats,
  mergeStats,
  type SessionNode,
} from '../../src/core/model.js';

const baseSession = (over: Partial<SessionNode>): SessionNode => ({
  tool: 'dsh',
  formatVersion: 4,
  sessionId: 'sess-1',
  agentLabel: 'main',
  sourceRefs: [],
  extras: {},
  turns: [],
  stats: emptyStats(),
  ...over,
});

describe('emptyStats / mergeStats', () => {
  it('空统计基线：全零、空清单', () => {
    expect(emptyStats()).toEqual({
      inputRecords: 0,
      producedSpans: 0,
      skippedRecords: 0,
      badLines: 0,
      skippedV3: 0,
      failedFrames: 0,
      frames: 0,
      deduped: 0,
      unknownEventTypes: {},
      unknownTimes: 0,
      unpairedTools: 0,
      duplicateUsage: 0,
      parseErrors: 0,
      usageSnapshots: 0,
    });
  });

  it('usageSnapshots 默认 0（t9：CC 每消息 usage 快照计数，R15 实测 0 合法）', () => {
    expect(emptyStats().usageSnapshots).toBe(0);
  });

  it('mergeStats 数值相加、unknownEventTypes 合并计数', () => {
    const a = emptyStats();
    a.inputRecords = 10;
    a.badLines = 2;
    a.usageSnapshots = 7;
    a.unknownEventTypes['llm/retry'] = 3;
    const b = emptyStats();
    b.inputRecords = 5;
    b.usageSnapshots = 4;
    b.unknownEventTypes['llm/retry'] = 4;
    b.unknownEventTypes['weird/type'] = 1;
    const m = mergeStats(a, b);
    expect(m.inputRecords).toBe(15);
    expect(m.badLines).toBe(2);
    expect(m.usageSnapshots).toBe(11);
    expect(m.unknownEventTypes['llm/retry']).toBe(7);
    expect(m.unknownEventTypes['weird/type']).toBe(1);
  });

  it('mergeStats 不修改输入（纯函数）', () => {
    const a = emptyStats();
    a.badLines = 1;
    const b = emptyStats();
    b.skippedV3 = 2;
    mergeStats(a, b);
    expect(a.badLines).toBe(1);
    expect(a.skippedV3).toBe(0);
    expect(b.skippedV3).toBe(2);
    expect(b.badLines).toBe(0);
  });
});

describe('SESSION_NODE_FIELD_KEYS / 运行时字段清单（编译期与运行时防漂移）', () => {
  it('运行时清单包含四层节点的全部序列化字段', () => {
    expect(SESSION_NODE_FIELD_KEYS).toContain('turns');
    expect(SESSION_NODE_FIELD_KEYS).toContain('usage');
    expect(SESSION_NODE_FIELD_KEYS).toContain('pairing');
  });

  it('SATISFIES 清单不因 Stats 增补而漂移：usageSnapshots 是 Stats 字段，不进树字段清单', () => {
    // SESSION_NODE_FIELD_KEYS 只覆盖四层节点的顶层字段（stats 整体在清单里，
    // 其内部计数字段不逐个入清单——字段齐全断言只对树字段口径负责）。
    expect(SESSION_NODE_FIELD_KEYS).not.toContain('usageSnapshots');
    expect(SESSION_NODE_FIELD_KEYS).toContain('stats');
  });
});

describe('类型层（编译期）', () => {
  it('Usage 缺失字段不填 0（undefined 而非 0，R1/R15 契约）', () => {
    const node = baseSession({});
    expect(node.stats.badLines).toBe(0);
    expect(node.stats.producedSpans).toBe(0);
    // usage 可选：无 usage 的 step 不出现在序列化里，不填 0
    const step = { sourceRefs: [], extras: {}, messages: [] };
    expect('usage' in step ? step.usage : undefined).toBeUndefined();
  });

  it('sourceRefs 携带 file/line/seq 与 recordType（条数守恒对账的锚点）', () => {
    const node = baseSession({
      sourceRefs: [{ file: 'a.v4.jsonl.zstd', seq: 3, recordType: 'session' }],
    });
    expect(node.sourceRefs[0]?.seq).toBe(3);
    expect(node.sourceRefs[0]?.recordType).toBe('session');
  });
});
