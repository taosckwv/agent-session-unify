/**
 * DSH 侧独立集成测试（tests/integration/dsh.test.ts）。
 *
 * 与 tests/dsh/*.test.ts 的区别：这里只从 **CLI 落盘的 OTLP JSON** 反推事实，
 * 用合成夹具覆盖任务要求的边界：多帧/跨帧行、撕裂尾帧、坏帧、未知事件、
 * 重复 seq、缺时间戳、compaction 用量独立 span、跨 trace 父引用。
 *
 * 运行：npx vitest run tests/integration/dsh.test.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runParse } from '../../src/index.js';
import {
  dshChildRecords,
  dshCompactionRecords,
  dshEvent,
  dshJsonl,
  dshMainRecords,
  dshMainRecordsWithBadLine,
  dshNoTimeRecords,
  dshSessionHeader,
  dshV3Records,
} from '../fixtures/dsh.js';
import {
  assertOutputInvariants,
  assertResourceIdentity,
  attributeValue,
  compressChunksToFrames,
  findSpan,
  hasAttribute,
  intAttribute,
  isCompactionSpan,
  loadOutputDir,
  makeTempDir,
  readOutputFile,
  removeTempDir,
  scalarAttribute,
  spansNamed,
  stringAttribute,
  writeDshSessionFile,
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

/** 写一个 DSH 会话文件到临时目录并跑一次 CLI 解析。 */
function runDshSession(
  chunks: Array<Buffer | string>,
  options: { fileName?: string } = {},
): RunResult {
  const work = workDir('asu-int-dsh-');
  const sessionDir = join(work, 'sessions', 'fixture-session');
  mkdirSync(sessionDir, { recursive: true });
  writeDshSessionFile(sessionDir, chunks, options.fileName ?? 'session.v4.jsonl.zstd');
  const outDir = join(work, 'out');
  const result = runParse([sessionDir], outDir);
  return { work, outDir, result };
}

/** 单文件单帧的便捷入口。 */
function runDshRecords(records: Array<Record<string, unknown> | string>): RunResult {
  return runDshSession([dshJsonl(records)]);
}

function singleOutput(run: RunResult) {
  const files = loadOutputDir(run.outDir);
  expect(files).toHaveLength(1);
  return files[0] as ReturnType<typeof readOutputFile>;
}

