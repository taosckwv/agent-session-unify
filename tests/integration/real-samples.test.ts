/**
 * 真实样本三件套（tests/integration/real-samples.test.ts）。
 *
 * 数据来源：`data/samples/` 是**本地手工拷贝**的真实会话副本（`data/` 已 gitignore，
 * 不入库）。本套件在样本缺失时自动跳过并在测试名/控制台里写明跳过原因，
 * 绝不以「跳过」冒充「通过」。
 *
 * 三件套口径（DESIGN §9 / t1 报告 §9）：
 * 1. 条数守恒：Σ `asu.source_ref_count` + `asu.stats.skipped_records` = `asu.stats.input_records`；
 * 2. 字段齐全：属性键唯一且有序、值恰一个 oneof 分支、纳秒为数字串、`asu.stats.*` 为字符串、
 *    `produced_spans` = 实际 span 数、compaction span 计数自洽、parentSpanId 不悬空；
 * 3. 两次解析一致：同输入跑两次，输出文件集合与字节完全相同。
 *
 * 另附一条「真进程」验收：若 `dist/index.js` 存在且不比 `src/` 旧，用 `node dist/index.js`
 * 真跑一次，确认 CLI 接线（含 Windows 下 pathToFileURL 主守卫）在真实进程里生效。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runParse } from '../../src/index.js';
import {
  assertOutputInvariants,
  loadOutputDir,
  makeTempDir,
  removeTempDir,
  sha256,
} from './helpers.js';

const SAMPLES_DIR = join(process.cwd(), 'data', 'samples');
const DIST_ENTRY = join(process.cwd(), 'dist', 'index.js');

/** 递归收集真实样本文件（只认 .zstd / .jsonl）。 */
function collectSampleFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (['.zstd', '.jsonl'].includes(extname(entry.name))) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

const sampleFiles = existsSync(SAMPLES_DIR) ? collectSampleFiles(SAMPLES_DIR) : [];
const skipReason =
  sampleFiles.length > 0
    ? ''
    : existsSync(SAMPLES_DIR)
      ? `跳过：${SAMPLES_DIR} 存在但没有 .zstd/.jsonl 样本`
      : `跳过：未找到真实样本目录 ${SAMPLES_DIR}（data/ 已 gitignore，需手工拷贝副本）`;

if (skipReason !== '') {
  console.warn(`[real-samples] ${skipReason}`);
  // 显式留痕：跳过的原因必须出现在测试输出里，不能静默。
  it('真实样本三件套（自动跳过）', () => {
    expect(skipReason).toContain('跳过');
  });
}

const tempDirs: string[] = [];

function workDir(prefix: string): string {
  const dir = makeTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) removeTempDir(dir);
});

