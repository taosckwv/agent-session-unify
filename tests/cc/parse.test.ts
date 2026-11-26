/**
 * cc/parse.ts 单元测试（DESIGN §6/§9，t1 裁决 R2/R4/R9）。
 *
 * 全部用合成记录（AGENTS：仓库不允许真实会话文件），逐条覆盖：
 * - 按 message.id 聚合、usage 取最终快照且只记一次（R2 修订/t9）；
 * - 用户消息切 turn、tool_result 不开 turn；
 * - tool_use.id ↔ tool_result.tool_use_id 配对，孤儿/重复结果；
 * - compact_boundary 用 logicalParentUuid 在 turn 层重接（R9）；
 * - 无 version 不猜、原样保留（DESIGN §6）；
 * - 认不出的记录保留并计数；坏行跳过计数不抛（受 §4.4）；
 * - sidechain agent 标识每文件唯一（R4 修订/t9）、文件名兜底 sessionId（R6）；
 * - 跳过 .orphaned-* / .superseded-* 重写副本（R7 整文件计跳过）。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CC_PLACEHOLDER_TOOL_NAME,
  isCcSkippedSessionFile,
  parseCcJsonl,
  parseCcSession,
} from '../../src/cc/parse.js';
import type { SessionNode, StepNode, ToolNode, TurnNode } from '../../src/core/model.js';
import { deriveSpanId, sessionKey, sessionSpanPath } from '../../src/core/ids.js';
import { assertConservation, assertDeterministic, countTreeNodes } from '../helpers.js';

/** 合成记录时间戳：base + 秒。 */
function ts(second: number): string {
  const iso = new Date(Date.UTC(2026, 10, 25, 3, 0, second)).toISOString();
  return iso;
}

const BASE = {
  isSidechain: false,
  userType: 'external',
  entrypoint: 'cli',
  cwd: 'C:\\proj',
  sessionId: 'sess-1',
  version: '2.1.303',
  gitBranch: 'main',
};

const USAGE = {
  input_tokens: 100,
  cache_creation_input_tokens: 3,
  cache_read_input_tokens: 10,
  output_tokens: 20,
  output_tokens_details: { thinking_tokens: 5 },
  server_tool_use: { web_search_requests: 0 },
  service_tier: 'standard',
};

interface UserOptions {
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  isCompactSummary?: boolean;
  extra?: Record<string, unknown>;
}

function userRecord(
  uuid: string,
  content: unknown,
  options: UserOptions = {},
): Record<string, unknown> {
  return {
    ...BASE,
    parentUuid: options.parentUuid ?? null,
    type: 'user',
    message: { role: 'user', content },
    uuid,
    timestamp: options.timestamp ?? ts(0),
    ...(options.isCompactSummary === true ? { isCompactSummary: true } : {}),
    ...(options.extra ?? {}),
  };
}

interface AssistantOptions {
  uuid: string;
  parentUuid?: string | null;
  msgId?: string;
  blockIndex?: number;
  blocks: unknown[];
  usage?: unknown;
  stopReason?: unknown;
  model?: string;
  timestamp?: string;
  extra?: Record<string, unknown>;
}

function assistantRecord(
  options: AssistantOptions,
): Record<string, unknown> {
  return {
    ...BASE,
    parentUuid: options.parentUuid ?? null,
    type: 'assistant',
    message: {
      id: options.msgId ?? 'msg-1',
      type: 'message',
      role: 'assistant',
      model: options.model ?? 'claude-x',
      content: options.blocks,
      stop_reason: options.stopReason ?? 'tool_use',
      stop_sequence: null,
      usage: options.usage ?? USAGE,
    },
    uuid: options.uuid,
    timestamp: options.timestamp ?? ts(1),
    apiBlockIndex: options.blockIndex ?? 0,
    requestRef: 'req-1',
    requestedModel: 'claude-requested',
    ...(options.extra ?? {}),
  };
}

function toolResultRecord(
  uuid: string,
  toolUseId: string,
  content: unknown,
  options: UserOptions & { isError?: boolean; toolUseResult?: unknown } = {},
): Record<string, unknown> {
  return {
    ...userRecord(
      uuid,
      [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content,
          ...(options.isError === true ? { is_error: true } : {}),
        },
      ],
      { ...options, timestamp: options.timestamp ?? ts(2) },
    ),
    ...(options.toolUseResult === undefined
      ? {}
      : { toolUseResult: options.toolUseResult }),
    sourceToolAssistantUUID: 'asst-1',
    permissionDecision: 'allow',
  };
}

function parse(
  records: Array<Record<string, unknown> | string>,
  file = 'synthetic-main.jsonl',
): SessionNode {
  const text = records
    .map((record) => (typeof record === 'string' ? record : JSON.stringify(record)))
    .join('\n');
  return parseCcJsonl(text, file);
}