describe('DSH 集成：主会话基线（逐字段 + 三件套）', () => {
  it('落盘产物满足字段齐全/结构自洽/条数守恒，且统计与 CLI 摘要一致', () => {
    const run = runDshRecords(dshMainRecords());
    expect(run.result.exitCode).toBe(0);
    expect(run.result.successCount).toBe(1);
    expect(run.result.parseFailureCount).toBe(0);
    expect(run.result.sessions).toHaveLength(1);

    const file = singleOutput(run);
    expect(file.relPath).toBe('dsh/dsh-fixture-main__main.json');
    assertResourceIdentity(file, { tool: 'dsh', sessionId: 'dsh-fixture-main', agentLabel: 'main' });

    const invariants = assertOutputInvariants(file);
    // 四层：session/turn/step/tool；无 compaction。
    expect(invariants.spanCount).toBe(4);
    expect(invariants.compactionSpans).toBe(0);
    expect(invariants.fourLayerSpans).toBe(4);
    expect(invariants.inputRecords).toBe(13);
    expect(invariants.skippedRecords).toBe(1);
    expect(invariants.sourceRefTotal).toBe(12);

    const root = file.spans.find((span) => span.parentSpanId === undefined)!;
    expect(stringAttribute(root, 'asu.stats.deduped')).toBe('1');
    expect(stringAttribute(root, 'asu.stats.bad_lines')).toBe('0');
    expect(stringAttribute(root, 'asu.stats.frames')).toBe('1');
    expect(stringAttribute(root, 'asu.stats.failed_frames')).toBe('0');
    expect(stringAttribute(root, 'asu.stats.unpaired_tools')).toBe('0');
    expect(stringAttribute(root, 'asu.stats.duplicate_usage')).toBe('0');
    expect(stringAttribute(root, 'asu.stats.usage_snapshots')).toBe('0');
    expect(stringAttribute(root, 'asu.stats.skipped_v3')).toBe('0');
    expect(stringAttribute(root, 'asu.stats.unknown_event_types.mystery/fixture')).toBe('1');
    // 未知事件 / 会话级事件必须原样保留在会话根 span 的 extras 里，不截断。
    expect(stringAttribute(root, 'asu.events')).toContain('untouched-payload');
    expect(stringAttribute(root, 'asu.events')).toContain('fixture title 标题');

    // 节点身份：span 名用 0 基序号（turn 0 / step 0/0），与解析层序号一致。
    expect(spansNamed(file, 'turn 0')).toHaveLength(1);
    expect(spansNamed(file, 'step 0/0')).toHaveLength(1);
    // source_ref_count：turn=start/end 2 条；step=user/step-start/header/assistant/step-end 5 条；
    // tool=call/result 2 条；会话根=header/未知事件/会话级事件 3 条；合计 12。
    expect(intAttribute(findSpan(file, (span) => span.name === 'turn 0'), 'asu.source_ref_count')).toBe(2);
    expect(intAttribute(findSpan(file, (span) => span.name === 'step 0/0'), 'asu.source_ref_count')).toBe(5);
    expect(intAttribute(findSpan(file, (span) => span.name === 'read_file'), 'asu.source_ref_count')).toBe(2);
    expect(intAttribute(root, 'asu.source_ref_count')).toBe(3);

    // 用量映射（R1）与 totalTokens 不重算（R11）。
    const step = findSpan(file, (span) => span.name === 'step 0/0');
    expect(intAttribute(step, 'gen_ai.usage.input_tokens')).toBe(100);
    expect(intAttribute(step, 'gen_ai.usage.output_tokens')).toBe(20);
    expect(intAttribute(step, 'gen_ai.usage.output_tokens.reasoning_tokens')).toBe(5);
    expect(intAttribute(step, 'gen_ai.token_count.cache_read')).toBe(7);
    expect(intAttribute(step, 'asu.usage.cache_write')).toBe(3);
    expect(intAttribute(step, 'asu.usage.total_tokens')).toBe(127);
    expect(stringAttribute(step, 'gen_ai.request.model')).toBe('fixture-model');
    expect(stringAttribute(step, 'gen_ai.input.messages')).toContain('请读取 a.txt');
    expect(stringAttribute(step, 'gen_ai.output.messages')).toContain('好的');

    // 工具配对与原文保留。
    const tool = findSpan(file, (span) => span.name === 'read_file');
    expect(stringAttribute(tool, 'asu.tool.pairing')).toBe('paired');
    expect(hasAttribute(tool, 'asu.pending_or_interrupted')).toBe(false);
    expect(stringAttribute(tool, 'gen_ai.tool.call.id')).toBe('call-1');
    expect(stringAttribute(tool, 'gen_ai.tool.call.arguments')).toBe('{"path":"a.txt"}');
    expect(stringAttribute(tool, 'gen_ai.tool.call.result')).toBe('文件内容');

    // 终端摘要如实反映 1 步 1 工具；[empty] 不得出现。
    expect(run.result.lines.join('\n')).toContain('dsh-fixture-main__main');
    expect(run.result.lines.join('\n')).toContain('1步/1工具');
    expect(run.result.lines.join('\n')).not.toContain('[empty]');
  });

  it('两次独立解析：输出文件名集合、字节与 SHA256 完全一致（确定性）', () => {
    const work = workDir('asu-int-dsh-determinism-');
    const sessionDir = join(work, 'sessions');
    mkdirSync(sessionDir, { recursive: true });
    writeDshSessionFile(sessionDir, [dshJsonl(dshMainRecords())]);

    const outA = join(work, 'out-a');
    const outB = join(work, 'out-b');
    expect(runParse([sessionDir], outA).exitCode).toBe(0);
    expect(runParse([sessionDir], outB).exitCode).toBe(0);

    const filesA = loadOutputDir(outA);
    const filesB = loadOutputDir(outB);
    expect(filesA.map((file) => file.relPath)).toEqual(filesB.map((file) => file.relPath));
    expect(filesA).toHaveLength(1);
    expect(filesA[0]!.text).toBe(filesB[0]!.text);
  });

  it('坏行只计数不中断：输入条数守恒仍成立', () => {
    const run = runDshRecords(dshMainRecordsWithBadLine());
    const file = singleOutput(run);
    const invariants = assertOutputInvariants(file);
    expect(invariants.inputRecords).toBe(14);
    expect(invariants.skippedRecords).toBe(2); // 重复 seq 1 + 坏行 1
    expect(invariants.sourceRefTotal).toBe(12);
    const root = file.spans.find((span) => span.parentSpanId === undefined)!;
    expect(stringAttribute(root, 'asu.stats.bad_lines')).toBe('1');
    expect(run.result.exitCode).toBe(0);
  });

  it('缺时间戳：根 span start=0，unknown_times 计数 > 0，end >= start（不伪造时间）', () => {
    const run = runDshRecords(dshNoTimeRecords());
    const file = singleOutput(run);
    assertOutputInvariants(file);
    const root = file.spans.find((span) => span.parentSpanId === undefined)!;
    expect(root.startTimeUnixNano).toBe('0');
    expect(Number(stringAttribute(root, 'asu.stats.unknown_times'))).toBeGreaterThan(0);
    for (const span of file.spans) {
      expect(BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano)).toBe(true);
    }
  });

  it('v3 会话：整文件计跳过，仍产出仅统计空树文件并标记 [empty]（R5/R10）', () => {
    const run = runDshRecords(dshV3Records());
    expect(run.result.exitCode).toBe(0);
    const file = singleOutput(run);
    const invariants = assertOutputInvariants(file);
    expect(invariants.spanCount).toBe(1);
    expect(invariants.inputRecords).toBe(4);
    expect(invariants.skippedRecords).toBe(4);
    expect(invariants.sourceRefTotal).toBe(0);
    const root = file.spans[0]!;
    expect(stringAttribute(root, 'asu.stats.skipped_v3')).toBe('1');
    expect(stringAttribute(root, 'asu.stats.produced_spans')).toBe('1');
    expect(run.result.lines.join('\n')).toContain('[empty]');
  });
});

