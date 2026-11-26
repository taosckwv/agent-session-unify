/**
 * CLI（src/index.ts）测试（DESIGN §7/§9/§11、t1 裁决 R8/R10；任务 t6）。
 *
 * 全部用临时目录 + 合成样本（AGENTS：仓库不放真实会话文件）：
 * - DSH 侧复用 tests/dsh/synthetic.ts 的真实 zstd 容器工厂（多帧解码全链路）；
 * - CC 侧用 2.1.3xx 形状的合成 jsonl 记录；
 * - 断言三件事：退出码口径（R8：部分成功 0 / 全解析失败 1 / 输入错误 2）、
 *   输出文件形状（<out>/<tool>/<sessionId>__<agentLabel>.json，§3.1）、
 *   终端摘要行（每会话 step 数/工具数/跳过与丢弃计数，§7/§11；R10 [empty]）；
 * - 确定性（§9-③）：同输入两次 runParse，输出文件字节相同。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_OUT_DIR,
  EXIT_INPUT_ERROR,
  EXIT_OK,
  EXIT_PARSE_ERROR,
  main,
  parseCliArgs,
  runParse,
} from '../src/index.js';
import { deriveSpanId, deriveTraceId, sessionSpanPath } from '../src/core/ids.js';
import { event, writeSessionFile, type SyntheticSession } from './dsh/synthetic.js';

// ---------------------------------------------------------------------------
// 基础设施
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'asu-cli-'));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  // t6 F7：Windows 上句柄释放有延迟，用重试清理；失败只吞掉，不影响断言结果。
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // 清理尽力而为。
    }
  }
});

/** 读输出文件的 span 列表（tracesData → resourceSpans[0].scopeSpans[0].spans）。 */
function readSpans(file: string): Array<Record<string, unknown>> {
  const td = JSON.parse(readFileSync(file, 'utf8')) as {
    resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: Array<Record<string, unknown>> }> }>;
  };
  return td.resourceSpans?.[0]?.scopeSpans?.[0]?.spans ?? [];
}

// ---------------------------------------------------------------------------
// 合成样本
// ---------------------------------------------------------------------------

/** 紧凑 DSH v4 会话：1 轮 / 1 步 / 1 工具（结构事件全链路）。 */
function makeDshSession(): SyntheticSession {
  return {
    id: 'sess-1',
    origin: 'subagent',
    headerExtra: { parentSession: 'sess-0' },
    events: [
      event('turn/start', 1, 1000, { turn: 1 }),
      event('user/message', 2, 1100, {
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'user' },
        role: 'user',
        id: 'm1',
      }),
      event('step/start', 3, 1200, { turn: 1, step: 1 }),
      event('assistant/message', 4, 1500, {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hello' }],
          source: { kind: 'model', provider: 'p', model: 'm-1' },
          id: 'a1',
        },
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 18 },
      }),
      event('tool/call', 5, 1600, {
        turn: 1,
        step: 1,
        callId: 'c1',
        name: 'read_file',
        arguments: '{"path":"a.txt"}',
      }),
      event('tool/result', 6, 1700, {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          toolCallId: 'c1',
          content: [{ type: 'text', text: 'ok' }],
          id: 't1',
          source: { kind: 'tool', callId: 'c1' },
        },
      }),
      event('step/end', 7, 1800, { turn: 1, step: 1 }),
      event('turn/end', 8, 1900, { turn: 1, reason: { kind: 'completed' } }),
    ],
  };
}

const CC_BASE = {
  isSidechain: false,
  userType: 'external',
  entrypoint: 'cli',
  cwd: 'C:\\proj',
  sessionId: 'cc-sess-1',
  version: '2.1.303',
  gitBranch: 'main',
};

/**
 * 写一个合成 CC 会话文件（1 turn / 1 step / 1 配对工具），
 * `sessionId` 覆盖记录里的会话 id。
 */