function allSteps(tree: SessionNode): StepNode[] {
  return tree.turns.flatMap((turn) => turn.steps);
}

function allTools(tree: SessionNode): ToolNode[] {
  return allSteps(tree).flatMap((step) => step.tools);
}

function lastTurn(tree: SessionNode): TurnNode {
  const turn = tree.turns[tree.turns.length - 1];
  if (turn === undefined) throw new Error('没有 turn');
  return turn;
}

describe('parseCcJsonl：按 message.id 聚合 assistant 记录', () => {
  it('同一 message.id 的多条记录聚成一个 step，content block 按 apiBlockIndex 排序', () => {
    const tree = parse([
      userRecord('u1', '列出目录'),
      assistantRecord({
        uuid: 'a1',
        blockIndex: 0,
        timestamp: ts(1),
        blocks: [{ type: 'thinking', thinking: '想一想', signature: 'sig' }],
      }),
      assistantRecord({
        uuid: 'a2',
        parentUuid: 'a1',
        blockIndex: 1,
        timestamp: ts(2),
        blocks: [
          { type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls' } },
        ],
      }),
      toolResultRecord('u2', 'call_1', 'ok', { timestamp: ts(3) }),
      assistantRecord({
        uuid: 'a3',
        msgId: 'msg-2',
        blockIndex: 0,
        timestamp: ts(4),
        stopReason: 'end_turn',
        blocks: [{ type: 'text', text: '完成' }],
      }),
    ]);

    expect(tree.turns).toHaveLength(1);
    const turn = tree.turns[0] as TurnNode;
    expect(turn.steps).toHaveLength(2);
    const [first, second] = turn.steps as [StepNode, StepNode];

    expect(first.sourceRefs.map((ref) => ref.line)).toEqual([2, 3]);
    expect(first.model).toBe('claude-x');
    // R1 映射：input/output/reasoning/cacheRead/cacheWrite
    expect(first.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 5,
      cacheReadTokens: 10,
      cacheWriteTokens: 3,
    });
    const output = first.outputMessages?.[0] as {
      id: string;
      role: string;
      content: Array<{ type: string }>;
    };
    expect(output.id).toBe('msg-1');
    expect(output.role).toBe('assistant');
    expect(output.content.map((block) => block.type)).toEqual(['thinking', 'tool_use']);

    // 第二步的输入来自上一条 tool_result 记录
    expect(second.inputMessages).toHaveLength(1);
    expect(
      (second.inputMessages?.[0] as { content: Array<{ tool_use_id: string }> })
        .content[0]?.tool_use_id,
    ).toBe('call_1');

    const tool = first.tools[0] as ToolNode;
    expect(tool.toolName).toBe('Bash');
    expect(tool.toolCallId).toBe('call_1');
    expect(tool.argsText).toBe('{"command":"ls"}');
    expect(tool.resultText).toBe('ok');
    expect(tool.isError).toBe(false);
    expect(tool.pairing).toBe('paired');
    expect(tool.endTimeUnixNano).toBe(BigInt(Date.parse(ts(3))) * 1_000_000n);

    // 统计与条数守恒
    expect(tree.stats.inputRecords).toBe(5);
    expect(tree.stats.producedSpans).toBe(5); // session + turn + 2 step + 1 tool
    expect(tree.stats.unknownEventTypes).toEqual({});
    expect(tree.stats.unpairedTools).toBe(0);
    expect(tree.createdAtMs).toBe(Date.parse(ts(0)));
    assertConservation(tree);
    assertConservation(tree, { reason: '聚合用例' });

    const total = countTreeNodes(tree);
    expect(total).toEqual({ sessions: 1, turns: 1, steps: 2, tools: 1 });
  });

  it('apiBlockIndex 乱序到达时仍按序号排列 content，结果确定', () => {
    const tree = parse([
      userRecord('u1', 'hi'),
      assistantRecord({
        uuid: 'a2',
        blockIndex: 1,
        timestamp: ts(2),
        stopReason: 'end_turn',
        blocks: [{ type: 'text', text: '后' }],
      }),
      assistantRecord({
        uuid: 'a1',
        blockIndex: 0,
        timestamp: ts(1),
        stopReason: 'end_turn',
        blocks: [{ type: 'thinking', thinking: '先' }],
      }),
    ]);
    const step = allSteps(tree)[0] as StepNode;
    const content = (step.outputMessages?.[0] as { content: Array<{ type: string }> })
      .content;
    expect(content.map((block) => block.type)).toEqual(['thinking', 'text']);
    expect(step.startTimeUnixNano).toBe(BigInt(Date.parse(ts(1))) * 1_000_000n);
  });

  it('同一 message.id 的 usage 相同也只映射一次，全部快照留 extras（R2 不重复计账）', () => {
    const tree = parse([
      userRecord('u1', 'hi'),
      assistantRecord({
        uuid: 'a1',
        blockIndex: 0,
        blocks: [{ type: 'thinking', thinking: 'x' }],
      }),
      assistantRecord({
        uuid: 'a2',
        blockIndex: 1,
        blocks: [{ type: 'text', text: 'y' }],
        stopReason: 'end_turn',
      }),
    ]);
    const step = allSteps(tree)[0] as StepNode;
    expect(tree.stats.duplicateUsage).toBe(0);
    expect(step.usage?.inputTokens).toBe(100);
    expect(step.extras['usageRaw']).toEqual(USAGE);
    expect(step.extras['usageMismatches']).toBeUndefined();
    expect(step.extras['usageSnapshots']).toEqual([
      { line: 2, usage: USAGE, authoritative: false },
      { line: 3, usage: USAGE, authoritative: true },
    ]);
    expect(tree.stats.usageSnapshots).toBe(2);
  });

  it('同一 message.id 首条不带 usage 时从带 usage 的记录取，缺失不填 0', () => {
    const withoutUsage = assistantRecord({
      uuid: 'a1',
      blockIndex: 0,
      blocks: [{ type: 'thinking', thinking: 'x' }],
    });
    delete (withoutUsage['message'] as Record<string, unknown>)['usage'];
    const tree = parse([
      userRecord('u1', 'hi'),
      withoutUsage,
      assistantRecord({
        uuid: 'a2',
        blockIndex: 1,
        blocks: [{ type: 'text', text: 'y' }],
        stopReason: 'end_turn',
      }),
    ]);
    const step = allSteps(tree)[0] as StepNode;
    expect(step.usage?.inputTokens).toBe(100);
    expect(step.usage?.outputTokens).toBe(20);
    expect(step.usage?.reasoningTokens).toBe(5);
    expect(tree.stats.duplicateUsage).toBe(0);
    // 只有第 3 行带 usage：唯一快照即权威条。
    expect(step.extras['usageSnapshots']).toEqual([
      { line: 3, usage: USAGE, authoritative: true },
    ]);
    expect(tree.stats.usageSnapshots).toBe(1);
  });

  it('同一 message.id 全部记录都无 usage 时 usage 留空（不填 0）', () => {
    const records = ['a1', 'a2'].map((uuid, index) => {
      const record = assistantRecord({
        uuid,
        blockIndex: index,
        blocks: [{ type: 'text', text: uuid }],
        stopReason: 'end_turn',
      });
      delete (record['message'] as Record<string, unknown>)['usage'];
      return record;
    });
    const tree = parse([userRecord('u1', 'hi'), ...records]);
    const step = allSteps(tree)[0] as StepNode;
    expect(step.usage).toBeUndefined();
    expect(step.extras['usageRaw']).toBeUndefined();
    expect(step.extras['usageSnapshots']).toBeUndefined();
    expect(tree.stats.usageSnapshots).toBe(0);
  });

  it('子 agent 流式快照：末条 output_tokens=60 覆盖首条 0，只记一次（R2 修订/t9）', () => {
    const firstSnapshot = {
      input_tokens: 19582,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
      service_tier: 'standard',
    };
    const finalSnapshot = {
      ...firstSnapshot,
      output_tokens: 60,
      output_tokens_details: { thinking_tokens: 7 },
    };
    const tree = parse([
      userRecord('u1', 'sub task', {
        extra: { isSidechain: true, agentId: 'agent-abc' },
      }),
      assistantRecord({
        uuid: 'a1',
        blockIndex: 0,
        blocks: [{ type: 'text', text: 'thinking' }],
        usage: firstSnapshot,
        extra: { isSidechain: true, agentId: 'agent-abc' },
      }),
      assistantRecord({
        uuid: 'a2',
        blockIndex: 1,
        blocks: [{ type: 'text', text: 'final' }],
        stopReason: 'end_turn',
        usage: finalSnapshot,
        extra: { isSidechain: true, agentId: 'agent-abc' },
      }),
    ]);
    const step = allSteps(tree)[0] as StepNode;
    // 只映射一次：末条最终快照。
    expect(step.usage?.outputTokens).toBe(60);
    expect(step.usage?.reasoningTokens).toBe(7);
    expect(step.extras['usageRaw']).toEqual(finalSnapshot);
    expect(tree.stats.duplicateUsage).toBe(1); // 首条与权威条不同，留证
    expect(tree.stats.usageSnapshots).toBe(2);
    const snapshots = step.extras['usageSnapshots'] as Array<{
      line: number;
      authoritative: boolean;
    }>;
    expect(snapshots.map((snapshot) => snapshot.authoritative)).toEqual([false, true]);
  });

  it('乱序回退：末条 output_tokens 小于历史最大值时取最大值那条（max 规则）', () => {
    const tree = parse([
      userRecord('u1', 'hi'),
      assistantRecord({
        uuid: 'a1',
        blockIndex: 0,
        blocks: [{ type: 'text', text: 'complete' }],
        usage: { input_tokens: 10, output_tokens: 60 },
      }),
      assistantRecord({
        uuid: 'a2',
        blockIndex: 1,
        blocks: [{ type: 'text', text: 'stale' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 30 },
      }),
    ]);
    const step = allSteps(tree)[0] as StepNode;
    expect(step.usage?.outputTokens).toBe(60); // 防乱序回退
    expect(step.extras['usageRaw']).toEqual({ input_tokens: 10, output_tokens: 60 });
    expect(tree.stats.duplicateUsage).toBe(1);
    const snapshots = step.extras['usageSnapshots'] as Array<{
      line: number;
      authoritative: boolean;
    }>;
    expect(snapshots.find((snapshot) => snapshot.authoritative)?.line).toBe(2);
  });

  it('同一 message.id 的 usage 不一致时以末条为准并计入 duplicateUsage（R2 修订）', () => {
    const different = { ...USAGE, input_tokens: 999, output_tokens: 777 };
    const tree = parse([
      userRecord('u1', 'hi'),
      assistantRecord({
        uuid: 'a1',
        blockIndex: 0,
        blocks: [{ type: 'thinking', thinking: 'x' }],
      }),
      assistantRecord({
        uuid: 'a2',
        blockIndex: 1,
        blocks: [{ type: 'text', text: 'y' }],
        stopReason: 'end_turn',
        usage: different,
      }),
    ]);
    const step = allSteps(tree)[0] as StepNode;
    expect(step.usage?.inputTokens).toBe(999); // 末条最终值
    expect(step.usage?.outputTokens).toBe(777);
    expect(tree.stats.duplicateUsage).toBe(1);
    const snapshots = step.extras['usageSnapshots'] as Array<{ usage: unknown }>;
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]?.usage).toEqual(different);
  });

  it('usage 的实测 0 保留、缺失字段不填 0（R15/R1）', () => {
    const tree = parse([
      userRecord('u1', 'hi'),
      assistantRecord({
        uuid: 'a1',
        blocks: [{ type: 'text', text: 'x' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    ]);
    const step = allSteps(tree)[0] as StepNode;
    expect(step.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect('reasoningTokens' in (step.usage ?? {})).toBe(false);
    expect('cacheReadTokens' in (step.usage ?? {})).toBe(false);
  });
});

describe('parseCcJsonl：turn 切分', () => {
  it('用户消息开 turn，tool_result 不开 turn', () => {
    const tree = parse([
      userRecord('u1', '第一轮', { timestamp: ts(0) }),
      assistantRecord({
        uuid: 'a1',
        blocks: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'a' } }],
      }),
      toolResultRecord('u2', 'call_1', 'content', { timestamp: ts(2) }),
      assistantRecord({
        uuid: 'a2',
        msgId: 'msg-2',
        timestamp: ts(3),
        stopReason: 'end_turn',
        blocks: [{ type: 'text', text: 'ok' }],
      }),
      userRecord('u3', '第二轮', { timestamp: ts(4), parentUuid: 'a2' }),
      assistantRecord({
        uuid: 'a3',
        msgId: 'msg-3',
        timestamp: ts(5),
        stopReason: 'end_turn',
        blocks: [{ type: 'text', text: 'done' }],
      }),
    ]);
    expect(tree.turns).toHaveLength(2);
    expect(tree.turns[0]?.steps).toHaveLength(2);
    expect(tree.turns[1]?.steps).toHaveLength(1);
    expect(tree.turns[1]?.startTimeUnixNano).toBe(BigInt(Date.parse(ts(4))) * 1_000_000n);
    // endReason 取最后一步事件自带的 stop_reason
    expect(tree.turns[0]?.endReason).toBe('end_turn');
    expect(tree.turns[1]?.endReason).toBe('end_turn');
    assertConservation(tree);
  });

  it('文件以 assistant 记录开头时建带标记的隐式 turn（不伪造用户消息）', () => {
    const tree = parse([
      assistantRecord({
        uuid: 'a1',
        blocks: [{ type: 'text', text: 'leading' }],
        stopReason: 'end_turn',
      }),
    ]);
    expect(tree.turns).toHaveLength(1);
    expect(tree.turns[0]?.extras['leadingAssistant']).toBe(true);
    expect(tree.turns[0]?.steps[0]?.inputMessages).toBeUndefined();
    assertConservation(tree);
  });
});

describe('parseCcJsonl：工具配对（孤儿与重复合法）', () => {
  it('tool_use 无结果 → orphan_call，unpairedTools 计数', () => {
    const tree = parse([
      userRecord('u1', 'hi'),
      assistantRecord({
        uuid: 'a1',
        blocks: [{ type: 'tool_use', id: 'call_x', name: 'Bash', input: { command: 'x' } }],
      }),
    ]);
    const tool = allTools(tree)[0] as ToolNode;
    expect(tool.pairing).toBe('orphan_call');
    expect(tool.resultText).toBeUndefined();
    expect(tool.endTimeUnixNano).toBeUndefined();
    expect(tree.stats.unpairedTools).toBe(1);
    assertConservation(tree);
  });

  it('同一 tool_use.id 的第二条结果 → duplicate（保留首条原文并留副本）', () => {
    const tree = parse([
      userRecord('u1', 'hi'),
      assistantRecord({
        uuid: 'a1',
        blocks: [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'x' } }],
      }),
      toolResultRecord('u2', 'call_1', 'first', { timestamp: ts(2) }),
      toolResultRecord('u3', 'call_1', 'second', { timestamp: ts(3) }),
    ]);
    const tool = allTools(tree)[0] as ToolNode;
    expect(tool.pairing).toBe('duplicate');
    expect(tool.resultText).toBe('first');
    const duplicates = tool.extras['duplicateResults'] as Array<{ line: number }>;
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.line).toBe(4);
    expect(tree.stats.unpairedTools).toBe(1);
    assertConservation(tree);
  });

  it('无对应 tool_use 的结果 → orphan_result，建占位 step 并标 pending_or_interrupted 依据', () => {
    const tree = parse([
      userRecord('u1', 'hi'),
      toolResultRecord('u2', 'call_ghost', 'leaked', { timestamp: ts(2) }),
    ]);
    const turn = lastTurn(tree);
    expect(turn.steps).toHaveLength(1);
    expect(turn.steps[0]?.extras['orphanResultStep']).toBe(true);
    const tool = turn.steps[0]?.tools[0] as ToolNode;
    expect(tool.pairing).toBe('orphan_result');
    expect(tool.toolName).toBe(CC_PLACEHOLDER_TOOL_NAME);
    expect(tool.toolCallId).toBe('call_ghost');
    expect(tool.resultText).toBe('leaked');
    expect(tree.stats.unpairedTools).toBe(1);
    assertConservation(tree);
  });

  it('tool_result 的 content 为块数组时保留完整原文（JSON 文本，不截断）', () => {
    const tree = parse([
      userRecord('u1', 'hi'),
      assistantRecord({
        uuid: 'a1',
        blocks: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'a' } }],
      }),
      toolResultRecord('u2', 'call_1', [{ type: 'text', text: 'line' }]),
    ]);
    const tool = allTools(tree)[0] as ToolNode;
    expect(tool.resultText).toBe(JSON.stringify([{ type: 'text', text: 'line' }]));
  });

  it('is_error 为 true 时保留出错标记', () => {
    const tree = parse([
      userRecord('u1', 'hi'),
      assistantRecord({
        uuid: 'a1',
        blocks: [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: {} }],
      }),
      toolResultRecord('u2', 'call_1', 'boom', { isError: true }),
    ]);
    expect(allTools(tree)[0]?.isError).toBe(true);
  });
});

