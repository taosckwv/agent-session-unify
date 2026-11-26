/**
 * core/archive.ts 单测：不依赖系统 tar，用合成容器验证解包与安全边界。
 *
 * 覆盖：ustar 普通/嵌套文件、PAX 长路径、GNU 长名、prefix 字段、多帧 zstd、
 * gzip、符号链接跳过、拒绝路径穿越/绝对路径/坏校验和/截断/超限/重复条目。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ArchiveExtractionError,
  extractArchive,
  isArchivePath,
} from '../../src/core/archive.js';
import {
  buildTar,
  buildTarZstd,
  buildTarZstdMultiFrame,
  type TarEntry,
} from '../fixtures/tar.js';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'asu-archive-test-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** 把归档字节写到临时文件，返回路径。 */
function writeArchive(name: string, bytes: Uint8Array): string {
  const file = join(workDir, name);
  writeFileSync(file, bytes);
  return file;
}

/** 解包到独立的输出目录，返回解包结果。 */
function extract(name: string, bytes: Uint8Array, options?: Parameters<typeof extractArchive>[2]) {
  const archive = writeArchive(name, bytes);
  const out = join(workDir, 'out');
  return { result: extractArchive(archive, out, options), out };
}

const MAIN: TarEntry = { name: 'main.jsonl', content: '{"type":"user"}\n' };
const SUB: TarEntry = { name: 'subagents/agent-1.jsonl', content: '{"type":"assistant"}\n' };

describe('isArchivePath', () => {
  it('识别支持的归档扩展名（大小写不敏感）', () => {
    for (const name of [
      'a.tar.zst',
      'a.TAR.ZST',
      'a.tar.zstd',
      'a.tar.gz',
      'a.tgz',
      'a.tar',
      '/tmp/a.tar.zst',
    ]) {
      expect(isArchivePath(name), name).toBe(true);
    }
  });

  it('不把 DSH 单帧日志和普通 jsonl 当归档', () => {
    for (const name of ['session.v4.jsonl.zstd', 'session.jsonl', 'a.zst', 'a.gz', 'a.zip']) {
      expect(isArchivePath(name), name).toBe(false);
    }
  });
});

describe('extractArchive：正常解包', () => {
  it('还原嵌套目录，只写 .jsonl，非会话文件与符号链接跳过并计数', () => {
    const tar = buildTar([
      MAIN,
      { name: 'subagents/', type: 'dir' },
      SUB,
      { name: 'notes.txt', content: '不该被解出来' },
      { name: 'link.jsonl', type: 'symlink', linkName: 'main.jsonl' },
    ]);
    const { result, out } = extract('pack.tar', tar);

    expect(result.files.slice().sort()).toEqual(
      [join(out, 'main.jsonl'), join(out, 'subagents', 'agent-1.jsonl')].sort(),
    );
    expect(result.skippedEntries).toBe(3);
    // 目录条目也计入「内容条目」总数：解出 + 跳过 = entries（t6 F1）。
    expect(result.files.length + result.skippedEntries).toBe(result.entries);
    expect(result.entries).toBe(5);
    expect(readFileSync(join(out, 'main.jsonl'), 'utf8')).toBe('{"type":"user"}\n');
    expect(readFileSync(join(out, 'subagents', 'agent-1.jsonl'), 'utf8')).toBe(
      '{"type":"assistant"}\n',
    );
    expect(existsSync(join(out, 'notes.txt'))).toBe(false);
    expect(existsSync(join(out, 'link.jsonl'))).toBe(false);
  });

  it('扩展名大写也接受', () => {
    const { result } = extract('pack.tar', buildTar([{ name: 'MAIN.JSONL', content: '{}\n' }]));
    expect(result.files).toHaveLength(1);
  });

  it('PAX 扩展头里的超长路径能还原', () => {
    const name = `${'deep/'.repeat(30)}session.jsonl`;
    const { result, out } = extract(
      'pax.tar',
      buildTar([{ name, content: '{}\n', pax: true }]),
    );
    expect(result.files).toEqual([join(out, ...name.split('/'))]);
  });

  it('GNU 长名头能还原', () => {
    const name = `${'g/'.repeat(60)}session.jsonl`;
    const { result, out } = extract(
      'gnu.tar',
      buildTar([{ name, content: '{}\n', gnuLongName: true }]),
    );
    expect(result.files).toEqual([join(out, ...name.split('/'))]);
  });

  it('ustar prefix 字段里的长目录能还原', () => {
    const name = `${'p'.repeat(70)}/${'q'.repeat(70)}/session.jsonl`;
    const { result, out } = extract(
      'prefix.tar',
      buildTar([{ name, content: '{}\n', prefix: true }]),
    );
    expect(result.files).toEqual([join(out, ...name.split('/'))]);
  });

  it('压缩包内没有 .jsonl 时不报错，返回空清单', () => {
    const { result } = extract('none.tar', buildTar([{ name: 'readme.txt', content: 'x' }]));
    expect(result.files).toEqual([]);
    expect(result.skippedEntries).toBe(1);
  });
});

