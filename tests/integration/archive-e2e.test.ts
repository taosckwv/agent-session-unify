/**
 * 归档输入端到端独立验收（t3）。
 *
 * 与 `archive-determinism.test.ts`（t2 自证）互补：本文件只从 CLI 落盘结果
 * （真实写出的文件字节 + SHA256）与直调 API 的行为断言，不读解析器内部状态；
 * 临时目录刻意建在仓库 `data/`（已 gitignore）下，而不是系统 tmpdir，
 * 这样「输出里不得出现临时目录特征」才有区分度：若解包目录名泄漏，
 * 断言会命中 `asu-archive-` / 系统临时目录 / `AppData\Local\Temp`。
 *
 * 覆盖：
 * 1. 确定性：同一 `.tar.zst`（主会话 + 子代理 + 非 jsonl）两次运行 SHA256 全同；
 *    长 stem 且无 agentId 的 sidechain；递归扫描所有属性字符串与终端行；
 *    归档内 vs 散装落盘（直接解析）的会话数/step/工具数一致。
 * 2. 真实样本 `data/samples`：CC（主+子代理）打 `.tar.zst` 两跑一致、与直接解析一致；
 *    含 DSH `.zstd` 成员的整包（D1：帧内假魔数）可解包且两跑一致。
 * 3. 递归与去重：多层子目录、同名 session 取最高版本、混放 .zstd/.jsonl/.tar.zst；
 *    同一输入经不同参数重复传入只解析一次（D2）。
 * 4. 归档边界：损坏/截断/过短/缺结束块 → 退出码 2 且不写输出；只含非 jsonl；嵌套归档不展开；
 *    路径穿越/绝对路径拒绝；条目数/条目大小/归档大小上限注入。
 * 5. 已知角落：归档内裸 `session.vN`（无会话 id）在 win32 的 sessionId 回退。
 *
 * 缺陷锁定约定：t3 曾用 `it.fails` 锁定 D1/D2；t5 修复后已翻转为 `it`，断言保留。
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { ArchiveExtractionError, extractArchive, isArchivePath } from '../../src/core/archive.js';
import { buildSpans } from '../../src/core/spanBuilder.js';
import { sanitizeFileComponent, serializeTracesData } from '../../src/core/otlp.js';
import { parseDshSession } from '../../src/dsh/parse.js';
import { runParse, type ParseRunResult } from '../../src/index.js';
import { ccPrompt, ccTimestamp } from '../fixtures/cc.js';
import { dshEvent, dshJsonl, dshMainRecords, dshSessionHeader } from '../fixtures/dsh.js';
import { buildTar, buildTarZstd, type TarEntry } from '../fixtures/tar.js';
import {
  listFilesRecursive,
  loadOutputDir,
  removeTempDir,
  rootSpan,
  sha256,
  stringAttribute,
  writeDshSessionFile,
  type OutputFile,
} from './helpers.js';

// ---------------------------------------------------------------------------
// 临时目录（仓库 data/ 下，gitignore；测试结束清理）
// ---------------------------------------------------------------------------

const DATA_ROOT = join(process.cwd(), 'data');
const scratchDirs: string[] = [];

/** 在 data/ 下建一次性目录：解包临时目录若泄漏，会以 `asu-archive-` 命中。 */
function workDir(prefix: string): string {
  mkdirSync(DATA_ROOT, { recursive: true });
  const dir = mkdtempSync(join(DATA_ROOT, prefix));
  scratchDirs.push(dir);
  return dir;
}

/** 新的输出目录（尚不存在；由 runParse 创建）。 */
function outDir(): string {
  return join(workDir('t3-e2e-out-'), 'out');
}

afterAll(() => {
  for (const dir of scratchDirs) removeTempDir(dir);
});

// ---------------------------------------------------------------------------
// CLI 运行与落盘快照
// ---------------------------------------------------------------------------

interface CliRun {
  result: ParseRunResult;
  outDir: string;
  files: OutputFile[];
  /** 相对输出根的文件名（posix，升序）。 */
  names: string[];
  /** 文件名 → 落盘字节的 SHA256（真实文件，不是返回值）。 */
  sha: Map<string, string>;
}

function runCli(paths: readonly string[], targetOutDir: string): CliRun {
  const result = runParse(paths, targetOutDir);
  const files = existsSync(targetOutDir) ? loadOutputDir(targetOutDir) : [];
  const names = files.map((file) => file.relPath).sort();
  const sha = new Map<string, string>();
  for (const file of files) sha.set(file.relPath, sha256(readFileSync(file.absolutePath)));
  return { result, outDir: targetOutDir, files, names, sha };
}

/** 期望成功（退出码 0），失败时把错误行塞进断言消息。 */
function expectOk(run: CliRun): void {
  expect(run.result.exitCode, run.result.errorLines.join('\n')).toBe(0);
}

/** 两次运行：文件名集合相同、逐文件落盘 SHA256 相同。 */
function expectSameBytes(first: CliRun, second: CliRun): void {
  expect(second.names).toEqual(first.names);
  for (const name of first.names) {
    expect(second.sha.get(name), `${name} 两次运行 SHA256 不同`).toBe(first.sha.get(name));
  }
}

/** 期望输入错误（退出码 2）、不写任何输出、诊断用逻辑路径。 */
function expectInputErrorNoOutput(
  paths: readonly string[],
  targetOutDir: string,
  errorPattern: RegExp,
): CliRun {
  const run = runCli(paths, targetOutDir);
  expect(run.result.exitCode, run.result.errorLines.join('\n')).toBe(2);
  expect(existsSync(targetOutDir), '退出码 2 时不应创建输出目录').toBe(false);
  expect(run.result.writtenFiles).toHaveLength(0);
  expect(run.result.sessions).toHaveLength(0);
  const text = run.result.errorLines.join('\n');
  expect(text).toMatch(errorPattern);
  expect(text).not.toContain('asu-archive-');
  return run;
}

// ---------------------------------------------------------------------------
// 临时目录泄漏扫描：递归所有 JSON 字符串值 + 终端行
// ---------------------------------------------------------------------------

const LEAK_NEEDLES = ['asu-archive-', 'appdata\\local\\temp', 'appdata/local/temp', tmpdir()]
  .map((needle) => needle.toLowerCase())
  .filter((needle) => needle !== '');

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) collectStrings(item, out);
  }
  return out;
}

