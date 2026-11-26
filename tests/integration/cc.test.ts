/**
 * Claude Code 侧独立集成测试（tests/integration/cc.test.ts）。
 *
 * 只从 CLI 落盘的 OTLP JSON 反推事实。覆盖：
 * - usage 最终快照（R2 修订 / t9）：同 message.id 多条流式快照只映射一次，取最终值；
 * - compact_boundary 重接（R9）：logicalParentUuid → 后续 turn 的 compact 标记；
 * - 未知记录原样保留 + 计数、坏行只计数；
 * - 全无时间戳：回填 0 + unknown_times 计数；
 * - sidechain 文件名 / span key 不撞（同一 sessionId 两个子 agent）。
 *
 * 运行：npx vitest run tests/integration/cc.test.ts
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runParse } from '../../src/index.js';
import {
  CC_FIXTURE_USAGE_FINAL,
  ccCompactRecords,
  ccMainRecords,
  ccNoTimeRecords,
  ccSidechainRecords,
  type JsonObject,
} from '../fixtures/cc.js';
import {
  assertOutputInvariants,
  assertResourceIdentity,
  findSpan,
  hasAttribute,
  intAttribute,
  loadOutputDir,
  makeTempDir,
  removeTempDir,
  resourceAttribute,
  scalarAttribute,
  spansNamed,
  stringAttribute,
  writeCcSessionFile,
} from './helpers.js';

const tempDirs: string[] = [];

function workDir(prefix: string): string {
  const dir = makeTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) removeTempDir(dir);
});

interface RunResult {
  work: string;
  outDir: string;
  result: ReturnType<typeof runParse>;
}

/** 写一个 CC 会话文件（默认文件名 cc-main.jsonl）并跑一次 CLI 解析。 */
function runCcSession(lines: Array<JsonObject | string>, fileName = 'cc-main.jsonl'): RunResult {
  const work = workDir('asu-int-cc-');
  const sessionDir = join(work, 'sessions');
  mkdirSync(sessionDir, { recursive: true });
  writeCcSessionFile(sessionDir, lines, fileName);
  const outDir = join(work, 'out');
  const result = runParse([sessionDir], outDir);
  return { work, outDir, result };
}

function singleOutput(run: RunResult) {
  const files = loadOutputDir(run.outDir);
  expect(files).toHaveLength(1);
  return files[0]!;
}

function stepNames(file: ReturnType<typeof singleOutput>): string[] {
  return file.spans.map((span) => span.name).filter((name) => name.startsWith('step '));
}