describe('parseCcJsonl：compact 重接（R9）', () => {
  it('compact_boundary 用 logicalParentUuid 重接并标记后续 turn', () => {
    const compactMetadata = {
      trigger: 'auto',
      preTokens: 25549,
      postTokens: 3125,
      cumulativeDroppedTokens: 22424,
      durationMs: 9294,
    };
    const tree = parse([
      userRecord('u1', '第一轮'),
      assistantRecord({
        uuid: 'a1',
        blocks: [{ type: 'text', text: 'x' }],
        stopReason: 'end_turn',
      }),
      {
        ...BASE,
        parentUuid: null,
        logicalParentUuid: 'a1',
        type: 'system',
        subtype: 'compact_boundary',
        content: 'Conversation compacted',
        level: 'info',
        compactMetadata,
        uuid: 'cb1',
        timestamp: ts(2),
      },
      userRecord('u2', 'summary', {
        timestamp: ts(3),
        parentUuid: 'cb1',
        isCompactSummary: true,
      }),
      assistantRecord({
        uuid: 'a2',
        msgId: 'msg-2',
        timestamp: ts(4),
        stopReason: 'end_turn',
        blocks: [{ type: 'text', text: 'continue' }],
      }),
    ]);

    expect(tree.turns).toHaveLength(2);
    const compactTurn = tree.turns[1] as TurnNode;
    expect(compactTurn.compact).toBe(true);
    expect(compactTurn.extras['compactBoundary']).toBe(true);
    expect(compactTurn.extras['logicalParentUuid']).toBe('a1');
    expect(compactTurn.extras['resumedFromTurnIndex']).toBe(0);
    expect(compactTurn.extras['compactMetadata']).toEqual(compactMetadata);
    // parentUuid=null 是「重接而非删除」的证据，原样保留
    expect(compactTurn.extras['compactParentUuid']).toBeNull();
    expect(compactTurn.extras['compactSummary']).toBe(true);
    // 边界记录已落位，会话级不留临时待接副本
    expect(tree.extras['pendingCompactRest']).toBeUndefined();
    // compact_boundary 记录不丢：来源序号落在新 turn 上
    expect(compactTurn.sourceRefs.map((ref) => ref.line)).toContain(3);
    expect(compactTurn.sourceRefs.map((ref) => ref.recordType)).toContain('system');
    assertConservation(tree);
    expect(tree.stats.unknownEventTypes).toEqual({});
  });

  it('文件末尾孤立的 compact_boundary 记录进会话级待审，不丢', () => {
    const tree = parse([
      userRecord('u1', 'hi'),
      assistantRecord({
        uuid: 'a1',
        blocks: [{ type: 'text', text: 'x' }],
        stopReason: 'end_turn',
      }),
      {
        ...BASE,
        parentUuid: null,
        logicalParentUuid: 'a1',
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'cb1',
        timestamp: ts(2),
      },
    ]);
    expect(tree.turns).toHaveLength(1);
    expect(tree.extras['orphanCompactBoundaries']).toHaveLength(1);
    assertConservation(tree);
  });
});