function writeCc(dir: string, name: string, sessionId = 'cc-sess-1'): string {
  const base = { ...CC_BASE, sessionId };
  const lines = [
    JSON.stringify({
      ...base,
      parentUuid: null,
      type: 'user',
      message: { role: 'user', content: 'hi' },
      uuid: 'u1',
      timestamp: '2026-11-25T03:00:01.000Z',
    }),
    JSON.stringify({
      ...base,
      parentUuid: 'u1',
      type: 'assistant',
      message: {
        id: 'msg-1',
        type: 'message',
        role: 'assistant',
        model: 'claude-x',
        content: [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls' } }],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      uuid: 'a1',
      timestamp: '2026-11-25T03:00:02.000Z',
      apiBlockIndex: 0,
      requestRef: 'req-1',
      requestedModel: 'claude-x',
    }),
    JSON.stringify({
      ...base,
      parentUuid: 'a1',
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }],
      },
      uuid: 'u2',
      timestamp: '2026-11-25T03:00:03.000Z',
    }),
  ];
  const path = join(dir, name);
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
  return path;
}

// ---------------------------------------------------------------------------
// parseCliArgs
// ---------------------------------------------------------------------------

describe('parseCliArgs（参数解析，DESIGN §7）', () => {
  it('默认输出目录是 data/unified', () => {
    expect(DEFAULT_OUT_DIR).toBe('data/unified');
    expect(parseCliArgs(['parse', 'a.jsonl'])).toEqual({
      ok: true,
      paths: ['a.jsonl'],
      outDir: DEFAULT_OUT_DIR,
    });
  });

  it('--out <目录> 空格形式 + 多路径', () => {
    expect(parseCliArgs(['parse', 'a', 'b', '--out', 'x/y'])).toEqual({
      ok: true,
      paths: ['a', 'b'],
      outDir: 'x/y',
    });
  });

  it('--out=<目录> 等号形式', () => {
    expect(parseCliArgs(['parse', 'a', '--out=x'])).toEqual({
      ok: true,
      paths: ['a'],
      outDir: 'x',
    });
  });

  it('旗标出现在路径前面也允许', () => {
    expect(parseCliArgs(['parse', '--out', 'x', 'a'])).toEqual({
      ok: true,
      paths: ['a'],
      outDir: 'x',
    });
  });

  it('缺命令 → 用法错误', () => {
    const r = parseCliArgs([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('缺少命令');
  });

  it('未知命令 → 用法错误', () => {
    const r = parseCliArgs(['run', 'a']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('未知命令');
  });

  it('无路径 → 错误', () => {
    const r = parseCliArgs(['parse']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('至少提供');
  });

  it('--out 缺值 → 错误', () => {
    const r = parseCliArgs(['parse', 'a', '--out']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('缺少目录参数');
  });

  it('未知旗标 → 错误（不当作路径）', () => {
    const r = parseCliArgs(['parse', 'a', '--wat']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('未知参数');
  });

  it('--out 重复指定 → 错误', () => {
    const r = parseCliArgs(['parse', 'a', '--out', 'x', '--out', 'y']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('只能指定一次');
  });
});

// ---------------------------------------------------------------------------
// runParse：DSH 侧
// ---------------------------------------------------------------------------

describe('runParse：DSH .zstd（成功与坏输入）', () => {
  it('单文件成功：解析 → 组装 → 写盘 → 摘要（DESIGN §3.1/§7/§11）', () => {
    const dir = tempDir();
    const file = writeSessionFile(dir, makeDshSession());
    const out = join(tempDir(), 'out');
    const result = runParse([file], out);

    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.successCount).toBe(1);
    expect(result.errorLines).toEqual([]);

    expect(result.sessions.length).toBe(1);
    const s = result.sessions[0];
    expect(s?.sessionId).toBe('sess-1');
    expect(s?.agentLabel).toBe('subagent'); // t9：直接用解析器 label，不加后缀
    expect(s?.steps).toBe(1);
    expect(s?.tools).toBe(1);
    expect(s?.parseErrors).toBe(0);
    expect(s?.empty).toBe(false);

    // 文件路径形状：<out>/<toolName>/<sessionId>__<agentLabel>.json
    expect(result.writtenFiles.length).toBe(1);
    const written = result.writtenFiles[0] ?? '';
    expect(written).toBe(join(out, 'dsh', 'sess-1__subagent.json'));
    expect(existsSync(written)).toBe(true);

    // 输出内容：四层 span、确定性 id
    const spans = readSpans(written);
    expect(spans.length).toBe(4); // session + turn + step + tool
    expect(spans[0]?.traceId).toBe(deriveTraceId('sess-1'));
    expect(spans[0]?.spanId).toBe(deriveSpanId('sess-1__subagent', sessionSpanPath()));
    expect(new Set(spans.map((sp) => sp.traceId)).size).toBe(1);

    // 摘要行：step 数、工具数、跳过与丢弃计数
    expect(s?.line).toContain('[dsh] sess-1__subagent：1步/1工具');
    expect(s?.line).toContain('跳过=0');
    expect(s?.line).toContain('未识别=0');
    expect(result.lines[result.lines.length - 1] ?? '').toContain(
      '完成：1 个会话、写入 1 个文件',
    );
  });

  it('v3 文件整文件跳过：仅统计空树、终端标 [empty]、仍写文件（R5/R10）', () => {
    const dir = tempDir();
    const v3 = writeSessionFile(dir, { ...makeDshSession(), version: 3 });
    const out = join(tempDir(), 'out');
    const result = runParse([v3], out);

    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.sessions.length).toBe(1);
    expect(result.sessions[0]?.steps).toBe(0);
    expect(result.sessions[0]?.skippedV3).toBe(1);
    expect(result.sessions[0]?.line).toContain('[empty]');
    expect(result.sessions[0]?.line).toContain('v3=1');
    expect(result.writtenFiles.length).toBe(1);
    expect(readSpans(result.writtenFiles[0] ?? '').length).toBe(1); // 只有根 span
  });

  it('目录参数取最高版本（v3+v4 同目录 → 只解析 v4，不猜）', () => {
    const dir = tempDir();
    writeSessionFile(dir, { ...makeDshSession(), version: 3 }, 'session.v3.jsonl.zstd');
    writeSessionFile(dir, makeDshSession(), 'session.v4.jsonl.zstd');
    const result = runParse([dir], join(tempDir(), 'out'));

    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.sessions.length).toBe(1);
    expect(result.sessions[0]?.steps).toBe(1); // v4 内容
    expect(result.sessions[0]?.skippedV3).toBe(0); // 同目录 v3 未读（只读最高 vN）
  });

  it('垃圾 .zstd：全解析失败 → 退出码 1（R8），占位错误树仍写盘', () => {
    const dir = tempDir();
    const garbage = join(dir, 'garbage.zstd');
    writeFileSync(garbage, '这不是 zstd 数据', 'utf8');
    const result = runParse([garbage], join(tempDir(), 'out'));

    expect(result.exitCode).toBe(EXIT_PARSE_ERROR);
    expect(result.successCount).toBe(0);
    expect(result.parseFailureCount).toBe(1);
    expect(result.errorLines.some((l) => l.includes('[解析失败]'))).toBe(true);
    expect(result.writtenFiles.length).toBe(1); // R8：错误树也落盘（可对账）
  });
});

// ---------------------------------------------------------------------------
// runParse：CC 侧
// ---------------------------------------------------------------------------

describe('runParse：CC .jsonl（成功与目录分派）', () => {
  it('单文件成功：1 turn / 1 step / 1 配对工具 → claude-code 输出目录', () => {
    const dir = tempDir();
    const file = writeCc(dir, 'a.jsonl', 'cc-sess-1');
    const out = join(tempDir(), 'out');
    const result = runParse([file], out);

    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.successCount).toBe(1);
    expect(result.sessions[0]?.sessionId).toBe('cc-sess-1');
    expect(result.sessions[0]?.agentLabel).toBe('main');
    expect(result.sessions[0]?.steps).toBe(1);
    expect(result.sessions[0]?.tools).toBe(1);
    expect(result.writtenFiles[0]).toBe(join(out, 'claude-code', 'cc-sess-1__main.json'));
    expect(readSpans(result.writtenFiles[0] ?? '').length).toBe(4); // session+turn+step+tool
    expect(result.sessions[0]?.line).toContain('[claude-code] cc-sess-1__main：1步/1工具');
  });

  it('目录参数取全部 *.jsonl 直接子文件（按名排序，确定性）', () => {
    const dir = tempDir();
    writeCc(dir, 'b.jsonl', 'cc-b');
    writeCc(dir, 'a.jsonl', 'cc-a');
    const result = runParse([dir], join(tempDir(), 'out'));

    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.sessions.length).toBe(2);
    expect(result.sessions.map((s) => s.sessionId)).toEqual(['cc-a', 'cc-b']);
    expect(result.writtenFiles.length).toBe(2);
  });

  it('重写副本（.orphaned-*）整文件跳过：行数计跳过、标 [empty]（R7）', () => {
    const dir = tempDir();
    const file = writeCc(dir, '.orphaned-a.jsonl', 'cc-a');
    const result = runParse([file], join(tempDir(), 'out'));

    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.sessions[0]?.steps).toBe(0);
    expect(result.sessions[0]?.skippedRecords).toBe(3);
    expect(result.sessions[0]?.line).toContain('[empty]');
    expect(result.sessions[0]?.line).toContain('跳过=3');
    expect(result.writtenFiles.length).toBe(1);
  });

  it('混合目录：session.v4.jsonl.zstd 走 DSH、*.jsonl 走 CC（按内容分派）', () => {
    const dir = tempDir();
    writeSessionFile(dir, makeDshSession(), 'session.v4.jsonl.zstd');
    writeCc(dir, 'note.jsonl', 'cc-note');
    const out = join(tempDir(), 'out');
    const result = runParse([dir], out);

    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.sessions.length).toBe(2);
    expect(result.sessions[0]?.tool).toBe('dsh'); // DSH 树在前（固定顺序）
    expect(result.sessions[1]?.tool).toBe('claude-code');
    expect(result.writtenFiles.length).toBe(2);
    expect(
      result.writtenFiles.some((p) => p.includes(join('dsh', 'sess-1__subagent.json'))),
    ).toBe(true);
    expect(
      result.writtenFiles.some((p) => p.includes(join('claude-code', 'cc-note__main.json'))),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runParse：退出码与失败隔离（R8）
// ---------------------------------------------------------------------------

describe('runParse：退出码三态（R8）', () => {
  it('部分成功（好文件 + 缺失路径）→ 0，输入错误点名', () => {
    const dir = tempDir();
    const cc = writeCc(dir, 'a.jsonl', 'cc-a');
    const result = runParse([cc, join(dir, 'missing.jsonl')], join(tempDir(), 'out'));

    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.successCount).toBe(1);
    expect(result.inputErrorCount).toBe(1);
    expect(result.errorLines.some((l) => l.includes('[输入错误]'))).toBe(true);
  });

  it('全部路径不存在 → 退出码 2（输入错误）', () => {
    const result = runParse(
      [join(tempDir(), 'nope-1'), join(tempDir(), 'nope-2')],
      join(tempDir(), 'out'),
    );

    expect(result.exitCode).toBe(EXIT_INPUT_ERROR);
    expect(result.sessions.length).toBe(0);
    expect(result.writtenFiles.length).toBe(0);
    expect(result.inputErrorCount).toBe(2);
  });

  it('无法分派的扩展名 → 输入错误（只有它时退出码 2）', () => {
    const dir = tempDir();
    const txt = join(dir, 'readme.txt');
    writeFileSync(txt, 'hello', 'utf8');
    const result = runParse([txt], join(tempDir(), 'out'));

    expect(result.exitCode).toBe(EXIT_INPUT_ERROR);
    expect(result.errorLines.some((l) => l.includes('无法分派'))).toBe(true);
  });

  it('空目录（无会话文件）→ 输入错误', () => {
    const dir = tempDir();
    const result = runParse([dir], join(tempDir(), 'out'));

    expect(result.exitCode).toBe(EXIT_INPUT_ERROR);
    expect(result.errorLines.some((l) => l.includes('没有会话文件'))).toBe(true);
  });

  it('输出目录被文件占位 → 写盘失败计入解析失败，退出码 1', () => {
    const dir = tempDir();
    const cc = writeCc(dir, 'a.jsonl', 'cc-a');
    const blocker = join(tempDir(), 'blocker');
    writeFileSync(blocker, 'x', 'utf8');
    const result = runParse([cc], blocker);

    expect(result.exitCode).toBe(EXIT_PARSE_ERROR);
    expect(result.successCount).toBe(0);
    expect(result.errorLines.some((l) => l.includes('[输出失败]'))).toBe(true);
    expect(result.sessions[0]?.file).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 确定性与文件名冲突
// ---------------------------------------------------------------------------

describe('确定性与文件名（DESIGN §9-③/§10、otlp.ts 同名兜底）', () => {
  it('同输入两次 runParse：输出文件字节相同（CC）', () => {
    const dir = tempDir();
    const cc = writeCc(dir, 'a.jsonl', 'cc-a');
    const out1 = join(tempDir(), 'out1');
    const out2 = join(tempDir(), 'out2');
    runParse([cc], out1);
    runParse([cc], out2);

    const f1 = join(out1, 'claude-code', 'cc-a__main.json');
    const f2 = join(out2, 'claude-code', 'cc-a__main.json');
    expect(existsSync(f1)).toBe(true);
    expect(existsSync(f2)).toBe(true);
    expect(readFileSync(f1, 'utf8')).toBe(readFileSync(f2, 'utf8'));
  });

  it('同输入两次 runParse：输出文件字节相同（DSH，含 zstd 解码全链路）', () => {
    const dir = tempDir();
    const dsh = writeSessionFile(dir, makeDshSession());
    const out1 = join(tempDir(), 'out1');
    const out2 = join(tempDir(), 'out2');
    runParse([dsh], out1);
    runParse([dsh], out2);

    const f1 = join(out1, 'dsh', 'sess-1__subagent.json');
    const f2 = join(out2, 'dsh', 'sess-1__subagent.json');
    expect(readFileSync(f1, 'utf8')).toBe(readFileSync(f2, 'utf8'));
  });

  it('净化后同名冲突：第二个文件按 -2 递增后缀，内容不丢（otlp.ts 钦定兜底）', () => {
    const dir = tempDir();
    const one = writeCc(dir, 'one.jsonl', 'a b'); // 净化后 a_b
    const two = writeCc(dir, 'two.jsonl', 'a_b'); // 净化后同为 a_b
    const out = join(tempDir(), 'out');
    const result = runParse([one, two], out);

    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.writtenFiles.length).toBe(2);
    expect(result.writtenFiles[0]).toContain('a_b__main.json');
    expect(result.writtenFiles[1]).toContain('a_b__main-2.json');
    // 两个会话内容都在盘上（身份原文不同：'a b' vs 'a_b'）
    const first = readFileSync(result.writtenFiles[0] ?? '', 'utf8');
    const second = readFileSync(result.writtenFiles[1] ?? '', 'utf8');
    expect(first).not.toBe(second);
    expect(first).toContain('"a b"');
    expect(second).toContain('"a_b"');
  });
});

// ---------------------------------------------------------------------------
// main 集成
// ---------------------------------------------------------------------------

describe('main（终端接线）', () => {
  it('用法错误 → 退出码 2，错误走 stderr', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(main(['parse'])).toBe(EXIT_INPUT_ERROR);
      expect(errSpy).toHaveBeenCalled();
      expect(String(errSpy.mock.calls[0]?.[0])).toContain('至少提供');
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('成功路径 → 退出码 0，会话摘要与汇总走 stdout', () => {
    const dir = tempDir();
    const cc = writeCc(dir, 'a.jsonl', 'cc-a');
    const out = join(tempDir(), 'out');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(main(['parse', cc, '--out', out])).toBe(EXIT_OK);
      const logged = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('[claude-code] cc-a__main：1步/1工具');
      expect(logged).toContain('完成：1 个会话、写入 1 个文件');
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('全部路径缺失 → 退出码 2', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(main(['parse', join(tempDir(), 'definitely-missing-404')])).toBe(
        EXIT_INPUT_ERROR,
      );
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