describe('CC 集成：主会话基线（usage 最终快照 / 块排序 / 工具配对）', () => {
  it('落盘产物满足字段齐全/结构自洽/条数守恒，usage 取最终快照只计一次', () => {
    const run = runCcSession(ccMainRecords());
    expect(run.result.exitCode).toBe(0);
    expect(run.result.successCount).toBe(1);
    expect(run.result.parseFailureCount).toBe(0);

    const file = singleOutput(run);
    expect(file.relPath).toBe('claude-code/cc-fixture-main__main.json');
    assertResourceIdentity(file, {
      tool: 'claude-code',
      sessionId: 'cc-fixture-main',
      agentLabel: 'main',
    });

    const invariants = assertOutputInvariants(file);
    // session / turn 0 / step 0/0 / Read / step 0/1 = 5，无 compaction。
    expect(invariants.spanCount).toBe(5);
    expect(invariants.compactionSpans).toBe(0);
    expect(invariants.fourLayerSpans).toBe(5);
    expect(invariants.inputRecords).toBe(7);
    expect(invariants.skippedRecords).toBe(1); // 坏行
    expect(invariants.sourceRefTotal).toBe(6);

    const root = file.spans.find((span) => span.parentSpanId === undefined)!;
    expect(stringAttribute(root, 'asu.stats.bad_lines')).toBe('1');
    expect(stringAttribute(root, 'asu.stats.unknown_event_types.mystery_fixture')).toBe('1');
    // 未知记录必须原样保留（含 note 原文），不得丢弃。
    expect(stringAttribute(root, 'asu.unknownRecords')).toContain('keep-me-untouched');
    expect(stringAttribute(root, 'asu.stats.usage_snapshots')).toBe('3'); // msg-1 两条 + msg-2 一条
    expect(stringAttribute(root, 'asu.stats.duplicate_usage')).toBe('1'); // 与权威条不一致的中间快照

    expect(spansNamed(file, 'turn 0')).toHaveLength(1);
    expect(stepNames(file)).toEqual(['step 0/0', 'step 0/1']);

    // R2 修订：同 message.id 的多条记录聚成一个 step，usage 只映射一次且取最终值。
    const step1 = findSpan(file, (span) => span.name === 'step 0/0');
    expect(intAttribute(step1, 'gen_ai.usage.input_tokens')).toBe(100);
    expect(intAttribute(step1, 'gen_ai.usage.output_tokens')).toBe(60);
    expect(intAttribute(step1, 'gen_ai.usage.output_tokens.reasoning_tokens')).toBe(5);
    expect(intAttribute(step1, 'gen_ai.token_count.cache_read')).toBe(10);
    expect(intAttribute(step1, 'asu.usage.cache_write')).toBe(3);
    expect(stringAttribute(step1, 'gen_ai.request.model')).toBe('cc-fixture-model');
    // 全部快照留证：首条 output=0（流式中间态）也在，且标为非权威。
    const snapshots = stringAttribute(step1, 'asu.usageSnapshots') ?? '';
    expect(snapshots).toContain('"output_tokens":0');
    expect(snapshots).toContain('"authoritative":false');
    expect(snapshots).toContain('"authoritative":true');
    expect(stringAttribute(step1, 'asu.usageRaw')).toBe(JSON.stringify(CC_FIXTURE_USAGE_FINAL));

    // content block 按 apiBlockIndex 排序：thinking 在 tool_use 之前。
    const outputMessages = stringAttribute(step1, 'gen_ai.output.messages') ?? '';
    expect(outputMessages.indexOf('"type":"thinking"')).toBeGreaterThan(-1);
    expect(outputMessages.indexOf('"type":"thinking"')).toBeLessThan(
      outputMessages.indexOf('"type":"tool_use"'),
    );
    expect(stringAttribute(step1, 'gen_ai.input.messages')).toContain('请读取 a.txt');

    // 工具配对与原文保留。
    const tool = findSpan(file, (span) => span.name === 'Read');
    expect(stringAttribute(tool, 'asu.tool.pairing')).toBe('paired');
    expect(hasAttribute(tool, 'asu.pending_or_interrupted')).toBe(false);
    expect(stringAttribute(tool, 'gen_ai.tool.call.id')).toBe('call-1');
    expect(stringAttribute(tool, 'gen_ai.tool.call.arguments')).toBe('{"path":"a.txt"}');
    expect(stringAttribute(tool, 'gen_ai.tool.call.result')).toBe('文件内容');

    // 第二个 step 的输入是上一条 tool_result（不开新 turn）。
    const step2 = findSpan(file, (span) => span.name === 'step 0/1');
    expect(stringAttribute(step2, 'gen_ai.input.messages')).toContain('"tool_result"');
    expect(intAttribute(step2, 'gen_ai.usage.input_tokens')).toBe(120);
    expect(intAttribute(step2, 'gen_ai.usage.output_tokens')).toBe(8);

    expect(run.result.lines.join('\n')).toContain('cc-fixture-main__main');
    expect(run.result.lines.join('\n')).toContain('2步/1工具');
    expect(run.result.lines.join('\n')).not.toContain('[empty]');
  });

  it('两次独立解析：输出字节完全一致（确定性，不掺当前时间/随机）', () => {
    const work = workDir('asu-int-cc-determinism-');
    const sessionDir = join(work, 'sessions');
    mkdirSync(sessionDir, { recursive: true });
    writeCcSessionFile(sessionDir, ccMainRecords());
    const outA = join(work, 'out-a');
    const outB = join(work, 'out-b');
    expect(runParse([sessionDir], outA).exitCode).toBe(0);
    expect(runParse([sessionDir], outB).exitCode).toBe(0);
    const filesA = loadOutputDir(outA);
    const filesB = loadOutputDir(outB);
    expect(filesA.map((file) => file.relPath)).toEqual(filesB.map((file) => file.relPath));
    expect(filesA[0]!.text).toBe(filesB[0]!.text);
  });
});

