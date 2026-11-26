/**
 * CLI 端到端验收（tests/integration/cli.test.ts）。
 *
 * 目的：独立于实现，从「终端接线」这一层验收 DESIGN §7：
 * - 退出码三态：无会话/输入错误=2，有会话但全部失败=1，其余（含部分成功）=0；
 * - 坏参数不崩：无子命令、未知子命令、无路径、`--out` 缺值、未知开关、重复 `--out`；
 * - 输入分发：路径不存在 / 扩展名无法分派 / 空目录 → 2 且不写半成品；
 * - 部分成功（好文件 + 不存在路径）→ 0，错误进 stderr、摘要进 stdout；
 * - `.orphaned-*` 重写副本整文件计跳过，仍产出「仅统计」空树文件并标 [empty]；
 * - 输出目录被普通文件占用 → 写盘失败计解析失败 → 1（这是唯一能稳定触发的 1）。
 *
 * 这里只用 `main`（唯一碰 console 的函数）与落盘文件断言，不读解析器内部状态。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../src/index.js';
import { ccPrompt } from '../fixtures/cc.js';
import { buildTar, buildTarZstd } from '../fixtures/tar.js';
import { writeSessionFile } from '../dsh/synthetic.js';
import {
  assertOutputInvariants,
  loadOutputDir,
  makeTempDir,
  removeTempDir,
  writeCcSessionFile,
} from './helpers.js';

const tempDirs: string[] = [];

function workDir(prefix: string): string {
  const dir = makeTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

/** 跑一次 main，收集 stdout/stderr（不触碰真实终端）。 */
function runMain(argv: readonly string[]): { code: number; stdout: string; stderr: string } {
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.map(String).join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    err.push(args.map(String).join(' '));
  });
  try {
    const code = main(argv);
    return { code, stdout: out.join('\n'), stderr: err.join('\n') };
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  for (const dir of tempDirs) removeTempDir(dir);
});