describe('parseCcJsonl：版本、agent 标识、会话 id', () => {
  it('无 version 记录不猜版本（formatVersion 留空），原样保留记录', () => {
    const noVersion = userRecord('u1', 'hi', {
      extra: { version: undefined },
    });
    delete (noVersion as Record<string, unknown>)['version'];
    const noVersionAssistant = assistantRecord({
      uuid: 'a1',
      blocks: [{ type: 'text', text: 'x' }],
      stopReason: 'end_turn',
      extra: { version: undefined },
    });
    delete (noVersionAssistant as Record<string, unknown>)['version'];
    const tree = parse([
      noVersion,
      noVersionAssistant,
    ]);
    expect(tree.formatVersion).toBeUndefined();
    expect(tree.extras['versions']).toBeUndefined();
    assertConservation(tree);
  });

  it('带 version 的记录把版本原文留在 extras，不猜数字格式版本', () => {
    const tree = parse([
      userRecord('u1', 'hi', { extra: { version: '2.1.303' } }),
      userRecord('u2', 'hi2', { timestamp: ts(1), extra: { version: '2.1.330' } }),
    ]);
    expect(tree.formatVersion).toBeUndefined();
    expect(tree.extras['versions']).toEqual(['2.1.303', '2.1.330']);
  });

  it('isSidechain 记录 → agentLabel=sidechain-<agentId>，agentId 留 extras（R4 修订/t9）', () => {
    const tree = parse([
      userRecord('u1', 'sub task', {
        extra: { isSidechain: true, agentId: 'agent-abc' },
      }),
      assistantRecord({
        uuid: 'a1',
        blocks: [{ type: 'text', text: 'x' }],
        stopReason: 'end_turn',
        extra: { isSidechain: true, agentId: 'agent-abc' },
      }),
    ]);
    expect(tree.agentLabel).toBe('sidechain-agent-abc');
    expect(tree.extras['agentId']).toBe('agent-abc');
    expect(tree.extras['agentLabelSource']).toBe('agentId');
    expect(tree.extras['sessionFile']).toBe('synthetic-main.jsonl');
  });

  it('两个共享父 sessionId 的 sidechain 文件产出不同 agentLabel、文件名与 span key（t9）', () => {
    const sidechainTree = (agentId: string): SessionNode =>
      parse(
        [
          userRecord('u1', 'sub task', {
            extra: { isSidechain: true, agentId },
          }),
          assistantRecord({
            uuid: 'a1',
            blocks: [{ type: 'text', text: 'x' }],
            stopReason: 'end_turn',
            extra: { isSidechain: true, agentId },
          }),
        ],
        `subagents/agent-${agentId}.jsonl`,
      );
    const first = sidechainTree('a4288366077decdbd');
    const second = sidechainTree('b4288366077decdbd');

    // 同一个父会话（sessionId 相同），但 agentLabel 每文件唯一。
    expect(first.sessionId).toBe('sess-1');
    expect(second.sessionId).toBe('sess-1');
    expect(first.agentLabel).toBe('sidechain-a4288366077decdbd');
    expect(second.agentLabel).toBe('sidechain-b4288366077decdbd');
    expect(first.agentLabel).not.toBe(second.agentLabel);

    // t6 按 `<sessionId>__<agentLabel>.json` 命名，文件名不再相撞。
    const firstFile = `${first.sessionId}__${first.agentLabel}.json`;
    const secondFile = `${second.sessionId}__${second.agentLabel}.json`;
    expect(firstFile).not.toBe(secondFile);

    // t5 按 deriveSpanId(sessionKey(sessionId, agentLabel), 'session') 派生，不再撞 key。
    const firstSpan = deriveSpanId(
      sessionKey(first.sessionId, first.agentLabel),
      sessionSpanPath(),
    );
    const secondSpan = deriveSpanId(
      sessionKey(second.sessionId, second.agentLabel),
      sessionSpanPath(),
    );
    expect(firstSpan).not.toBe(secondSpan);
  });

  it('超长 agentId 截断并带 hash 后缀，仍保持唯一（t9）', () => {
    const longTree = (suffix: string): SessionNode =>
      parse(
        [
          userRecord('u1', 'sub task', {
            extra: { isSidechain: true, agentId: `${'a'.repeat(90)}${suffix}` },
          }),
        ],
        'subagents/agent-long.jsonl',
      );
    const first = longTree('x');
    const second = longTree('y');
    expect(first.agentLabel.startsWith('sidechain-')).toBe(true);
    expect(first.agentLabel.length).toBeLessThanOrEqual(64);
    expect(/^[A-Za-z0-9._-]+$/.test(first.agentLabel)).toBe(true);
    expect(first.agentLabel).not.toBe(second.agentLabel);
  });

  it('sidechain 无 agentId 时用文件 stem 唯一化，并清洗文件名非法字符（t9）', () => {
    const noAgentId = (file: string): SessionNode =>
      parse(
        [
          userRecord('u1', 'sub task', { extra: { isSidechain: true } }),
          assistantRecord({
            uuid: 'a1',
            blocks: [{ type: 'text', text: 'x' }],
            stopReason: 'end_turn',
            extra: { isSidechain: true },
          }),
        ],
        file,
      );
    const first = noAgentId('subagents/agent-aaa.jsonl');
    const second = noAgentId('subagents/agent-bbb.jsonl');
    expect(first.agentLabel).toBe('sidechain-agent-aaa');
    expect(second.agentLabel).toBe('sidechain-agent-bbb');
    expect(first.extras['agentLabelSource']).toBe('fileStem');
    expect(`${first.sessionId}__${first.agentLabel}.json`).not.toBe(
      `${second.sessionId}__${second.agentLabel}.json`,
    );

    const dirty = noAgentId('agent a.jsonl');
    expect(dirty.agentLabel).toBe('sidechain-agent_a');
    expect(/^[A-Za-z0-9._-]+$/.test(dirty.agentLabel)).toBe(true);
  });

  it('主会话 agentLabel=main', () => {
    const tree = parse([
      userRecord('u1', 'hi'),
      assistantRecord({
        uuid: 'a1',
        blocks: [{ type: 'text', text: 'x' }],
        stopReason: 'end_turn',
      }),
    ]);
    expect(tree.agentLabel).toBe('main');
  });

  it('sessionId 缺失时用文件名兜底并标 session_id_source（R6）', () => {
    const record = userRecord('u1', 'hi');
    delete (record as Record<string, unknown>)['sessionId'];
    const tree = parse([record], 'my-session.jsonl');
    expect(tree.sessionId).toBe('my-session');
    expect(tree.extras['session_id_source']).toBe('filename');
  });
});