describe('CC 集成：compact_boundary 重接（R9）', () => {
  it('压缩边界标记落在后续 turn，parentUuid=null 与 logicalParentUuid 双向留证', () => {
    const run = runCcSession(ccCompactRecords(), 'cc-compact.jsonl');
    const file = singleOutput(run);
    const invariants = assertOutputInvariants(file);
    expect(invariants.spanCount).toBe(5);
    expect(invariants.inputRecords).toBe(5);
    expect(invariants.skippedRecords).toBe(0);
    expect(invariants.sourceRefTotal).toBe(5);

    const turn0 = findSpan(file, (span) => span.name === 'turn 0');
    const turn1 = findSpan(file, (span) => span.name === 'turn 1');
    expect(hasAttribute(turn0, 'asu.turn.compact')).toBe(false);
    // turn.compact 是布尔属性（kv 走 boolValue），不是字符串。
    expect(scalarAttribute(turn1, 'asu.turn.compact')).toBe(true);
    expect(scalarAttribute(turn1, 'asu.compactBoundary')).toBe(true);
    expect(intAttribute(turn1, 'asu.resumedFromTurnIndex')).toBe(0);
    expect(stringAttribute(turn1, 'asu.logicalParentUuid')).toBe('u1');
    // parentUuid=null 是「重接」证据：键必须存在，不能被当作字段删除。
    expect(hasAttribute(turn1, 'asu.compactParentUuid')).toBe(true);
    expect(stringAttribute(turn1, 'asu.compactMetadata')).toContain('"preTokens":1234');
    // turn1 的 refs：compact_boundary + 压缩后的 prompt。
    expect(intAttribute(turn1, 'asu.source_ref_count')).toBe(2);
    // 压缩后的内容必须照常解析（不能因为边界记录中断整份文件）。
    const step2 = findSpan(file, (span) => span.name === 'step 1/0');
    expect(stringAttribute(step2, 'gen_ai.input.messages')).toContain('压缩后问题');
  });
});

describe('CC 集成：缺时间戳不伪造', () => {
  it('全无时间戳时根 start=0，unknown_times 计数 > 0，end >= start', () => {
    const run = runCcSession(ccNoTimeRecords(), 'cc-no-time.jsonl');
    const file = singleOutput(run);
    assertOutputInvariants(file);
    const root = file.spans.find((span) => span.parentSpanId === undefined)!;
    expect(root.startTimeUnixNano).toBe('0');
    expect(Number(stringAttribute(root, 'asu.stats.unknown_times'))).toBeGreaterThan(0);
    for (const span of file.spans) {
      expect(BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano)).toBe(true);
    }
  });
});

describe('CC 集成：sidechain 文件名与 span key 不撞（t9 修补）', () => {
  it('同一 sessionId 的两个子 agent 各写一个文件，label/spanId 唯一，同一 trace', () => {
    const work = workDir('asu-int-cc-sidechain-');
    const sessionDir = join(work, 'sessions');
    mkdirSync(sessionDir, { recursive: true });
    writeCcSessionFile(sessionDir, ccSidechainRecords('agent-aaa'), 'agent-aaa.jsonl');
    writeCcSessionFile(sessionDir, ccSidechainRecords('agent-bbb'), 'agent-bbb.jsonl');

    const outDir = join(work, 'out');
    const result = runParse([sessionDir], outDir);
    expect(result.exitCode).toBe(0);
    expect(result.successCount).toBe(2);

    const files = loadOutputDir(outDir);
    expect(files.map((file) => file.relPath).sort()).toEqual([
      'claude-code/cc-fixture-shared__sidechain-agent-aaa.json',
      'claude-code/cc-fixture-shared__sidechain-agent-bbb.json',
    ]);

    const [fileA, fileB] = files.sort((a, b) => a.relPath.localeCompare(b.relPath));
    for (const file of files) assertOutputInvariants(file);
    assertResourceIdentity(fileA!, {
      tool: 'claude-code',
      sessionId: 'cc-fixture-shared',
      agentLabel: 'sidechain-agent-aaa',
    });
    assertResourceIdentity(fileB!, {
      tool: 'claude-code',
      sessionId: 'cc-fixture-shared',
      agentLabel: 'sidechain-agent-bbb',
    });

    // 同一 sessionId ⇒ 同一 trace（便于按会话聚合），但 spanId 必须互不相同。
    expect(fileA!.spans[0]!.traceId).toBe(fileB!.spans[0]!.traceId);
    const idsA = new Set(fileA!.spans.map((span) => span.spanId));
    for (const span of fileB!.spans) expect(idsA.has(span.spanId)).toBe(false);

    // 子 agent 的 extras 保留 agentId，便于追溯（不猜父会话）。
    const rootA = fileA!.spans.find((span) => span.parentSpanId === undefined)!;
    expect(resourceAttribute(fileA!, 'asu.session.agent_label')).toBe('sidechain-agent-aaa');
    expect(stringAttribute(rootA, 'asu.agentId')).toBe('agent-aaa');
  });
});