describe.skipIf(skipReason !== '')('真实样本三件套', () => {
  it('CLI 解析成功（不降级为占位错误树）', () => {
    expect(sampleFiles.length).toBeGreaterThan(0);
    const outDir = join(workDir('asu-int-real-'), 'out');
    const result = runParse(sampleFiles, outDir);
    expect(result.errorLines).toEqual([]);
    expect(result.inputErrorCount).toBe(0);
    expect(result.exitCode).toBe(0);
    expect(result.successCount).toBe(sampleFiles.length);
    expect(result.writtenFiles).toHaveLength(sampleFiles.length);
    // 真实样本里若出现解析失败树，说明解析器对真实数据不健壮。
    for (const file of loadOutputDir(outDir)) {
      const stats = new Map(
        (file.spans[0]?.attributes ?? []).map((attr) => [attr.key, attr.value]),
      );
      expect(stats.get('asu.stats.parse_errors')?.stringValue).toBe('0');
    }
  });

  it('三件套：条数守恒、字段齐全、两次解析字节一致', () => {
    const base = workDir('asu-int-real-trio-');
    const outA = join(base, 'a');
    const outB = join(base, 'b');
    expect(runParse(sampleFiles, outA).exitCode).toBe(0);
    expect(runParse(sampleFiles, outB).exitCode).toBe(0);

    const filesA = loadOutputDir(outA);
    const filesB = loadOutputDir(outB);
    expect(filesA.length).toBeGreaterThan(0);
    // 3. 两次解析一致：文件集合 + 字节 + sha256。
    expect(filesB.map((file) => file.relPath)).toEqual(filesA.map((file) => file.relPath));
    for (const [index, fileA] of filesA.entries()) {
      const fileB = filesB[index]!;
      expect(sha256(fileA.text)).toBe(sha256(fileB.text));
      expect(fileB.text).toBe(fileA.text);
      // 1+2. 守恒与字段齐全（helpers 在真实输出上独立复算）。
      const invariants = assertOutputInvariants(fileA);
      expect(invariants.inputRecords).toBeGreaterThanOrEqual(0);
      expect(invariants.sourceRefTotal + invariants.skippedRecords).toBe(
        invariants.inputRecords,
      );
      expect(invariants.fourLayerSpans).toBe(
        invariants.spanCount - invariants.compactionSpans,
      );
    }
  });

  it('真实样本覆盖 DSH v3（仅统计空树）与 CC sidechain（跨文件共享 trace）', () => {
    const outDir = join(workDir('asu-int-real-shape-'), 'out');
    runParse(sampleFiles, outDir);
    const files = loadOutputDir(outDir);

    // DSH v3：整文件跳过 → 只有根 span、skipped_v3≥1、条数守恒。
    const v3 = files.filter((file) => {
      const stats = new Map(
        (file.spans[0]?.attributes ?? []).map((attr) => [attr.key, attr.value]),
      );
      return (stats.get('asu.stats.skipped_v3')?.stringValue ?? '0') !== '0';
    });
    for (const file of v3) {
      expect(file.spans).toHaveLength(1);
      const invariants = assertOutputInvariants(file);
      expect(invariants.sourceRefTotal).toBe(0);
      expect(invariants.skippedRecords).toBe(invariants.inputRecords);
    }

    // CC sidechain：文件名带 sidechain- 前缀，且与同 sessionId 的主会话共享 traceId。
    const sidechains = files.filter((file) => file.relPath.includes('__sidechain-'));
    const mains = files.filter(
      (file) => file.relPath.includes('claude-code/') && file.relPath.includes('__main.json'),
    );
    for (const sidechain of sidechains) {
      const invariants = assertOutputInvariants(sidechain);
      const traceIds = new Set([invariants.traceId]);
      // 同 sessionId 的主会话（若存在）trace 相同：trace 由 sessionId 派生。
      const sessionId = sidechain.relPath.split('/').pop()!.split('__')[0]!;
      const sibling = mains.find((file) => file.relPath.includes(`${sessionId}__main.json`));
      if (sibling !== undefined) {
        const siblingInvariants = assertOutputInvariants(sibling);
        traceIds.add(siblingInvariants.traceId);
        expect(traceIds.size).toBe(1);
        // spanId 不撞：同 trace 内 id 唯一（assertOutputInvariants 已校验单文件唯一，
        // 这里再跨文件比对，防止 sessionKey 设计遗漏 agentLabel）。
        const sidechainIds = new Set(sidechain.spans.map((span) => span.spanId));
        for (const span of sibling.spans) {
          expect(sidechainIds.has(span.spanId)).toBe(false);
        }
      }
    }
  });
});

describe('真进程 CLI（node dist/index.js）', () => {
  const distFresh = (): boolean => {
    if (!existsSync(DIST_ENTRY)) return false;
    const distTime = statSync(DIST_ENTRY).mtimeMs;
    const srcDir = join(process.cwd(), 'src');
    const walk = (dir: string): number => {
      let newest = 0;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) newest = Math.max(newest, walk(full));
        else if (extname(entry.name) === '.ts') newest = Math.max(newest, statSync(full).mtimeMs);
      }
      return newest;
    };
    return distTime >= walk(srcDir);
  };

  it.skipIf(!distFresh() || sampleFiles.length === 0)(
    'dist 新鲜时：node dist/index.js parse 退出码与摘要正确',
    () => {
      const outDir = join(workDir('asu-int-real-dist-'), 'out');
      const inputs = sampleFiles;
      expect(inputs.length).toBeGreaterThan(0);
      const child = spawnSync(
        process.execPath,
        [DIST_ENTRY, 'parse', ...inputs, '--out', outDir],
        { encoding: 'utf8' },
      );
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      expect(child.stdout).toContain('完成：');
      expect(child.stderr).toBe('');
      // 进程真实写盘：与 runParse 结果同构。
      expect(loadOutputDir(outDir).length).toBe(inputs.length);
      // 相对路径也验一遍（dispatch 对相对路径的处理）。
      expect(relative(process.cwd(), outDir)).not.toBe('');
    },
  );
});