describe('DSH 集成：compaction 用量独立 span', () => {
  it('compaction/summary 的 usage 落成独立子 span，不污染 step.usage，且计入 produced_spans', () => {
    const run = runDshRecords(dshCompactionRecords());
    const file = singleOutput(run);
    const invariants = assertOutputInvariants(file);
    // 1 turn / 1 step（无工具）= 3 个四层 span + 1 个 compaction span。
    expect(invariants.spanCount).toBe(4);
    expect(invariants.compactionSpans).toBe(1);
    expect(invariants.fourLayerSpans).toBe(3);

    const root = file.spans.find((span) => span.parentSpanId === undefined)!;
    expect(stringAttribute(root, 'asu.stats.compaction_spans')).toBe('1');

    const compaction = findSpan(file, isCompactionSpan);
    expect(compaction.name).toBe('compaction');
    expect(stringAttribute(compaction, 'asu.compaction.event_type')).toBe('compaction/summary');
    expect(intAttribute(compaction, 'gen_ai.usage.input_tokens')).toBe(900);
    expect(intAttribute(compaction, 'gen_ai.usage.output_tokens')).toBe(50);
    expect(intAttribute(compaction, 'asu.usage.total_tokens')).toBe(950);
    expect(compaction.startTimeUnixNano).toBe(compaction.endTimeUnixNano);

    // compaction span 挂在 turn 下；step 自己的 usage 不被覆盖。
    const turn = findSpan(file, (span) => span.name === 'turn 0');
    expect(compaction.parentSpanId).toBe(turn.spanId);
    const step = findSpan(file, (span) => span.name === 'step 0/0');
    expect(intAttribute(step, 'gen_ai.usage.input_tokens')).toBe(100);
    expect(intAttribute(step, 'gen_ai.usage.output_tokens')).toBe(20);
    expect(hasAttribute(step, 'asu.usage.total_tokens')).toBe(false);
  });
});

