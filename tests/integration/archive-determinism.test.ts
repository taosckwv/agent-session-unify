/**
 * 归档输入的确定性回归（t1 裁决 R6、DESIGN §9-③/§10）。
 *
 * 背景：归档先解到 `mkdtemp` 临时目录再扫描，临时路径一旦进入输出
 * （`asu.sessionFile`、长 stem sidechain 的 agentLabel hash 种子、错误树），
 * 同一归档两次运行就会输出不同文件名/不同字节，且把本机临时目录泄漏出去。
 *
 * 本文件只从 CLI 落盘结果断言（不读解析器内部状态）：
 * - 同一归档同参数两次运行：输出文件名集合相同、逐文件字节相同；
 * - 输出里不得出现解包临时目录名（`asu-archive-`）；
 * - `asu.sessionFile` 必须是逻辑路径 `<归档参数>!/<成员相对路径>`；
 * - 长 stem（>54 字符）且无 agentId 的 sidechain，两次运行 label 相同；
 * - `.tar` / `.tar.gz` / `.tgz` 同样两跑一致。
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { runParse } from '../../src/index.js';
import { ccPrompt, ccTimestamp } from '../fixtures/cc.js';
import { buildTar, buildTarZstd, type TarEntry } from '../fixtures/tar.js';
import { loadOutputDir, makeTempDir, removeTempDir } from './helpers.js';

const tempDirs: string[] = [];

function workDir(prefix: string): string {
  const dir = makeTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) removeTempDir(dir);
});

interface ArchiveRun {
  /** 相对输出根的文件名（posix 分隔符，升序）。 */
  names: string[];
  /** 文件名 → 文件字节（utf8）。 */
  texts: Map<string, string>;
  /** 终端摘要行（stdout 侧）。 */
  lines: string[];
}

/** 跑一次归档输入，返回落盘结果。归档必须成功（退出码 0）。 */
function runArchive(archivePath: string): ArchiveRun {
  const outDir = join(workDir('asu-arch-det-out-'), 'out');
  const result = runParse([archivePath], outDir);
  expect(result.exitCode, result.errorLines.join('\n')).toBe(0);
  const files = loadOutputDir(outDir);
  return {
    names: files.map((file) => file.relPath).sort(),
    texts: new Map(files.map((file) => [file.relPath, file.text])),
    lines: result.lines,
  };
}

/** 同一归档两次运行：文件名集合相同、每个文件字节相同。 */
function expectSameBytesTwice(archivePath: string): ArchiveRun {
  const first = runArchive(archivePath);
  const second = runArchive(archivePath);
  expect(second.names).toEqual(first.names);
  for (const name of first.names) {
    expect(second.texts.get(name), `${name} 两次运行字节不同`).toBe(first.texts.get(name));
  }
  return first;
}

/** 输出文本里不得出现解包临时目录名（mkdtemp 的 `asu-archive-` 前缀）。 */
function assertNoTempDirLeak(run: ArchiveRun): void {
  for (const [name, text] of run.texts) {
    expect(text.includes('asu-archive-'), `${name} 泄漏了解包临时目录名`).toBe(false);
  }
}

/** 读根 span（无 parentSpanId）上某个属性的字符串值。 */
function rootStringAttribute(
  run: ArchiveRun,
  fileName: string,
  key: string,
): string | undefined {
  const text = run.texts.get(fileName);
  expect(text, `缺少输出文件 ${fileName}`).toBeDefined();
  const data = JSON.parse(text as string) as {
    resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: Array<Record<string, unknown>> }> }>;
  };
  const spans =
    data.resourceSpans?.flatMap((resource) => resource.scopeSpans ?? []).flatMap(
      (scope) => scope.spans ?? [],
    ) ?? [];
  const root = spans.find((span) => span['parentSpanId'] === undefined);
  expect(root, `${fileName} 缺少根 span`).toBeDefined();
  const attributes = (root?.['attributes'] ?? []) as Array<{
    key?: string;
    value?: { stringValue?: string };
  }>;
  return attributes.find((attribute) => attribute.key === key)?.value?.stringValue;
}

/** 主会话 + 带 agentId 的子代理（CC 2.1.3xx 形状）。 */
function packedEntries(): TarEntry[] {
  const mainLine = JSON.stringify(
    ccPrompt([{ type: 'text', text: '主会话' }], {
      uuid: 'u1',
      timestamp: ccTimestamp(0),
      extra: { sessionId: 'packed-session' },
    }),
  );
  const sideLine = JSON.stringify(
    ccPrompt([{ type: 'text', text: '子代理' }], {
      uuid: 'u2',
      timestamp: ccTimestamp(1),
      extra: { sessionId: 'packed-session', isSidechain: true, agentId: 'a1' },
    }),
  );
  return [
    { name: 'packed-session.jsonl', content: `${mainLine}\n` },
    { name: 'packed-session/subagents/agent-a1.jsonl', content: `${sideLine}\n` },
    { name: 'packed-session/tool-results/ignored.txt', content: '不是会话' },
  ];
}

/** 长 stem 且无 agentId 的 sidechain：agentLabel 只能由文件名生成（hash 种子易泄漏临时路径）。 */
const LONG_STEM = `agent-${'x'.repeat(60)}`;