describe('extractArchive：zstd / gzip 容器', () => {
  it('单帧 .tar.zst', () => {
    const { result, out } = extract('pack.tar.zst', buildTarZstd([MAIN, SUB]));
    expect(result.files.slice().sort()).toEqual(
      [join(out, 'main.jsonl'), join(out, 'subagents', 'agent-1.jsonl')].sort(),
    );
  });

  it('多帧 .tar.zst：逐帧解码后还原完整 tar 流', () => {
    const { result } = extract('multi.tar.zst', buildTarZstdMultiFrame([MAIN, SUB]));
    expect(result.files).toHaveLength(2);
  });

  it('.tgz 走 gunzip', () => {
    const { result } = extract('pack.tgz', gzipSync(buildTar([MAIN])));
    expect(result.files).toHaveLength(1);
  });

  it('坏 zstd 帧整体失败，不解析半截归档', () => {
    const bytes = buildTarZstd([MAIN]);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) ^ 0xff;
    expect(() => extract('bad.tar.zst', bytes)).toThrow(/zstd|解压|帧/);
  });
});

describe('extractArchive：安全边界', () => {
  it('拒绝 ../ 路径穿越', () => {
    expect(() =>
      extract('evil.tar', buildTar([{ name: '../evil.jsonl', content: '{}\n' }])),
    ).toThrow(/不安全|路径/);
  });

  it('拒绝绝对路径', () => {
    expect(() =>
      extract('abs.tar', buildTar([{ name: '/tmp/evil.jsonl', content: '{}\n' }])),
    ).toThrow(/不安全|路径/);
  });

  it('拒绝带盘符的 Windows 路径', () => {
    expect(() =>
      extract('drive.tar', buildTar([{ name: 'C:/evil.jsonl', content: '{}\n' }])),
    ).toThrow(/不安全|路径/);
  });

  it('拒绝坏校验和', () => {
    const tar = buildTar([MAIN]);
    tar[0] = 0x7a; // 改文件名首字节，校验和不再匹配
    expect(() => extract('bad-sum.tar', tar)).toThrow(/校验和/);
  });

  it('拒绝截断的记录体', () => {
    const tar = buildTar([{ name: 'main.jsonl', content: 'x'.repeat(300) }]);
    expect(() => extract('truncated.tar', tar.subarray(0, 512 + 5))).toThrow(/截断|不完整/);
  });

  it('拒绝缺少结束块的归档（恰在成员块边界截断）', () => {
    const tar = buildTar([MAIN]);
    // buildTar 固定写两个 512B 零块；去掉后成员完整但结束块缺失。
    const withoutEnd = tar.subarray(0, tar.length - 1024);
    expect(withoutEnd.length % 512).toBe(0);
    let caught: unknown;
    try {
      extract('no-end.tar', withoutEnd);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ArchiveExtractionError);
    expect((caught as ArchiveExtractionError).message).toMatch(/缺少结束块/);
    // 失败也要留下可对账的部分统计（t5：解包失败仍打印 [归档] 行）。
    expect((caught as ArchiveExtractionError).partial).toEqual({
      extracted: 1,
      skippedEntries: 0,
      entries: 1,
    });
  });

  it('拒绝超过单文件上限的条目', () => {
    expect(() =>
      extract('big.tar', buildTar([{ name: 'main.jsonl', content: '0123456789' }]), {
        maxEntryBytes: 4,
      }),
    ).toThrow(/上限|过大/);
  });

  it('拒绝超过归档总大小上限的输入', () => {
    expect(() =>
      extract('huge.tar', buildTar([MAIN]), { maxArchiveBytes: 4 }),
    ).toThrow(/上限|过大/);
  });

  it('拒绝重复条目（避免后写覆盖先写）', () => {
    expect(() =>
      extract(
        'dup.tar',
        buildTar([
          { name: 'main.jsonl', content: 'a\n' },
          { name: 'main.jsonl', content: 'b\n' },
        ]),
      ),
    ).toThrow(/重复/);
  });

  it.skipIf(process.platform !== 'win32')('win32：以点或空格结尾的路径段会塌缩，直接拒绝', () => {
    // `sub./main.jsonl` 在 Windows 上会落成 `sub/main.jsonl`，与归档内容不符。
    expect(() =>
      extract('dot-end.tar', buildTar([{ name: 'sub./main.jsonl', content: 'x\n' }])),
    ).toThrow(/点或空格结尾|塌缩/);
    expect(() =>
      extract('space-end.tar', buildTar([{ name: 'sub /main.jsonl', content: 'x\n' }])),
    ).toThrow(/点或空格结尾|塌缩/);
  });

  it.skipIf(process.platform !== 'win32')('win32：仅大小写不同的重复条目视为同一路径，拒绝静默覆盖', () => {
    expect(() =>
      extract(
        'case-dup.tar',
        buildTar([
          { name: 'Main.jsonl', content: 'a\n' },
          { name: 'main.jsonl', content: 'b\n' },
        ]),
      ),
    ).toThrow(/重复/);
  });

  it('反斜杠只在 win32 当分隔符，POSIX 上原样保留为文件名字符（t6 F10）', () => {
    const { result, out } = extract(
      'backslash.tar',
      buildTar([{ name: 'dir\\main.jsonl', content: '{}\n' }]),
    );
    if (process.platform === 'win32') {
      expect(result.files).toEqual([join(out, 'dir', 'main.jsonl')]);
    } else {
      // POSIX：`\` 是合法文件名字符，不能被静默改写成目录分隔符。
      expect(result.files).toEqual([join(out, 'dir\\main.jsonl')]);
      expect(existsSync(join(out, 'dir', 'main.jsonl'))).toBe(false);
    }
  });
});

