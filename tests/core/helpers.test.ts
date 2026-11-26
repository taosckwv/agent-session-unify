import { describe, expect, it } from 'vitest';
import type { SessionNode } from '../../src/core/model.js';
import {
  assertConservation,
  assertDeterministic,
  assertFieldCoverage,
  countTreeNodes,
  coveredSourceRefCount,
} from '../helpers.js';

/** 造一棵小型会话树：1 轮 / 1 步 / 2 工具，全部记录有归属 */
function makeTree(over: Partial<SessionNode> = {}): SessionNode {
  return {
    tool: 'dsh',
    formatVersion: 4,
    sessionId: 'sess-1',
    agentLabel: 'main',
    sourceRefs: [
      { file: 's.v4.jsonl.zstd', seq: 1, recordType: 'session' },
      { file: 's.v4.jsonl.zstd', seq: 2, recordType: 'turn/start' },
    ],
    extras: {},
    stats: {
      inputRecords: 7,
      producedSpans: 5,
      skippedRecords: 1, // badLines=1：坏行计入跳过/丢弃（R7 守恒口径）
      badLines: 1,
      skippedV3: 0,
      failedFrames: 0,
      frames: 3,
      deduped: 0,
      unknownEventTypes: {},
      unknownTimes: 0,
      unpairedTools: 1,
      duplicateUsage: 0,
      parseErrors: 0,
    },
    turns: [
      {
        sourceRefs: [{ file: 's.v4.jsonl.zstd', seq: 3, recordType: 'assistant/message' }],
        extras: {},
        steps: [
          {
            sourceRefs: [{ file: 's.v4.jsonl.zstd', seq: 4, recordType: 'assistant/message' }],
            extras: {},
            inputMessages: [],
            outputMessages: [],
            tools: [
              {
                toolName: 'Read',
                sourceRefs: [{ file: 's.v4.jsonl.zstd', seq: 5, recordType: 'tool/call' }],
                extras: {},
                pairing: 'paired',
                argsText: 'sk-abc123',
                resultText: 'ok',
              },
              {
                toolName: 'Read',
                sourceRefs: [{ file: 's.v4.jsonl.zstd', seq: 6, recordType: 'tool/call' }],
                extras: {},
                pairing: 'orphan_call',
              },
            ],
          },
        ],
      },
    ],
    ...over,
  };
}

describe('countTreeNodes', () => {
  it('四层全部计数（会话/轮/步/工具）', () => {
    const c = countTreeNodes(makeTree());
    expect(c).toEqual({ sessions: 1, turns: 1, steps: 1, tools: 2 });
  });

  it('空树 = 只有会话节点', () => {
    const c = countTreeNodes(makeTree({ turns: [] }));
    expect(c).toEqual({ sessions: 1, turns: 0, steps: 0, tools: 0 });
  });
});

describe('coveredSourceRefCount', () => {
  it('所有挂 sourceRefs 的节点都被统计（条数守恒的分子）', () => {
    expect(coveredSourceRefCount(makeTree())).toBe(6);
  });
});

describe('assertConservation（R7 口径）', () => {
  it('守恒时通过：归属 + 跳过/丢弃 = 输入', () => {
    expect(() =>
      assertConservation(makeTree(), {
        inputRecords: 7,
        skippedRecords: 1, // badLines=1 计入跳过侧
        reason: '测试样本',
      }),
    ).not.toThrow();
  });

  it('凭空消失时抛错：归属 + 跳过 < 输入', () => {
    expect(() =>
      assertConservation(makeTree(), {
        inputRecords: 99,
        skippedRecords: 0,
        reason: '测试样本',
      }),
    ).toThrow(/守恒|conservation/i);
  });

  it('凭空多出时抛错：归属 + 跳过 > 输入', () => {
    expect(() =>
      assertConservation(makeTree(), {
        inputRecords: 2,
        skippedRecords: 0,
        reason: '测试样本',
      }),
    ).toThrow(/守恒|conservation/i);
  });

  it('把输入计进跳过（v3 整文件跳过，R5）也守恒', () => {
    const tree = makeTree({ turns: [] });
    tree.stats.skippedRecords = 7;
    tree.sourceRefs = [];
    // covered=0, skipped=7, input=7 → 守恒
    expect(() =>
      assertConservation(tree, {
        inputRecords: 7,
        skippedRecords: 7,
        reason: 'v3 整文件跳过',
      }),
    ).not.toThrow();
  });

  it('用树内 stats 对账时同样有效', () => {
    const tree = makeTree();
    tree.stats.inputRecords = 7; // covered 6 + badLines 1
    expect(() =>
      assertConservation(tree, { reason: '树内 stats' }),
    ).not.toThrow();
  });
});

describe('assertFieldCoverage（字段齐全）', () => {
  it('每个输入字段都有明确去向：树内无未知类型标记时通过', () => {
    expect(() => assertFieldCoverage(makeTree())).not.toThrow();
  });

  it('出现未识别字段标记时抛错并点名清单（契约外字段不许出现）', () => {
    const tree = makeTree();
    // 伪造一个绕过三去向纪律的契约外字段
    (tree as unknown as Record<string, unknown>).weirdField = 'x';
    expect(() => assertFieldCoverage(tree)).toThrow(/weirdField/);
  });

  it('未识别事件被计数（正数）是合法去向，不抛错', () => {
    const tree = makeTree();
    tree.stats.unknownEventTypes['weird/type'] = 2;
    expect(() => assertFieldCoverage(tree)).not.toThrow();
  });

  it('unknownEventTypes 出现零值键（统计口径写脏）时抛错', () => {
    const tree = makeTree();
    tree.stats.unknownEventTypes['ghost/type'] = 0;
    expect(() => assertFieldCoverage(tree)).toThrow(/ghost\/type/);
  });
});

describe('assertDeterministic（两次解析一致）', () => {
  it('同一输入两次解析产出相同序列化结果', async () => {
    await expect(
      assertDeterministic(() => makeTree(), {
        serialize: (t) => JSON.stringify(t),
        reason: '测试样本',
      }),
    ).resolves.toBe(undefined);
  });

  it('两次解析结果不同时抛错', async () => {
    let n = 0;
    await expect(
      assertDeterministic(
        () => {
          n += 1;
          return makeTree({ agentLabel: `main-${n}` });
        },
        { serialize: (t) => JSON.stringify(t), reason: '非确定样本' },
      ),
    ).rejects.toThrow(/一致|deterministic/i);
  });
});