describe('CLI 坏输入：退出码 2 且不写输出', () => {
  const cases: Array<{ name: string; argv: string[]; stderr: RegExp }> = [
    { name: '无子命令', argv: [], stderr: /parse/ },
    { name: '未知子命令', argv: ['summarize', 'x.jsonl'], stderr: /parse/ },
    { name: 'parse 无路径', argv: ['parse'], stderr: /路径|path/i },
    { name: '未知开关', argv: ['parse', '--nope', 'x.jsonl'], stderr: /--nope/ },
    { name: '--out 缺值', argv: ['parse', 'x.jsonl', '--out'], stderr: /--out/ },
    {
      name: '重复 --out',
      argv: ['parse', 'x.jsonl', '--out', 'a', '--out', 'b'],
      stderr: /--out/,
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.name} → 2，错误只进 stderr`, () => {
      const { code, stdout, stderr } = runMain(testCase.argv);
      expect(code).toBe(2);
      expect(stdout).toBe('');
      expect(stderr).toMatch(testCase.stderr);
    });
  }

  it('路径不存在 → 2，stderr 指明路径，且不写任何输出文件', () => {
    const work = workDir('asu-int-cli-missing-');
    const outDir = join(work, 'out');
    const missing = join(work, 'nope.jsonl');
    const { code, stdout, stderr } = runMain(['parse', missing, '--out', outDir]);
    expect(code).toBe(2);
    // 0 个会话时仍打一行汇总（实测行为，记录为约定而非缺陷）。
    expect(stdout).toContain('完成：0 个会话、写入 0 个文件');
    expect(stderr).toContain(missing);
    expect(existsSync(outDir), '输入错误时不应创建输出目录').toBe(false);
  });

  it('扩展名无法分派 → 2', () => {
    const work = workDir('asu-int-cli-ext-');
    const bad = join(work, 'notes.txt');
    writeFileSync(bad, 'hello', 'utf8');
    const { code, stderr } = runMain(['parse', bad, '--out', join(work, 'out')]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/扩展名|\.zstd|\.jsonl/);
  });

  it('空目录 → 2', () => {
    const work = workDir('asu-int-cli-emptydir-');
    const empty = join(work, 'empty');
    mkdirSync(empty, { recursive: true });
    const { code, stderr } = runMain(['parse', empty, '--out', join(work, 'out')]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/没有会话文件|会话文件/);
  });
});

describe('CLI 部分成功与写盘失败', () => {
  it('好文件 + 不存在路径 → 0（部分成功），错误进 stderr、摘要进 stdout', () => {
    const work = workDir('asu-int-cli-partial-');
    const ccDir = join(work, 'cc');
    mkdirSync(ccDir, { recursive: true });
    writeCcSessionFile(ccDir, [
      ccPrompt([{ type: 'text', text: '你好' }], { uuid: 'u1', timestamp: '2026-11-25T03:00:00.000Z' }),
    ]);
    const missing = join(work, 'gone.jsonl');
    const outDir = join(work, 'out');
    const { code, stdout, stderr } = runMain(['parse', ccDir, missing, '--out', outDir]);
    expect(code).toBe(0);
    expect(stderr).toContain(missing);
    expect(stdout).toContain('完成：1 个会话');
    const files = loadOutputDir(outDir);
    expect(files).toHaveLength(1);
    assertOutputInvariants(files[0]!);
  });

  it('输出目录被普通文件占用 → 写盘失败 → 1，且 stderr 说明原因', () => {
    const work = workDir('asu-int-cli-writefail-');
    const ccDir = join(work, 'cc');
    mkdirSync(ccDir, { recursive: true });
    writeCcSessionFile(ccDir, [
      ccPrompt([{ type: 'text', text: '写不进去' }], {
        uuid: 'u1',
        timestamp: '2026-11-25T03:00:00.000Z',
      }),
    ]);
    // 把 <out>/claude-code 做成普通文件，阻断 mkdir/write → 该文件计解析失败。
    const outDir = join(work, 'out');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'claude-code'), 'not a dir', 'utf8');
    const { code, stderr } = runMain(['parse', ccDir, '--out', outDir]);
    expect(code).toBe(1);
    expect(stderr.length).toBeGreaterThan(0);
  });
});

describe('CLI 输入分发：重写副本与空树', () => {
  it('.orphaned-* 整文件计跳过 → 仍写「仅统计」空树，摘要标 [empty]', () => {
    const work = workDir('asu-int-cli-orphaned-');
    const ccDir = join(work, 'cc');
    mkdirSync(ccDir, { recursive: true });
    const line = JSON.stringify({
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-11-25T03:00:00.000Z',
      sessionId: 'cc-fixture-rewrite',
      message: { role: 'user', content: [{ type: 'text', text: '被重写掉的副本' }] },
    });
    writeFileSync(join(ccDir, '.orphaned-abc123.jsonl'), `${line}\n${line}\n`, 'utf8');
    const outDir = join(work, 'out');
    const { code, stdout } = runMain(['parse', ccDir, '--out', outDir]);
    expect(code).toBe(0);
    expect(stdout).toContain('[empty]');
    const files = loadOutputDir(outDir);
    expect(files).toHaveLength(1);
    const file = files[0]!;
    assertOutputInvariants(file);
    expect(file.spans).toHaveLength(1); // 只有 session 根
    expect(file.spans[0]!.name).toMatch(/^session /);
    expect(file.spans[0]!.attributes).toBeDefined();
    // 两行都计入 skipped：input=2、skipped=2、Σrefs=0。
    const stats = new Map(
      (file.spans[0]!.attributes ?? []).map((attr) => [attr.key, attr.value]),
    );
    expect(stats.get('asu.stats.input_records')?.stringValue).toBe('2');
    expect(stats.get('asu.stats.skipped_records')?.stringValue).toBe('2');
  });

  it('目录递归展开子目录，主会话与子代理各出一个输出', () => {
    const work = workDir('asu-int-cli-recurse-');
    const ccDir = join(work, 'cc');
    const nested = join(ccDir, 'nested');
    mkdirSync(nested, { recursive: true });
    writeCcSessionFile(ccDir, [
      ccPrompt([{ type: 'text', text: '顶层' }], { uuid: 'u1', timestamp: '2026-11-25T03:00:00.000Z' }),
    ], 'top.jsonl');
    writeCcSessionFile(nested, [
      ccPrompt([{ type: 'text', text: '子目录' }], { uuid: 'u2', timestamp: '2026-11-25T03:00:00.000Z' }),
    ], 'deep.jsonl');
    const outDir = join(work, 'out');
    const { code, stdout } = runMain(['parse', ccDir, '--out', outDir]);
    expect(code).toBe(0);
    expect(stdout).toContain('完成：2 个会话');
    const files = loadOutputDir(outDir);
    expect(files).toHaveLength(2);
    for (const file of files) assertOutputInvariants(file);
  });
});

describe('CLI 归档输入：.tar.zst 一次还原主会话与子代理', () => {
  it('归档里的主会话 + subagents 全部解析，tool-results 跳过', () => {
    const work = workDir('asu-int-cli-tarzst-');
    const mainLine = JSON.stringify(
      ccPrompt([{ type: 'text', text: '主会话' }], {
        uuid: 'u1',
        timestamp: '2026-11-25T03:00:00.000Z',
        extra: { sessionId: 'packed-session' },
      }),
    );
    const subLine = JSON.stringify(
      ccPrompt([{ type: 'text', text: '子代理' }], {
        uuid: 'u2',
        timestamp: '2026-11-25T03:00:01.000Z',
        extra: { sessionId: 'packed-session', isSidechain: true, agentId: 'a1' },
      }),
    );
    const archivePath = join(work, 'packed-session.tar.zst');
    writeFileSync(
      archivePath,
      buildTarZstd([
        { name: 'packed-session.jsonl', content: `${mainLine}\n` },
        { name: 'packed-session/subagents/agent-a1.jsonl', content: `${subLine}\n` },
        { name: 'packed-session/tool-results/ignored.txt', content: '不是会话' },
      ]),
    );
    const outDir = join(work, 'out');
    const { code, stdout } = runMain(['parse', archivePath, '--out', outDir]);
    expect(code).toBe(0);
    expect(stdout).toContain('完成：2 个会话');
    const files = loadOutputDir(outDir);
    expect(files).toHaveLength(2);
    const labels = files.map((file) => file.relPath);
    expect(labels.some((label) => label.endsWith('__main.json'))).toBe(true);
    expect(labels.some((label) => label.includes('sidechain-a1'))).toBe(true);
    for (const file of files) assertOutputInvariants(file);
  });

  it('目录里混放归档与普通会话，两者都展开', () => {
    const work = workDir('asu-int-cli-mixed-');
    const input = join(work, 'input');
    mkdirSync(input, { recursive: true });
    writeCcSessionFile(input, [
      ccPrompt([{ type: 'text', text: '普通文件' }], {
        uuid: 'u1',
        timestamp: '2026-11-25T03:00:00.000Z',
        extra: { sessionId: 'plain-session' },
      }),
    ], 'plain.jsonl');
    const archivedLine = JSON.stringify(
      ccPrompt([{ type: 'text', text: '归档里' }], {
        uuid: 'u2',
        timestamp: '2026-11-25T03:00:01.000Z',
        extra: { sessionId: 'archived-session' },
      }),
    );
    writeFileSync(
      join(input, 'archived.tar.zst'),
      buildTarZstd([{ name: 'archived-session.jsonl', content: `${archivedLine}\n` }]),
    );
    const outDir = join(work, 'out');
    const { code, stdout } = runMain(['parse', input, '--out', outDir]);
    expect(code).toBe(0);
    expect(stdout).toContain('完成：2 个会话');
    expect(loadOutputDir(outDir)).toHaveLength(2);
  });

  it('损坏的归档 → 2，不写输出', () => {
    const work = workDir('asu-int-cli-badarchive-');
    const archivePath = join(work, 'broken.tar.zst');
    const bytes = buildTarZstd([{ name: 'a.jsonl', content: '{}\n' }]);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) ^ 0xff;
    writeFileSync(archivePath, bytes);
    const outDir = join(work, 'out');
    const { code, stderr } = runMain(['parse', archivePath, '--out', outDir]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/解包失败|zstd|帧/);
    expect(existsSync(outDir), '解包失败时不应创建输出目录').toBe(false);
  });

  it('归档里没有 .jsonl → 2', () => {
    const work = workDir('asu-int-cli-nojsonl-');
    const archivePath = join(work, 'notes.tar');
    writeFileSync(archivePath, buildTar([{ name: 'readme.md', content: '没有会话' }]));
    const { code, stderr } = runMain(['parse', archivePath, '--out', join(work, 'out')]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/没有 \.jsonl|没有会话/);
  });
});

describe('CLI 递归时按目录各取最高版本', () => {
  it('两个 DSH 会话目录分别取 v4 与 v3，互不覆盖', () => {
    const work = workDir('asu-int-cli-dsh-versions-');
    const dirA = join(work, 'session-a');
    const dirB = join(work, 'session-b');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    writeSessionFile(dirA, { id: 'sess-a', version: 4, events: [] });
    writeSessionFile(dirB, { id: 'sess-b', version: 3, events: [] });
    const outDir = join(work, 'out');
    const { code, stdout } = runMain(['parse', work, '--out', outDir]);
    expect(code).toBe(0);
    expect(stdout).toContain('完成：2 个会话');
    expect(loadOutputDir(outDir)).toHaveLength(2);
  });
});