describe('extractArchive：上限与诊断（R7/R9/R13）', () => {
  it('多帧累计输出超过上限时在拼接前抛错（R9）', () => {
    // 每帧约 8KiB 输出、单帧不超上限；两帧累计超过 maxArchiveBytes。
    const big = 'x'.repeat(8 * 1024);
    const bytes = buildTarZstdMultiFrame([
      { name: 'a.jsonl', content: big },
      { name: 'b.jsonl', content: big },
    ]);
    expect(() => extract('total.tar.zst', bytes, { maxArchiveBytes: 12 * 1024 })).toThrow(
      /zstd 解码输出超过上限/,
    );
  });

  it('报错文本使用 displayPath，不泄漏解包临时路径（R7）', () => {
    const bytes = buildTarZstd([MAIN]);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) ^ 0xff;
    const archive = writeArchive('bad.tar.zst', bytes);
    let message = '';
    try {
      extractArchive(archive, join(workDir, 'out'), { displayPath: 'pack.tar.zst' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('pack.tar.zst');
    expect(message).not.toContain(workDir);
  });

  it('返回条目总数，供终端摘要对账（R13）', () => {
    const { result } = extract(
      'count.tar',
      buildTar([MAIN, { name: 'notes.txt', content: 'x' }, SUB]),
    );
    expect(result.entries).toBe(3);
    expect(result.files).toHaveLength(2);
    expect(result.skippedEntries).toBe(1);
  });

  it('目录/PAX/GNU 结构头不对账：解出 + 跳过 = 条目总数（t6 F1）', () => {
    // 旧口径把目录与 PAX/GNU 扩展头都算进 entries，导致终端「解出 + 跳过 ≠ 共 N 条」。
    const paxName = `${'d/'.repeat(60)}pax.jsonl`; // >100 字节 → PAX x 头 + 文件头
    const gnuName = `${'g/'.repeat(60)}gnu.jsonl`; // >100 字节 → GNU L 头 + 文件头
    const { result } = extract(
      'account.tar',
      buildTar([
        MAIN, // 解出
        { name: 'sub/', type: 'dir' }, // 跳过（目录也是内容条目）
        { name: 'notes.txt', content: 'x' }, // 跳过（非 jsonl）
        { name: paxName, content: '{}\n', pax: true }, // 解出（x 头不计条目）
        { name: gnuName, content: '{}\n', gnuLongName: true }, // 解出（L 头不计条目）
      ]),
    );
    expect(result.files).toHaveLength(3);
    expect(result.skippedEntries).toBe(2);
    // 内容条目 5 条；PAX/GNU 结构头不计入（否则这里会是 7）。
    expect(result.entries).toBe(5);
    expect(result.files.length + result.skippedEntries).toBe(result.entries);
  });

  it('内层归档不展开，按非会话条目跳过并计数（R12 反证）', () => {
    // R12 裁决前提：把内层归档条目写进外层归档时它不会落盘——extractArchive 只写
    // `.jsonl`，所以 index 的嵌套展开确实不可达。这里直接锁定该行为。
    const inner = buildTarZstd([MAIN]);
    const { result, out } = extract(
      'nested.tar',
      buildTar([
        MAIN,
        { name: 'inner.tar.zst', content: inner },
      ]),
    );
    expect(result.files).toHaveLength(1);
    expect(result.skippedEntries).toBe(1);
    expect(result.entries).toBe(2);
    expect(existsSync(join(out, 'inner.tar.zst'))).toBe(false);
  });
});