describe('parseCcJsonl：未知记录与坏行（跳过并计数，不中断）', () => {
  it('认不出的记录类型保留原文并计数，坏行只计数不抛', () => {
    const attachment = {
      ...BASE,
      type: 'attachment',
      uuid: 'att-1',
      timestamp: ts(0),
      attachment: { type: 'file', path: 'a.txt' },
    };
    const queue = { ...BASE, type: 'queue-operation', operation: 'enqueue', timestamp: ts(0) };
    const tree = parse([userRecord('u1', 'hi'), attachment, queue, '{broken json']);

    expect(tree.stats.inputRecords).toBe(4);
    expect(tree.stats.badLines).toBe(1);
    expect(tree.stats.skippedRecords).toBe(1);
    expect(tree.stats.unknownEventTypes).toEqual({
      attachment: 1,
      'queue-operation': 1,
    });
    const unknown = tree.extras['unknownRecords'] as Array<{
      line: number;
      recordType: string;
      record: unknown;
    }>;
    expect(unknown.map((entry) => entry.recordType)).toEqual([
      'attachment',
      'queue-operation',
    ]);
    expect(unknown[0]?.record).toEqual(attachment);
    assertConservation(tree);
  });

  it('非 compact 的 system 子类型按 system/<subtype> 计数并保留', () => {
    const tree = parse([
      userRecord('u1', 'hi'),
      { ...BASE, type: 'system', subtype: 'api_error', uuid: 's1', timestamp: ts(1) },
    ]);
    expect(tree.stats.unknownEventTypes).toEqual({ 'system/api_error': 1 });
    assertConservation(tree);
  });

  it('坏时间戳计入 unknownTimes，不伪造时间', () => {
    const tree = parse([
      userRecord('u1', 'hi'),
      assistantRecord({
        uuid: 'a1',
        timestamp: 'not-a-date',
        blocks: [{ type: 'text', text: 'x' }],
        stopReason: 'end_turn',
      }),
    ]);
    expect(tree.stats.unknownTimes).toBe(1);
    expect(allSteps(tree)[0]?.startTimeUnixNano).toBeUndefined();
    expect(tree.turns[0]?.startTimeUnixNano).toBeDefined();
  });
});