describe('DSH 集成：跨 trace 父引用（t12 修补）', () => {
  it('父 sessionId 不同：省略 parentSpanId，保留 asu.parent_session.* 四属性', () => {
    const run = runDshRecords(dshChildRecords());
    const file = singleOutput(run);
    assertOutputInvariants(file);
    const root = file.spans.find((span) => span.parentSpanId === undefined)!;
    expect(root.parentSpanId).toBeUndefined();
    expect(stringAttribute(root, 'asu.parent_session.id')).toBe('dsh-fixture-parent');
    expect(stringAttribute(root, 'asu.parent_session.agent_label')).toBe('main');
    expect(stringAttribute(root, 'asu.parent_session.trace_id')).toMatch(/^[0-9a-f]{32}$/);
    expect(stringAttribute(root, 'asu.parent_session.span_id')).toMatch(/^[0-9a-f]{16}$/);
    expect(stringAttribute(root, 'asu.parent_session.trace_id')).not.toBe(root.traceId);
    expect(intAttribute(root, 'asu.session.delegation_depth')).toBe(1);
  });
});

describe('DSH 集成：zstd 帧边界（R3 / 撕裂 / 坏帧）', () => {
  it('一个帧可含多行；行被切在 UTF-8 多字节字符中间也不撕裂（拼帧后再按行切）', () => {
    const text = dshJsonl(dshMainRecords());
    const bytes = Buffer.from(text, 'utf8');
    const marker = Buffer.from('请读取 a.txt', 'utf8');
    const at = bytes.indexOf(marker);
    expect(at).toBeGreaterThan(0);
    const split = at + 1; // 落在「请」的 3 字节内部
    expect(split).toBeLessThan(bytes.length);

    const run = runDshSession([bytes.subarray(0, split), bytes.subarray(split)]);
    expect(run.result.exitCode).toBe(0);
    const file = singleOutput(run);
    const invariants = assertOutputInvariants(file);
    expect(invariants.spanCount).toBe(4);
    expect(invariants.inputRecords).toBe(13);
    const step = findSpan(file, (span) => span.name === 'step 0/0');
    expect(stringAttribute(step, 'gen_ai.input.messages')).toContain('请读取 a.txt');
  });

  it('撕裂尾帧：坏帧只计数、已解码部分照常解析，不抛异常', () => {
    const records = dshMainRecords();
    // 切点必须自带换行：多帧容器的语义是「各帧输出首尾拼接成完整文本」。
    const firstChunk = dshJsonl(records.slice(0, 2), { trailingNewline: true }); // header + turn/start
    const rest = dshJsonl(records.slice(2));
    const frames = compressChunksToFrames([firstChunk, rest]);
    const truncated = frames.subarray(0, frames.length - 6);

    const work = workDir('asu-int-dsh-torn-');
    const sessionDir = join(work, 'sessions');
    mkdirSync(sessionDir, { recursive: true });
    const sessionPath = join(sessionDir, 'session.v4.jsonl.zstd');
    writeFileSync(sessionPath, truncated);

    const outDir = join(work, 'out');
    const result = runParse([sessionPath], outDir);
    expect(result.exitCode).toBe(0);
    const file = singleOutput({ work, outDir, result });
    const invariants = assertOutputInvariants(file);
    expect(invariants.spanCount).toBe(2); // session + turn（第二个帧的内容没了）
    expect(invariants.inputRecords).toBe(2);
    expect(invariants.skippedRecords).toBe(0);
    const root = file.spans.find((span) => span.parentSpanId === undefined)!;
    expect(stringAttribute(root, 'asu.stats.failed_frames')).toBe('1');
    expect(stringAttribute(root, 'asu.stats.frames')).toBe('1');
  });

  it('中间坏帧（magic 正确但数据非法）：跳过该帧继续解后面的帧', () => {
    const records = dshMainRecords();
    // 切点自带换行（见上）：否则两行会粘成一行非法 JSON。
    const first = Buffer.from(dshJsonl(records.slice(0, 2), { trailingNewline: true }), 'utf8'); // header + turn/start
    // 第三帧用一条会话级事件（非重复 seq），证明坏帧之后的行仍被解析。
    const tail = Buffer.from(
      dshJsonl([{ type: 'session/title', seq: 11, data: { title: 'bad-frame-survivor' } }]),
      'utf8',
    );
    const badMiddle = Buffer.concat([
      Buffer.from([0x28, 0xb5, 0x2f, 0xfd]),
      Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
    ]);
    const bytes = Buffer.concat([compressChunksToFrames([first]), badMiddle, compressChunksToFrames([tail])]);

    const work = workDir('asu-int-dsh-badframe-');
    const sessionPath = join(work, 'session.v4.jsonl.zstd');
    writeFileSync(sessionPath, bytes);

    const outDir = join(work, 'out');
    const result = runParse([sessionPath], outDir);
    expect(result.exitCode).toBe(0);
    const file = singleOutput({ work, outDir, result });
    const invariants = assertOutputInvariants(file);
    expect(invariants.inputRecords).toBe(3); // header + turn/start + session/title
    expect(invariants.skippedRecords).toBe(0);
    expect(invariants.sourceRefTotal).toBe(3);
    const root = file.spans.find((span) => span.parentSpanId === undefined)!;
    expect(stringAttribute(root, 'asu.stats.failed_frames')).toBe('1');
    expect(stringAttribute(root, 'asu.stats.frames')).toBe('2');
    expect(stringAttribute(root, 'asu.events')).toContain('bad-frame-survivor');
  });
});