function longStemEntries(): TarEntry[] {
  const line = JSON.stringify(
    ccPrompt([{ type: 'text', text: '无 agentId 的子代理' }], {
      uuid: 'u1',
      timestamp: ccTimestamp(0),
      extra: { sessionId: 'long-stem-session', isSidechain: true },
    }),
  );
  return [{ name: `subagents/${LONG_STEM}.jsonl`, content: `${line}\n` }];
}

describe('归档输入确定性（R6）', () => {
  it('.tar.zst：两次运行文件名与字节相同，不泄漏临时目录', () => {
    const work = workDir('asu-arch-det-tarzst-');
    const archivePath = join(work, 'packed.tar.zst');
    writeFileSync(archivePath, buildTarZstd(packedEntries()));

    const run = expectSameBytesTwice(archivePath);
    assertNoTempDirLeak(run);
    expect(run.names).toHaveLength(2);
    expect(run.names.some((name) => name.endsWith('__main.json'))).toBe(true);
    expect(run.names.some((name) => name.includes('sidechain-a1'))).toBe(true);
  });

  it('asu.sessionFile 是逻辑路径：<归档参数>!/<成员相对路径>', () => {
    const work = workDir('asu-arch-det-sessionfile-');
    const archivePath = join(work, 'packed.tar.zst');
    writeFileSync(archivePath, buildTarZstd(packedEntries()));

    const run = runArchive(archivePath);
    const mainFile = run.names.find((name) => name.endsWith('__main.json')) as string;
    const sideFile = run.names.find((name) => name.includes('sidechain-a1')) as string;

    expect(rootStringAttribute(run, mainFile, 'asu.sessionFile')).toBe(
      `${archivePath}!/packed-session.jsonl`,
    );
    expect(rootStringAttribute(run, sideFile, 'asu.sessionFile')).toBe(
      `${archivePath}!/packed-session/subagents/agent-a1.jsonl`,
    );
  });

  it('长 stem + 无 agentId 的 sidechain：两次运行文件名与字节相同', () => {
    const work = workDir('asu-arch-det-longstem-');
    const archivePath = join(work, 'long.tar.zst');
    writeFileSync(archivePath, buildTarZstd(longStemEntries()));

    const run = expectSameBytesTwice(archivePath);
    assertNoTempDirLeak(run);
    expect(run.names).toHaveLength(1);
    // label 必须由文件名生成，且不是被整段裸 stem（长度受 64 字符上限约束）。
    expect(run.names[0]).toContain('sidechain-');
    expect(run.names[0]).not.toContain(LONG_STEM);
  });

  it('.tar.gz 两跑一致', () => {
    const work = workDir('asu-arch-det-targz-');
    const archivePath = join(work, 'packed.tar.gz');
    writeFileSync(archivePath, gzipSync(buildTar(packedEntries())));
    const run = expectSameBytesTwice(archivePath);
    assertNoTempDirLeak(run);
    expect(run.names).toHaveLength(2);
  });

  it('.tgz 两跑一致', () => {
    const work = workDir('asu-arch-det-tgz-');
    const archivePath = join(work, 'packed.tgz');
    writeFileSync(archivePath, gzipSync(buildTar(packedEntries())));
    const run = expectSameBytesTwice(archivePath);
    assertNoTempDirLeak(run);
    expect(run.names).toHaveLength(2);
  });

  it('.tar 两跑一致', () => {
    const work = workDir('asu-arch-det-tar-');
    const archivePath = join(work, 'packed.tar');
    writeFileSync(archivePath, buildTar(packedEntries()));
    const run = expectSameBytesTwice(archivePath);
    assertNoTempDirLeak(run);
    expect(run.names).toHaveLength(2);
  });

  it('目录里发现的归档同样确定性（逻辑归档路径 = 扫描到的条目路径）', () => {
    const work = workDir('asu-arch-det-dir-');
    const archivePath = join(work, 'nested.tar.zst');
    writeFileSync(archivePath, buildTarZstd(packedEntries()));

    const first = runArchive(work);
    const second = runArchive(work);
    expect(second.names).toEqual(first.names);
    for (const name of first.names) {
      expect(second.texts.get(name)).toBe(first.texts.get(name));
    }
    assertNoTempDirLeak(first);
    const mainFile = first.names.find((name) => name.endsWith('__main.json')) as string;
    expect(rootStringAttribute(first, mainFile, 'asu.sessionFile')).toBe(
      `${archivePath}!/packed-session.jsonl`,
    );
  });

  it('终端对账行包含解出数/跳过数/条目总数（R13）', () => {
    const work = workDir('asu-arch-det-report-');
    const archivePath = join(work, 'packed.tar.zst');
    writeFileSync(archivePath, buildTarZstd(packedEntries()));
    const run = runArchive(archivePath);
    expect(run.lines).toContain(
      `[归档] ${archivePath}：解出 2 个 .jsonl，跳过 1 个非会话条目（共 3 条）`,
    );
  });

  it('坏归档的诊断文本用逻辑路径，不含解包临时目录（R7）', () => {
    const work = workDir('asu-arch-det-bad-');
    const archivePath = join(work, 'broken.tar.zst');
    const bytes = buildTarZstd(packedEntries());
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) ^ 0xff;
    writeFileSync(archivePath, bytes);

    const outDir = join(workDir('asu-arch-det-bad-out-'), 'out');
    const result = runParse([archivePath], outDir);
    const text = result.errorLines.join('\n');
    expect(text).toContain(archivePath);
    expect(text).not.toContain('asu-archive-');
  });
});