/** 输出里不得出现解包临时目录特征（属性值、错误文本、asu.stats.*、终端行）。 */
function assertNoTempLeak(run: CliRun): void {
  for (const file of run.files) {
    for (const text of collectStrings(file.data)) {
      for (const needle of LEAK_NEEDLES) {
        expect(
          text.toLowerCase().includes(needle),
          `${file.relPath} 泄漏临时目录特征 ${JSON.stringify(needle)}：${text}`,
        ).toBe(false);
      }
    }
  }
  for (const line of [...run.result.lines, ...run.result.errorLines]) {
    for (const needle of LEAK_NEEDLES) {
      expect(line.toLowerCase().includes(needle), `终端行泄漏临时目录特征：${line}`).toBe(false);
    }
  }
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 长 stem 且无 agentId 的 sidechain：agentLabel 的 hash 种子最容易泄漏路径。 */
const LONG_STEM = `agent-${'x'.repeat(60)}`;

function ccLine(text: string, extra: Record<string, unknown>): string {
  const uuid = `u-${Buffer.from(text, 'utf8').toString('hex').slice(0, 12)}`;
  return `${JSON.stringify(
    ccPrompt([{ type: 'text', text }], { uuid, timestamp: ccTimestamp(0), extra }),
  )}\n`;
}

/** 归档内容：主会话 + 带 agentId 子代理 + 无 agentId 长 stem 子代理 + 非 jsonl。 */
function packedEntries(): TarEntry[] {
  return [
    {
      name: 'packed/main-session.jsonl',
      content: ccLine('主会话', { sessionId: 'packed-session' }),
    },
    {
      // 注意：ustar 名段只有 100 字节，成员路径必须压在这之内（否则夹具截断名）。
      name: 'packed/subagents/agent-a1.jsonl',
      content: ccLine('带 agentId 的子代理', {
        sessionId: 'packed-session',
        isSidechain: true,
        agentId: 'a1',
      }),
    },
    {
      name: `packed/subagents/${LONG_STEM}.jsonl`,
      content: ccLine('无 agentId 的子代理', { sessionId: 'packed-session', isSidechain: true }),
    },
    { name: 'packed/tool-results/ignored.bin', content: '不是会话' },
  ];
}

/** 会话身份（不含 agentLabel：label 允许随逻辑路径变化，见 t1 R4）。 */
function sessionKeys(run: CliRun): string[] {
  return run.result.sessions
    .map((s) => `${s.tool}|${s.sessionId}|${s.steps}|${s.tools}|${s.skippedRecords}`)
    .sort();
}

/** 单文件样本集合（真实样本目录；不存在则空）。 */
const SAMPLES_DIR = join(process.cwd(), 'data', 'samples');
const SESSION_EXTENSIONS = new Set(['.jsonl', '.zstd']);
const sampleFiles: string[] = existsSync(SAMPLES_DIR)
  ? listFilesRecursive(SAMPLES_DIR)
      .filter((rel) => SESSION_EXTENSIONS.has(extname(rel)))
      .map((rel) => join(SAMPLES_DIR, rel.split('/').join(sep)))
  : [];
const ccSamples = sampleFiles.filter((abs) => {
  const rel = relative(SAMPLES_DIR, abs).split(sep).join('/');
  return rel.startsWith('cc/') && extname(abs) === '.jsonl';
});
const samplesAvailable = sampleFiles.length > 0;
const ccSamplesAvailable = ccSamples.length > 0;

/** 按原相对路径打包样本（`.tar` 字节，供 .tar/.tar.gz 复用）。 */
function sampleTarEntries(): TarEntry[] {
  return sampleFiles.map((abs) => ({
    name: relative(SAMPLES_DIR, abs).split(sep).join('/'),
    content: readFileSync(abs),
  }));
}

// ---------------------------------------------------------------------------
// 1. 确定性与临时目录泄漏
// ---------------------------------------------------------------------------

describe('确定性（CLI 落盘 SHA256）', () => {
  it('泄漏扫描自检（正控）：植入的 asu-archive- 必须被扫出来', () => {
    // 防「扫描器写坏了 → 空断言通过」：先证明它抓得到。
    const planted = collectStrings({ nested: [{ text: 'x asu-archive-abc y' }] });
    expect(planted.join('\n')).toContain('asu-archive-');
    expect(LEAK_NEEDLES).toContain('asu-archive-');
    const hit = planted.some((text) => text.toLowerCase().includes('asu-archive-'));
    expect(hit).toBe(true);
  });

  it('含主会话/子代理/非 jsonl 的 .tar.zst：两跑文件名与 SHA256 全同，无临时目录特征', () => {
    const work = workDir('t3-e2e-det-');
    const archive = join(work, 'pack.tar.zst');
    writeFileSync(archive, buildTarZstd(packedEntries()));

    const first = runCli([archive], outDir());
    const second = runCli([archive], outDir());

    expectOk(first);
    expectOk(second);
    expectSameBytes(first, second);
    assertNoTempLeak(first);
    // 正控：SHA256 必须真的算出来（防空集合/空字符串让「字节相同」空转）。
    expect(first.sha.size).toBe(first.names.length);
    for (const sha of first.sha.values()) expect(sha).toMatch(/^[0-9a-f]{64}$/);

    // 3 个 .jsonl 会话；非 jsonl 不产出文件。
    expect(first.names).toHaveLength(3);
    expect(first.names.filter((name) => name.endsWith('__main.json'))).toHaveLength(1);
    expect(first.names.filter((name) => name.includes('sidechain-a1'))).toHaveLength(1);

    // 长 stem 且无 agentId：label 由文件名生成（受 64 字符上限约束），两跑稳定。
    const longNames = first.names.filter(
      (name) => name.includes('sidechain-') && !name.includes('__sidechain-a1'),
    );
    expect(longNames).toHaveLength(1);
    expect(longNames[0]).not.toContain(LONG_STEM);

    // R13 对账行。
    expect(first.result.lines).toContain(
      `[归档] ${archive}：解出 3 个 .jsonl，跳过 1 个非会话条目（共 4 条）`,
    );

    // step/工具数与「同样内容散装落盘直接解析」严格相等。
    const looseRoot = workDir('t3-e2e-det-loose-');
    for (const entry of packedEntries()) {
      if (!entry.name.endsWith('.jsonl')) continue;
      const target = join(looseRoot, ...entry.name.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, entry.content as string);
    }
    const direct = runCli([looseRoot], outDir());
    expectOk(direct);
    expect(sessionKeys(first)).toEqual(sessionKeys(direct));
    // 两侧都应有 3 个会话（防夹具写漏导致「空对空」通过）。
    expect(first.result.sessions).toHaveLength(3);
  });

  it('asu.sessionFile 是逻辑路径 <归档参数>!/<成员相对路径>（成员用 "/"）', () => {
    const work = workDir('t3-e2e-sessionfile-');
    const archive = join(work, 'pack.tar.zst');
    writeFileSync(archive, buildTarZstd(packedEntries()));

    const run = runCli([archive], outDir());
    expectOk(run);

    const bySessionFile = new Map<string, OutputFile>();
    for (const file of run.files) {
      bySessionFile.set(stringAttribute(rootSpan(file), 'asu.sessionFile') as string, file);
    }
    expect([...bySessionFile.keys()].sort()).toEqual(
      [
        `${archive}!/packed/main-session.jsonl`,
        `${archive}!/packed/subagents/agent-a1.jsonl`,
        `${archive}!/packed/subagents/${LONG_STEM}.jsonl`,
      ].sort(),
    );
  });

  it('归档参数按调用时原样记录：相对/绝对两次会话身份相同，同参数重复跑字节一致', () => {
    const work = workDir('t3-e2e-relarg-');
    const archive = join(work, 'rel.tar.zst');
    writeFileSync(
      archive,
      buildTarZstd([{ name: 'one.jsonl', content: ccLine('单会话', { sessionId: 'rel-session' }) }]),
    );

    const relArg = relative(process.cwd(), archive);
    const relFirst = runCli([relArg], outDir());
    const relSecond = runCli([relArg], outDir());
    const absRun = runCli([archive], outDir());
    expectOk(relFirst);
    expectOk(absRun);
    expectSameBytes(relFirst, relSecond);

    expect(stringAttribute(rootSpan(relFirst.files[0] as OutputFile), 'asu.sessionFile')).toBe(
      `${relArg}!/one.jsonl`,
    );
    expect(stringAttribute(rootSpan(absRun.files[0] as OutputFile), 'asu.sessionFile')).toBe(
      `${archive}!/one.jsonl`,
    );
    // 同一会话身份（文件名主体相同），但 asu.sessionFile 不同 → 字节不同属预期口径，
    // 不算缺陷：逻辑路径 = 调用时传入的归档参数。
    expect(relFirst.result.sessions[0]?.sessionId).toBe(absRun.result.sessions[0]?.sessionId);
    expect(relFirst.names).toEqual(absRun.names);
    expect(relFirst.sha.get(relFirst.names[0] as string)).not.toBe(
      absRun.sha.get(absRun.names[0] as string),
    );
  });
});

// ---------------------------------------------------------------------------
// 1b. 真进程 CLI（node dist/index.js）
// ---------------------------------------------------------------------------
//
// 进程内 `runParse` 覆盖不到：参数解析、`main` 的退出码映射、stdout/stderr 分流、
// 直接执行守卫（pathToFileURL）。这里只跑构建产物，未 build 或 dist 落后于 src 时跳过。

/** dist/index.js 是否存在且不比 src/*.ts 旧。 */
function distFresh(): boolean {
  const entry = join(process.cwd(), 'dist', 'index.js');
  if (!existsSync(entry)) return false;
  const builtAt = statSync(entry).mtimeMs;
  const pending = [join(process.cwd(), 'src')];
  let newest = 0;
  while (pending.length > 0) {
    const dir = pending.pop() as string;
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, item.name);
      if (item.isDirectory()) {
        pending.push(abs);
        continue;
      }
      if (!item.name.endsWith('.ts')) continue;
      newest = Math.max(newest, statSync(abs).mtimeMs);
    }
  }
  return builtAt >= newest;
}