describe('DSH 集成：会话身份兜底（R6）', () => {
  it('header 缺 id 时用目录名兜底并标记 session_id_source=filename', () => {
    const header = dshSessionHeader();
    delete header.id;
    const sessionId = 'session-fixture-fallback';
    const work = workDir('asu-int-dsh-fallback-');
    const sessionDir = join(work, sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeDshSessionFile(sessionDir, [dshJsonl([header])]);
    const outDir = join(work, 'out');
    const result = runParse([sessionDir], outDir);
    expect(result.exitCode).toBe(0);
    const files = loadOutputDir(outDir);
    expect(files).toHaveLength(1);
    expect(files[0]!.relPath).toBe(`dsh/${sessionId}__main.json`);
    const root = files[0]!.spans[0]!;
    expect(stringAttribute(root, 'asu.session_id_source')).toBe('filename');
    // 文件名兜底不能把 'session.vN' 裸名当会话 id（否则不同会话互相覆盖）。
    expect(scalarAttribute(root, 'asu.session.id')).toBeUndefined(); // 身份在 resource 上
    expect(attributeValue(root, 'asu.session_id_source')).toBeDefined();
  });
});

describe('DSH 集成：已知缺陷记录（不计入验收通过项）', () => {
  // 观察到的行为：若某条 step 级事件先于该 step 的 `step/start` 到达（解析器支持
  // 「迟到事件按 turn/step 编号归位」，会按编号建步），随后真正的 `step/start`
  // 仍会**再建一个步**（onStepStart 无条件 createStep，不按编号复用），
  // 于是一个逻辑 step 变成两个 span（各带半数 sourceRefs）。
  // 真实 286 个 v4 会话（719 turn）中未出现该序列，故按低危记录、不阻塞验收；
  // 用 it.fails 固化现状：将来修复后本用例会转红，提醒改成正向断言。
  it.fails('D1（低危）：迟到的 step/start 会为同一 (turn, step) 再建一个 step span', () => {
    const records = [
      dshSessionHeader({ id: 'dsh-fixture-late-step' }),
      dshEvent('turn/start', { seq: 1, offsetMs: 0, data: { turn: 1 } }),
      // 迟到事件先按编号把 step 建出来
      dshEvent('assistant/message', {
        seq: 2,
        offsetMs: 10,
        data: { turn: 1, step: 1, message: { role: 'assistant', content: [] } },
      }),
      // 真正的 step/start 后到
      dshEvent('step/start', { seq: 3, offsetMs: 20, data: { turn: 1, step: 1 } }),
      dshEvent('step/end', { seq: 4, offsetMs: 30, data: { turn: 1, step: 1 } }),
      dshEvent('turn/end', { seq: 5, offsetMs: 40, data: { turn: 1, reason: { kind: 'completed' } } }),
    ];
    const file = singleOutput(runDshRecords(records));
    // 期望：一个 (turn, step) 只有一个 step span（session+turn+step = 3 个四层 span）。
    const stepSpans = file.spans.filter((span) => span.name.startsWith('step '));
    expect(stepSpans).toHaveLength(1);
    expect(file.spans).toHaveLength(3);
  });
});