describe('parseCcJsonl：确定性', () => {
  it('同一输入解析两次结果相同', async () => {
    const text = [
      userRecord('u1', 'hi'),
      JSON.stringify(
        assistantRecord({
          uuid: 'a1',
          blocks: [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls' } }],
        }),
      ),
      JSON.stringify(toolResultRecord('u2', 'call_1', 'ok')),
      '{broken',
    ].join('\n');
    await assertDeterministic(() => parseCcJsonl(text, 'deterministic.jsonl'), {
      reason: 'cc 合成样本',
      serialize: (tree) =>
        JSON.stringify(tree, (_key, value) =>
          typeof value === 'bigint' ? value.toString() : value,
        ),
    });
  });
});

describe('parseCcSession：文件入口与重写副本跳过', () => {
  const tempDirs: string[] = [];
  afterAll(() => {
    // Windows 下 rmSync 偶发 ENOTEMPTY（句柄延迟释放）→ 重试兜底（t8 审核 L1，t13）
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  function tempFile(name: string, lines: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'asu-cc-parse-'));
    tempDirs.push(dir);
    const file = join(dir, name);
    writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
    return file;
  }

  it('isCcSkippedSessionFile 识别 .orphaned-* / .superseded-*', () => {
    expect(isCcSkippedSessionFile('.orphaned-abc.jsonl')).toBe(true);
    expect(isCcSkippedSessionFile('C:\\p\\.superseded-x.jsonl')).toBe(true);
    expect(isCcSkippedSessionFile('.ORPHANED-abc.jsonl')).toBe(true);
    expect(isCcSkippedSessionFile('abc.jsonl')).toBe(false);
    expect(isCcSkippedSessionFile('my.orphaned-note.jsonl')).toBe(false);
  });

  it('重写副本整文件跳过：产仅统计的会话树，行数计 skippedRecords（R7）', () => {
    const file = tempFile('.orphaned-abc.jsonl', [
      JSON.stringify(userRecord('u1', 'hi')),
      JSON.stringify(assistantRecord({ uuid: 'a1', blocks: [{ type: 'text', text: 'x' }] })),
    ]);
    const tree = parseCcSession(file);
    expect(tree.turns).toHaveLength(0);
    expect(tree.stats.inputRecords).toBe(2);
    expect(tree.stats.skippedRecords).toBe(2);
    expect(tree.stats.producedSpans).toBe(1);
    expect(tree.extras['skippedRewriteFile']).toBe(true);
    assertConservation(tree);
  });

  it('正常文件走 parseCcJsonl 并保留传入路径作为来源', () => {
    const file = tempFile('abc.jsonl', [
      JSON.stringify(userRecord('u1', 'hi')),
      JSON.stringify(
        assistantRecord({
          uuid: 'a1',
          blocks: [{ type: 'text', text: 'x' }],
          stopReason: 'end_turn',
        }),
      ),
    ]);
    const tree = parseCcSession(file);
    expect(tree.turns).toHaveLength(1);
    expect(tree.sourceRefs).toEqual([]);
    expect(tree.turns[0]?.sourceRefs[0]?.file).toBe(file);
    expect(tree.sessionId).toBe('sess-1');
    assertConservation(tree);
  });

  it('SessionSource：物理路径只读盘，逻辑路径进输出，label 不随临时目录变化（R4）', () => {
    // 同一逻辑成员的两次物理落点（不同 mkdtemp 目录）必须产出同一个 label：
    // hash 种子若用物理路径，归档两次运行就会得到不同文件名（R6 根因）。
    const longStem = `agent-${'y'.repeat(60)}`;
    const lines = [
      JSON.stringify(userRecord('u1', 'sub task', { extra: { isSidechain: true } })),
      JSON.stringify(
        assistantRecord({
          uuid: 'a1',
          blocks: [{ type: 'text', text: 'x' }],
          stopReason: 'end_turn',
          extra: { isSidechain: true },
        }),
      ),
    ];
    const logical = `C:\\in\\pack.tar.zst!/packed/subagents/${longStem}.jsonl`;
    const first = parseCcSession({
      physicalPath: tempFile(`${longStem}.jsonl`, lines),
      logicalPath: logical,
    });
    const second = parseCcSession({
      physicalPath: tempFile(`${longStem}.jsonl`, lines),
      logicalPath: logical,
    });

    expect(first.extras['sessionFile']).toBe(logical);
    expect(first.extras['agentLabelSource']).toBe('fileStem');
    expect(first.agentLabel.startsWith('sidechain-')).toBe(true);
    expect(first.agentLabel).toBe(second.agentLabel);
    expect(first.extras['sessionFile']).not.toContain('asu-cc-parse-');
  });
});