interface RealRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runRealCli(args: readonly string[]): RealRun {
  const result = spawnSync(process.execPath, [join(process.cwd(), 'dist', 'index.js'), ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  expect(result.error, `真进程启动失败：${result.error?.message ?? ''}`).toBeUndefined();
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('真进程 CLI（node dist/index.js）', () => {
  const fresh = distFresh();

  (fresh ? it : it.skip)(
    '真进程：.tar.zst 两跑落盘字节相同，stdout 对账行「解出 + 跳过 = 共 N」',
    () => {
      const work = workDir('t3-e2e-real-');
      const archive = join(work, 'real.tar.zst');
      writeFileSync(archive, buildTarZstd(packedEntries()));

      const firstOut = join(workDir('t3-e2e-real-out-'), 'out');
      const secondOut = join(workDir('t3-e2e-real-out-'), 'out');
      const first = runRealCli(['parse', archive, '--out', firstOut]);
      const second = runRealCli(['parse', archive, '--out', secondOut]);

      for (const child of [first, second]) {
        expect(child.status, child.stderr).toBe(0);
        expect(child.stderr).toBe('');
        // 逐字对账行：3 解出 + 1 跳过 = 共 4 条（t6 F1 口径），不接受「和相等但数错」。
        expect(child.stdout).toContain(
          `[归档] ${archive}：解出 3 个 .jsonl，跳过 1 个非会话条目（共 4 条）`,
        );
        expect(child.stdout).toContain('完成：3 个会话、写入 3 个文件');
        expect(child.stdout.toLowerCase()).not.toContain('asu-archive-');
        expect(child.stdout).not.toContain('AppData');
        expect(child.stderr.toLowerCase()).not.toContain('asu-archive-');
        expect(child.stderr).not.toContain('AppData');
      }

      const accountLine = first.stdout
        .split('\n')
        .find((line) => line.startsWith('[归档] '));
      expect(accountLine).toContain(`[归档] ${archive}：`);
      const counted = /解出 (\d+) 个 \.jsonl，跳过 (\d+) 个非会话条目（共 (\d+) 条）/.exec(
        accountLine ?? '',
      );
      expect(counted, `对账行格式不符：${accountLine ?? '(缺失)'}`).not.toBeNull();
      expect(Number(counted?.[1])).toBe(3);
      expect(Number(counted?.[2])).toBe(1);
      expect(Number(counted?.[3])).toBe(4);
      expect(Number(counted?.[1]) + Number(counted?.[2])).toBe(Number(counted?.[3]));

      // 落盘字节：两次运行文件名集合与 SHA256 全同，且不含临时目录特征。
      const firstNameList = listFilesRecursive(firstOut).sort();
      expect(listFilesRecursive(secondOut).sort()).toEqual(firstNameList);
      expect(firstNameList).toHaveLength(3);
      for (const rel of firstNameList) {
        const abs = (root: string): string => join(root, rel.split('/').join(sep));
        expect(sha256(readFileSync(abs(secondOut))), `${rel} 真进程两跑 SHA256 不同`).toBe(
          sha256(readFileSync(abs(firstOut))),
        );
      }
      expect(first.stdout).not.toContain('asu-archive-');
      expect(first.stdout).not.toContain('AppData');
    },
  );

  (fresh ? it : it.skip)(
    '真进程：损坏归档退出码 2、stderr 带逻辑路径、不创建输出目录',
    () => {
      const work = workDir('t3-e2e-real-bad-');
      const broken = join(work, 'broken.tar.zst');
      writeFileSync(broken, Buffer.from('definitely not a zstd frame'));
      const targetOutDir = join(workDir('t3-e2e-real-bad-out-'), 'out');

      const run = runRealCli(['parse', broken, '--out', targetOutDir]);
      expect(run.status).toBe(2);
      expect(run.stdout).toContain('完成：0 个会话、写入 0 个文件');
      expect(run.stdout).toContain(`[归档] ${broken}：解包失败`);
      expect(run.stderr).toContain('[输入错误]');
      expect(run.stderr).toContain(broken);
      expect(run.stdout.toLowerCase()).not.toContain('asu-archive-');
      expect(run.stderr.toLowerCase()).not.toContain('asu-archive-');
      expect(run.stderr).not.toContain('AppData');
      expect(existsSync(targetOutDir), '退出码 2 时不应创建输出目录').toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// 2. 真实样本
// ---------------------------------------------------------------------------

describe('真实样本（data/samples）', () => {
  (ccSamplesAvailable ? it : it.skip)(
    'CC 主+子代理打成 .tar.zst：两跑 SHA256 相同，会话数/step/工具数与直接解析一致',
    () => {
      const work = workDir('t3-e2e-ccsamples-');
      const archive = join(work, 'cc-samples.tar.zst');
      const tarEntries = sampleTarEntries().filter((entry) => entry.name.endsWith('.jsonl'));
      expect(tarEntries.length).toBe(ccSamples.length);
      writeFileSync(archive, buildTarZstd(tarEntries));

      const first = runCli([archive], outDir());
      const second = runCli([archive], outDir());
      expectOk(first);
      expectSameBytes(first, second);
      assertNoTempLeak(first);

      // 归档内 vs 直接解析（原样本路径，不打成包）。
      const direct = runCli(ccSamples, outDir());
      expectOk(direct);
      expect(sessionKeys(first)).toEqual(sessionKeys(direct));
      expect(first.result.sessions).toHaveLength(ccSamples.length);
      // 真实 CC 样本主会话与子代理都有 step 与工具（防夹具空转）。
      for (const session of first.result.sessions) {
        expect(session.steps).toBeGreaterThan(0);
        expect(session.tools).toBeGreaterThan(0);
        expect(session.parseErrors).toBe(0);
      }
      expect(first.result.lines).toContain(
        `[归档] ${archive}：解出 ${ccSamples.length} 个 .jsonl，跳过 0 个非会话条目（共 ${ccSamples.length} 条）`,
      );
    },
  );

  /**
   * 真实样本整包 `.tar.zst`（t3 D1 回归）。
   *
   * 历史根因：`src/core/zstd.ts` 的 `decodeZstdFrameBytes` 只尝试
   * `maxFrameEndCandidates`（=4）个候选帧尾，而本包的 zstd 帧内含预压缩的
   * DSH `.zstd` 成员，原始 literal 里出现 8 个帧魔数（`findFrameStarts` 实测
   * 8 个），真帧尾 `bytes.length` 永远轮不到，于是按假边界切帧 →
   * `failedFrames=1` → CLI 退出码 2、0 会话。
   *
   * 修复：快路径未命中时用 `bytes.length` 证明帧完好，再在剩余魔数候选 + 文件
   * 末尾中二分最小可解右界，得到精确帧尾（见 src/core/zstd.ts）。本用例锁定：
   * 退出码 0、2 个 CC 会话、DSH `.zstd` 成员计入非会话条目、两跑 SHA256 相同。
   */
  (samplesAvailable ? it : it.skip)(
    'D1：真实样本 .tar.zst（含 DSH .zstd 成员）应可解包，且两跑 SHA256 相同',
    () => {
      const work = workDir('t3-e2e-samples-zst-');
      const archive = join(work, 'samples.tar.zst');
      writeFileSync(archive, buildTarZstd(sampleTarEntries()));

      const first = runCli([archive], outDir());
      expect(first.result.exitCode, first.result.errorLines.join('\n')).toBe(0);
      expect(first.result.errorLines).toEqual([]);
      expect(first.result.sessions).toHaveLength(2);
      expect(first.result.sessions.every((s) => s.tool === 'claude-code')).toBe(true);
      expect(first.result.lines).toContain(
        `[归档] ${archive}：解出 2 个 .jsonl，跳过 ${sampleFiles.length - 2} 个非会话条目（共 ${sampleFiles.length} 条）`,
      );

      // 同一归档、同参数两跑：文件名集合与逐文件 SHA256 必须完全一致。
      const second = runCli([archive], outDir());
      expectOk(second);
      expectSameBytes(first, second);
      assertNoTempLeak(first);
    },
  );

  (samplesAvailable ? it : it.skip)(
    '同一内容 .tar.gz：可解包（D1 对照）；DSH .zstd 成员按非会话条目跳过（范围限制）',
    () => {
      const work = workDir('t3-e2e-samples-gz-');
      const archive = join(work, 'samples.tar.gz');
      writeFileSync(archive, gzipSync(buildTar(sampleTarEntries())));

      const first = runCli([archive], outDir());
      expectOk(first);
      expectSameBytes(first, runCli([archive], outDir()));
      assertNoTempLeak(first);

      // 归档只展开 .jsonl（t1 R17 范围）：CC 2 个会话；DSH .zstd 不展开。
      expect(first.result.sessions).toHaveLength(2);
      expect(first.result.sessions.every((s) => s.tool === 'claude-code')).toBe(true);
      expect(first.result.lines).toContain(
        `[归档] ${archive}：解出 2 个 .jsonl，跳过 ${sampleFiles.length - 2} 个非会话条目（共 ${sampleFiles.length} 条）`,
      );

      // 同一批样本直接解析应得到全部 5 个会话 → 归档路径的 DSH 缺口是范围限制，不是计数错。
      const direct = runCli(sampleFiles, outDir());
      expectOk(direct);
      expect(direct.result.sessions.length).toBe(sampleFiles.length);
      const archivedIds = new Set(first.result.sessions.map((s) => `${s.tool}|${s.sessionId}`));
      for (const key of archivedIds) {
        expect(
          direct.result.sessions.map((s) => `${s.tool}|${s.sessionId}`),
          '归档会话必须能在直接解析里找到同身份会话',
        ).toContain(key);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// 3. 递归、去重与版本选择
// ---------------------------------------------------------------------------

describe('递归、去重与版本选择', () => {
  it('多层子目录 + 混放 .zstd/.jsonl/.tar.zst：递归发现、同名 session 取最高版本', () => {
    const work = workDir('t3-e2e-mixed-');
    const alphaDir = join(work, 'alpha');
    const betaDir = join(work, 'beta');
    const ccDir = join(work, 'cc');
    const packedDir = join(work, 'packed');
    for (const dir of [alphaDir, betaDir, ccDir, packedDir]) mkdirSync(dir, { recursive: true });

    // alpha：同目录 v3/v4 同 id → 只应取 v4（v3 丢弃但计入 skippedV3 统计）。
    writeDshSessionFile(
      alphaDir,
      [dshJsonl([dshSessionHeader({ id: 'alpha-session', version: 3 }), dshEvent('turn.start')])],
      'session.v3.jsonl.zstd',
    );
    const alphaV4 = dshMainRecords();
    alphaV4[0] = { ...(alphaV4[0] as Record<string, unknown>), id: 'alpha-session' };
    writeDshSessionFile(alphaDir, [dshJsonl(alphaV4)], 'session.v4.jsonl.zstd');

    // beta：另一个目录同样 v3/v4 混放、同 id → 各自目录独立取最高版本（不互相合并）。
    writeDshSessionFile(
      betaDir,
      [dshJsonl([dshSessionHeader({ id: 'beta-session', version: 3 }), dshEvent('turn.start')])],
      'session.v3.jsonl.zstd',
    );
    writeDshSessionFile(
      betaDir,
      [
        dshJsonl([
          dshSessionHeader({ id: 'beta-session' }),
          dshEvent('turn.start', { seq: 1, offsetMs: 0 }),
        ]),
      ],
      'session.v4.jsonl.zstd',
    );

    writeFileSync(
      join(ccDir, 'mix-cc.jsonl'),
      ccLine('混放目录里的 CC 会话', { sessionId: 'mix-cc' }),
    );
    writeFileSync(
      join(packedDir, 'inner.tar.zst'),
      buildTarZstd([
        {
          name: 'deep/a/b/c/member.jsonl',
          content: ccLine('多层目录成员', { sessionId: 'deep-member' }),
        },
      ]),
    );

    const first = runCli([work], outDir());
    const second = runCli([work], outDir());
    expectOk(first);
    expectSameBytes(first, second);
    assertNoTempLeak(first);

    expect(first.names.sort()).toEqual(
      [
        'claude-code/deep-member__main.json',
        'claude-code/mix-cc__main.json',
        'dsh/alpha-session__main.json',
        'dsh/beta-session__main.json',
      ].sort(),
    );
    const alpha = first.result.sessions.find((s) => s.sessionId === 'alpha-session');
    expect(alpha, '同名 session 只应出现一次').toBeDefined();
    expect(alpha?.skippedV3).toBe(0);
    const beta = first.result.sessions.find((s) => s.sessionId === 'beta-session');
    expect(beta, '不同目录的同名 session 各自成树').toBeDefined();
    expect(beta?.skippedV3).toBe(0);

    // 目录里发现的归档：逻辑路径 = 扫描到的条目路径（绝对路径），成员多层用 "/"。
    const member = first.files.find((file) => file.relPath.includes('deep-member')) as OutputFile;
    expect(stringAttribute(rootSpan(member), 'asu.sessionFile')).toBe(
      `${join(packedDir, 'inner.tar.zst')}!/deep/a/b/c/member.jsonl`,
    );
  });

  it('不同目录同名 session（同 id）各取最高版本，最终按 (sessionId, seq) 合并为一棵树', () => {
    const work = workDir('t7-e2e-sameid-');
    const alphaDir = join(work, 'alpha');
    const betaDir = join(work, 'beta');
    mkdirSync(alphaDir, { recursive: true });
    mkdirSync(betaDir, { recursive: true });

    // 两个目录各自 v3+v4、同 id：只有「目录内取 v4」之后再合并，才不会退化成 v3。
    for (const dir of [alphaDir, betaDir]) {
      writeDshSessionFile(
        dir,
        [
          dshJsonl([
            dshSessionHeader({ id: 'shared-session', version: 3 }),
            dshEvent('turn.start'),
          ]),
        ],
        'session.v3.jsonl.zstd',
      );
      const v4 = dshMainRecords();
      v4[0] = { ...(v4[0] as Record<string, unknown>), id: 'shared-session' };
      writeDshSessionFile(dir, [dshJsonl(v4)], 'session.v4.jsonl.zstd');
    }

    const first = runCli([work], outDir());
    const second = runCli([work], outDir());
    expectOk(first);
    expectSameBytes(first, second);

    // v4 的判别特征（实测）：steps=1、tools=1、skippedV3=0；v3 会是 steps=0、tools=0、skippedV3=1。
    expect(first.result.sessions).toHaveLength(1);
    const merged = first.result.sessions[0];
    expect(merged?.sessionId).toBe('shared-session');
    expect(merged?.steps).toBe(1);
    expect(merged?.tools).toBe(1);
    expect(merged?.skippedV3).toBe(0);
    // 合并后只写一个文件，不应因「同 id 两目录」撞出 `-2`。
    expect(first.names).toEqual(['dsh/shared-session__main.json']);
  });

  /**
   * 重复输入去重（t3 D2 回归）。
   *
   * 历史根因：`runParse` 对每个参数独立 `dispatchInput`，`uniqueFiles` 只在单个
   * 分派组内去重；同一文件/归档/目录传两次就会解析两次（归档还会重复解包，
   * 物理临时文件不同），输出出现 `-2` 文件，统计翻倍。
   *
   * 修复：入口按 realpath 全局去重参数；归档用共享 seen 集合只解一次；文件跨组
   * 用共享 seen 集合只解析一次（src/index.ts）。本用例锁定会话数 1/2/1、
   * 无 `-2` 后缀、归档对账行只出现一次。
   */
  it('D2：同一文件/归档/目录经不同参数重复传入只解析一次', () => {
    const work = workDir('t3-e2e-dedupe-');
    const sessionFile = join(work, 'dup.jsonl');
    writeFileSync(sessionFile, ccLine('去重会话', { sessionId: 'dup-session' }));
    const archive = join(work, 'dup.tar.zst');
    writeFileSync(
      archive,
      buildTarZstd([
        { name: 'a.jsonl', content: ccLine('归档会话 A', { sessionId: 'dup-a' }) },
        { name: 'b.jsonl', content: ccLine('归档会话 B', { sessionId: 'dup-b' }) },
      ]),
    );
    const singleDir = join(work, 'single');
    mkdirSync(singleDir, { recursive: true });
    writeFileSync(join(singleDir, 'only.jsonl'), ccLine('目录会话', { sessionId: 'dup-only' }));

    const cases: Array<{ label: string; paths: string[]; expected: number }> = [
      { label: '同一文件两次', paths: [sessionFile, sessionFile], expected: 1 },
      { label: '同一归档两次', paths: [archive, archive], expected: 2 },
      { label: '同一目录两次', paths: [singleDir, singleDir], expected: 1 },
    ];
    for (const item of cases) {
      const run = runCli(item.paths, outDir());
      expectOk(run);
      expect(run.result.sessions, item.label).toHaveLength(item.expected);
      expect(run.result.writtenFiles, item.label).toHaveLength(item.expected);
      expect(run.names.filter((name) => /-\d+\.json$/.test(name)), item.label).toEqual([]);
    }

    // 归档只解一次：对账行只出现一次，计数不翻倍。
    const archived = runCli([archive, archive], outDir());
    expect(archived.result.lines.filter((line) => line.startsWith('[归档]'))).toHaveLength(1);
    expect(archived.result.lines).toContain(
      `[归档] ${archive}：解出 2 个 .jsonl，跳过 0 个非会话条目（共 2 条）`,
    );
    // 去重不能静默：跳过了一项重复输入就要在摘要里说（t6 F9）。
    expect(archived.result.lines).toContain('重复输入已跳过 1 项');

    // 混合写法（目录 + 目录里的文件）：跨分派组也要按 realpath 去重。
    const mixed = runCli([singleDir, join(singleDir, 'only.jsonl')], outDir());
    expectOk(mixed);
    expect(mixed.result.sessions).toHaveLength(1);
    expect(mixed.names.filter((name) => /-\d+\.json$/.test(name))).toEqual([]);

    // 反向约束：去重按路径而非内容。同内容两份不同路径必须各解析一次（防过度去重）。
    const twinA = join(work, 'twin-a.jsonl');
    const twinB = join(work, 'twin-b.jsonl');
    const twinBody = ccLine('同内容不同路径', { sessionId: 'twin-session' });
    writeFileSync(twinA, twinBody);
    writeFileSync(twinB, twinBody);
    const twins = runCli([twinA, twinB], outDir());
    expectOk(twins);
    expect(twins.result.sessions, '同内容不同路径不得按内容去重').toHaveLength(2);
    expect(twins.result.sessions.every((session) => session.sessionId === 'twin-session')).toBe(
      true,
    );

    // 重复的坏归档只报一次输入错误，不重复计数。
    const broken = join(work, 'broken.tar.zst');
    writeFileSync(broken, Buffer.from('not a zstd frame'));
    const duplicatedError = runCli([broken, broken], outDir());
    expect(duplicatedError.result.exitCode).toBe(2);
    expect(duplicatedError.result.inputErrorCount).toBe(1);
    expect(
      duplicatedError.result.errorLines.filter((line) => line.includes(broken)),
    ).toHaveLength(1);
  });

  it('嵌套归档不展开：内层 .tar.zst 按非会话条目计数（R12）', () => {
    const work = workDir('t3-e2e-nested-');
    const archive = join(work, 'outer.tar.zst');
    writeFileSync(
      archive,
      buildTarZstd([
        { name: 'outer.jsonl', content: ccLine('外层会话', { sessionId: 'outer-session' }) },
        {
          name: 'nested/inner.tar.zst',
          content: buildTarZstd([
            { name: 'deep.jsonl', content: ccLine('内层会话', { sessionId: 'inner-session' }) },
          ]),
        },
      ]),
    );

    const first = runCli([archive], outDir());
    const second = runCli([archive], outDir());
    expectOk(first);
    expectSameBytes(first, second);

    expect(first.result.sessions.map((s) => s.sessionId)).toEqual(['outer-session']);
    expect(first.names).toHaveLength(1);
    expect(first.result.lines).toContain(
      `[归档] ${archive}：解出 1 个 .jsonl，跳过 1 个非会话条目（共 2 条）`,
    );
  });
});

// ---------------------------------------------------------------------------
// 3.5 归档对账算式与重复输入提示（t6 F1/F9）
// ---------------------------------------------------------------------------

describe('归档对账算式与重复输入提示（t6 F1/F9）', () => {
  it('F1：含目录条目与 PAX 长名头时「解出 + 跳过 = 共 N 条」仍成立', () => {
    const work = workDir('t6-e2e-account-');
    const archive = join(work, 'account.tar.zst');
    // >100 字节的成员名会额外写一个 PAX（x）扩展头；目录条目落 '5' 类型块。
    // 旧口径把两者之一算进「共 N 条」却不算进「跳过」，2+2≠5。
    const paxName = `${'deep/'.repeat(30)}pax.jsonl`;
    writeFileSync(
      archive,
      buildTarZstd([
        { name: 'main.jsonl', content: ccLine('对账主会话', { sessionId: 'account-main' }) },
        { name: 'sub/', type: 'dir' },
        { name: 'notes.txt', content: '不是会话' },
        { name: paxName, content: ccLine('对账长名会话', { sessionId: 'account-pax' }), pax: true },
      ]),
    );

    const run = runCli([archive], outDir());
    expectOk(run);
    expect(
      run.result.sessions.map((session) => session.sessionId).sort(),
      run.result.errorLines.join('\n'),
    ).toEqual(['account-main', 'account-pax']);

    const accountLine = run.result.lines.find((line) => line.startsWith('[归档] '));
    expect(accountLine).toBe(
      `[归档] ${archive}：解出 2 个 .jsonl，跳过 2 个非会话条目（共 4 条）`,
    );
    const counted = /解出 (\d+) 个 \.jsonl，跳过 (\d+) 个非会话条目（共 (\d+) 条）/.exec(
      accountLine ?? '',
    );
    expect(counted).not.toBeNull();
    expect(Number(counted?.[1]) + Number(counted?.[2])).toBe(Number(counted?.[3]));
  });

  it('F9：因重复而跳过的输入项数在终端报出，未发生时不打印', () => {
    const work = workDir('t6-e2e-dupline-');
    const archive = join(work, 'dup.tar.zst');
    writeFileSync(
      archive,
      buildTarZstd([
        { name: 'a.jsonl', content: ccLine('重复提示 A', { sessionId: 'dup-line-a' }) },
        { name: 'b.jsonl', content: ccLine('重复提示 B', { sessionId: 'dup-line-b' }) },
      ]),
    );

    // 只传目录：目录扫描已经找到归档，没有重复项 → 不打这一行。
    const alone = runCli([work], outDir());
    expectOk(alone);
    expect(alone.result.sessions).toHaveLength(2);
    expect(alone.result.lines.some((line) => line.startsWith('重复输入已跳过'))).toBe(false);

    // 目录 + 目录里的归档：归档第二次出现 → 跳过 1 项并报出来。
    const withDuplicate = runCli([work, archive], outDir());
    expectOk(withDuplicate);
    expect(withDuplicate.result.sessions).toHaveLength(2);
    expect(withDuplicate.result.lines).toContain('重复输入已跳过 1 项');
    expect(withDuplicate.result.lines.filter((line) => line.startsWith('[归档] '))).toHaveLength(1);
    expect(withDuplicate.result.lines.filter((line) => line.startsWith('完成：'))).toHaveLength(1);
    const duplicateIndex = withDuplicate.result.lines.indexOf('重复输入已跳过 1 项');
    const doneIndex = withDuplicate.result.lines.findIndex((line) => line.startsWith('完成：'));
    expect(duplicateIndex).toBeLessThan(doneIndex);
  });
});

// ---------------------------------------------------------------------------
// 4. 归档边界与错误退出
// ---------------------------------------------------------------------------

describe('归档边界与错误退出', () => {
  it('损坏/截断/过短归档：退出码 2、不写输出、诊断含逻辑路径', () => {
    const work = workDir('t3-e2e-bad-');
    const oneLine = ccLine('会话', { sessionId: 'bad-session' });
    const tarBytes = buildTar([{ name: 'a.jsonl', content: oneLine }]);
    const zstBytes = buildTarZstd([{ name: 'a.jsonl', content: oneLine }]);

    const cases: Array<{ label: string; fileName: string; bytes: Buffer; pattern: RegExp }> = [
      {
        label: '不是 zstd 的字节',
        fileName: 'garbage.tar.zst',
        bytes: Buffer.from('definitely not a zstd frame'),
        pattern: /zstd 解包失败/,
      },
      {
        label: 'zstd 帧截断',
        fileName: 'half.tar.zst',
        bytes: zstBytes.subarray(0, Math.floor(zstBytes.length / 2)),
        pattern: /zstd 解包失败|tar 记录被截断|tar 头校验和不匹配|tar 内容不足一个块/,
      },
      {
        label: 'tar 条目中间截断',
        fileName: 'cut.tar',
        bytes: tarBytes.subarray(0, Math.min(700, tarBytes.length)),
        pattern: /tar 记录被截断|tar 内容不足一个块|tar 头校验和不匹配/,
      },
      {
        label: 'tar 不足一个块',
        fileName: 'tiny.tar',
        bytes: tarBytes.subarray(0, 100),
        pattern: /tar 内容不足一个块/,
      },
    ];

    for (const item of cases) {
      const archive = join(work, item.fileName);
      writeFileSync(archive, item.bytes);
      const run = expectInputErrorNoOutput([archive], outDir(), item.pattern);
      expect(run.result.errorLines.join('\n'), item.label).toContain(archive);
      expect(run.result.errorLines.join('\n'), item.label).not.toContain('AppData');
    }
  });

  /**
   * t5 D3：tar 结束块校验。
   *
   * 取舍（同时写在 src/core/archive.ts 注释里）：标准 tar（GNU/BSD/Go
   * archive/tar）在最后一个成员后写两个全零块；不写结束块的流式 tar 无法区分
   * 「正常结束」与「恰在成员块边界被截断」，本工具选择严格——缺少零块即判截断，
   * 宁可报错也不静默接受半个归档。
   */
  it('缺少 tar 结束块（恰在成员块边界截断）：判截断、退出码 2、不写输出', () => {
    const work = workDir('t5-e2e-endblock-');
    const oneLine = ccLine('会话', { sessionId: 'endblock-session' });
    const tarBytes = buildTar([{ name: 'a.jsonl', content: oneLine }]);
    // buildTar 固定以两个 512B 零块收尾；去掉它们就是「成员完整、结束块缺失」。
    const withoutEnd = tarBytes.subarray(0, tarBytes.length - 1024);
    expect(withoutEnd.length % 512).toBe(0);
    expect(withoutEnd.equals(tarBytes)).toBe(false);
    const archive = join(work, 'no-end.tar');
    writeFileSync(archive, withoutEnd);

    const run = expectInputErrorNoOutput([archive], outDir(), /tar 缺少结束块/);
    // 解包失败也要能对账：成员已完整解出，但整包被拒绝（临时目录随后清理）。
    expect(run.result.lines).toContain(
      `[归档] ${archive}：解包失败，已解出 1 个 .jsonl，跳过 0 个条目（已读 1 条）`,
    );

    // 直调 API：错误类型与部分统计是稳定契约，供上层对账。
    let caught: unknown;
    try {
      extractArchive(archive, join(work, 'unused'), { displayPath: 'no-end.tar' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ArchiveExtractionError);
    expect((caught as ArchiveExtractionError).partial).toEqual({
      extracted: 1,
      skippedEntries: 0,
      entries: 1,
    });
  });

  it('一个/多个结束块均接受：结束块只用来排除「恰在成员块边界截断」', () => {
    const work = workDir('t7-e2e-endblocks-');
    const oneLine = ccLine('会话', { sessionId: 'endblocks-ok' });
    const tarBytes = buildTar([{ name: 'a.jsonl', content: oneLine }]);
    const shapes: Array<{ name: string; bytes: Buffer; note: string }> = [
      {
        name: 'one-end.tar',
        bytes: tarBytes.subarray(0, tarBytes.length - 512),
        note: 'GNU tar 允许的单个零块',
      },
      {
        name: 'extra-end.tar',
        bytes: Buffer.concat([tarBytes, Buffer.alloc(1024)]),
        note: '两个零块之后还有填充',
      },
    ];

    for (const shape of shapes) {
      const archive = join(work, shape.name);
      writeFileSync(archive, shape.bytes);
      const run = runCli([archive], outDir());
      expect(run.result.exitCode, `${shape.note}：${run.result.errorLines.join('\n')}`).toBe(0);
      expect(run.result.sessions.map((session) => session.sessionId)).toEqual(['endblocks-ok']);
      expect(run.result.lines).toContain(
        `[归档] ${archive}：解出 1 个 .jsonl，跳过 0 个非会话条目（共 1 条）`,
      );
    }
  });

  it('成员记录中间截断仍报「记录被截断」：失败对账行统计为已读 1 条/0 解出', () => {
    const work = workDir('t5-e2e-midcut-');
    const oneLine = ccLine('会话', { sessionId: 'midcut-session' });
    const tarBytes = buildTar([{ name: 'a.jsonl', content: oneLine }]);
    const archive = join(work, 'midcut.tar');
    // 头块 + 5 字节：成员 body 不完整（与「只剩结束块」是两种截断）。
    writeFileSync(archive, tarBytes.subarray(0, 512 + 5));

    const run = expectInputErrorNoOutput([archive], outDir(), /tar 记录被截断/);
    // 头块读到了、成员没解出：这一条既算「已读」也算「跳过」（t6 F1 恒等式）。
    expect(run.result.lines).toContain(
      `[归档] ${archive}：解包失败，已解出 0 个 .jsonl，跳过 1 个条目（已读 1 条）`,
    );
  });

  it('路径穿越/绝对路径条目被拒绝：退出码 2 且不产生任何输出文件', () => {
    const work = workDir('t3-e2e-traversal-');
    const oneLine = ccLine('会话', { sessionId: 'evil-session' });

    const traversalArchive = join(work, 'traversal.tar.zst');
    writeFileSync(
      traversalArchive,
      buildTarZstd([{ name: '../evil.jsonl', content: oneLine }]),
    );
    expectInputErrorNoOutput([traversalArchive], outDir(), /路径不安全（路径穿越）/);

    const absoluteArchive = join(work, 'absolute.tar.zst');
    writeFileSync(
      absoluteArchive,
      buildTarZstd([{ name: '/abs-escape.jsonl', content: oneLine }]),
    );
    expectInputErrorNoOutput([absoluteArchive], outDir(), /路径不安全（绝对路径）/);

    // 被拒绝的条目不得在归档所在的目录树里留下任何文件（防「先落盘再报错」）。
    const strayFiles = existsSync(work) ? listFilesRecursive(work) : [];
    expect(strayFiles.some((rel) => /evil\.jsonl$|abs-escape\.jsonl$/.test(rel))).toBe(false);
  });

  it('只含非 jsonl 条目的归档：退出码 2、不写输出、对账行计数正确', () => {
    const work = workDir('t3-e2e-nonjsonl-');
    const archive = join(work, 'no-sessions.tar.zst');
    writeFileSync(
      archive,
      buildTarZstd([
        { name: 'notes.txt', content: '不是会话' },
        { name: 'blobs/data.bin', content: '也不是会话' },
      ]),
    );

    const run = expectInputErrorNoOutput([archive], outDir(), /归档内没有 \.jsonl 会话文件/);
    expect(run.result.lines).toContain(
      `[归档] ${archive}：解出 0 个 .jsonl，跳过 2 个非会话条目（共 2 条）`,
    );
  });

  it('条目数/条目大小/归档大小上限可注入（extractArchive 直调）', () => {
    const work = workDir('t3-e2e-limits-');
    const oneLine = ccLine('会话', { sessionId: 'limit-session' });
    const manyTar = join(work, 'many.tar');
    writeFileSync(
      manyTar,
      buildTar([
        { name: 'a.jsonl', content: oneLine },
        { name: 'b.jsonl', content: oneLine },
        { name: 'c.jsonl', content: oneLine },
      ]),
    );
    expect(isArchivePath(manyTar)).toBe(true);

    expect(() =>
      extractArchive(manyTar, join(workDir('t3-e2e-limits-e-'), 'dest'), { maxEntries: 2 }),
    ).toThrowError(/条目数超过上限（2）/);

    const bigTar = join(work, 'big.tar');
    writeFileSync(bigTar, buildTar([{ name: 'big.jsonl', content: 'x'.repeat(4096) }]));
    expect(() =>
      extractArchive(bigTar, join(workDir('t3-e2e-limits-s-'), 'dest'), { maxEntryBytes: 128 }),
    ).toThrowError(/归档内文件过大/);

    expect(() =>
      extractArchive(manyTar, join(workDir('t3-e2e-limits-a-'), 'dest'), { maxArchiveBytes: 16 }),
    ).toThrowError(/归档过大/);
  });
});

// ---------------------------------------------------------------------------
// 5. 已知角落：归档内裸 session.vN（无会话 id）
// ---------------------------------------------------------------------------

describe('裸 session.vN（无会话 id）的 sessionId 回退', () => {
  it('回退取逻辑路径的目录名；win32 上根层裸文件得到 `pack.tar.zst!`；输出确定且文件名合法', () => {
    const work = workDir('t3-e2e-bare-');
    const archive = join(work, 'pack.tar.zst');

    // 物理文件：两个不同目录下的裸 session.v4.jsonl.zstd（真实解包后形状）。
    const rootDir = join(work, 'root');
    const memberRoot = join(work, 'member-root');
    const memberDir = join(memberRoot, 'member-dir');
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(memberDir, { recursive: true });
    const headerWithoutId = dshJsonl([
      // 无 header.id：JSON.stringify 会丢掉值为 undefined 的 id 字段。
      dshSessionHeader({ id: undefined }),
      dshEvent('turn.start', { offsetMs: 0 }),
    ]);
    const rootPhysical = writeDshSessionFile(
      rootDir,
      [headerWithoutId],
      'session.v4.jsonl.zstd',
    );
    const memberPhysical = writeDshSessionFile(
      memberDir,
      [headerWithoutId],
      'session.v4.jsonl.zstd',
    );

    const rootTree = parseDshSession({
      physicalPath: rootPhysical,
      logicalPath: `${archive}!/session.v4.jsonl.zstd`,
    });
    const memberTree = parseDshSession({
      physicalPath: memberPhysical,
      logicalPath: `${archive}!/member-dir/session.v4.jsonl.zstd`,
    });

    // 根层：dirname 是 `...\pack.tar.zst!` → basename 带上 `!`（已知限制）。
    expect(rootTree.sessionId).toBe('pack.tar.zst!');
    expect(rootTree.extras['session_id_source']).toBe('filename');
    // 成员目录层：回退到成员目录名（正确形状）。
    expect(memberTree.sessionId).toBe('member-dir');

    // 输出确定（同输入两跑字节相同），且文件名合法、长度可控。
    const rootBytes = serializeTracesData(buildSpans(rootTree));
    expect(serializeTracesData(buildSpans(parseDshSession({
      physicalPath: rootPhysical,
      logicalPath: `${archive}!/session.v4.jsonl.zstd`,
    })))).toBe(rootBytes);

    const rootName = `${sanitizeFileComponent(rootTree.sessionId)}__${rootTree.agentLabel}.json`;
    expect(rootName).toBe('pack.tar.zst___main.json');
    expect(rootName).toMatch(/^[A-Za-z0-9._-]+\.json$/);

    // 撞名风险：不同目录下同名归档（同 basename）的根层裸会话得到同一 sessionId。
    const otherArchive = join(workDir('t3-e2e-bare-other-'), 'pack.tar.zst');
    const otherTree = parseDshSession({
      physicalPath: rootPhysical,
      logicalPath: `${otherArchive}!/session.v4.jsonl.zstd`,
    });
    expect(otherTree.sessionId).toBe(rootTree.sessionId);

    // 该角落当前经 CLI 不可达：归档只展开 .jsonl，裸 .zstd 会话会被当成非会话条目。
    const cliArchive = join(work, 'bare-only.tar.zst');
    writeFileSync(
      cliArchive,
      buildTarZstd([
        { name: 'session.v4.jsonl.zstd', content: Buffer.from([0x28, 0xb5, 0x2f, 0xfd]) },
        { name: 'member-dir/session.v4.jsonl.zstd', content: Buffer.from([0x28, 0xb5, 0x2f, 0xfd]) },
      ]),
    );
    const cliRun = runCli([cliArchive], outDir());
    expect(cliRun.result.exitCode).toBe(2);
    expect(cliRun.result.errorLines.join('\n')).toMatch(/归档内没有 \.jsonl 会话文件/);
    expect(cliRun.result.sessions).toHaveLength(0);
  });
});