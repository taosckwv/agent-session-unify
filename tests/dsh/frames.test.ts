/**
 * dsh/frames.ts 单测（DESIGN §4.3、§9、§10；t1 裁决 R3）。
 *
 * 全部用合成容器：不依赖本机真实会话，也不进仓库（AGENTS「数据纪律」）。
 * 重点验证四条容错纪律：坏帧跳过、撕裂尾帧跳过、单帧输出超限跳过、跨帧行不撕裂。
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_FRAME_END_CANDIDATES,
  DEFAULT_MAX_FRAME_OUTPUT_BYTES,
  decodeZstdFrameBytes,
  decodeZstdFrames,
  findFrameStarts,
  readZstdJsonl,
  ZSTD_FRAME_MAGIC_BYTES,
  ZSTD_FRAME_MAGIC_HEX,
} from '../../src/dsh/frames.js';
import {
  cleanupSessionDirs,
  compressFrames,
  makeSessionDir,
  writeFramesFile,
} from './synthetic.js';

// t6 F7：清理本文件建的临时目录（makeSessionDir 会记录）。
afterAll(cleanupSessionDirs);

/** 假帧头：只有魔数 + 若干无意义字节（解压必然失败）。 */
function bogusFrame(payload: readonly number[] = [0x00, 0x01, 0x02, 0x03]): Buffer {
  return Buffer.from([...ZSTD_FRAME_MAGIC_BYTES, ...payload]);
}

/** 把若干字节串拼成一个 Buffer。 */
function concatBytes(...parts: readonly Uint8Array[]): Buffer {
  return Buffer.concat(parts.map((part) => Buffer.from(part)));
}

describe('常量', () => {
  it('魔数是 28 B5 2F FD，与十六进制常量一致', () => {
    expect(ZSTD_FRAME_MAGIC_BYTES).toEqual([0x28, 0xb5, 0x2f, 0xfd]);
    expect(ZSTD_FRAME_MAGIC_HEX).toBe('28b52ffd');
  });

  it('默认保护参数是正数（防 OOM、防候选右界退化成 O(n²)）', () => {
    expect(DEFAULT_MAX_FRAME_OUTPUT_BYTES).toBeGreaterThan(0);
    expect(DEFAULT_MAX_FRAME_END_CANDIDATES).toBeGreaterThanOrEqual(1);
  });
});

describe('findFrameStarts', () => {
  it('按顺序找出全部魔数偏移（含压缩数据内部的假魔数，由解码器排除）', () => {
    const frame = compressFrames(['a']);
    const bytes = concatBytes(frame, Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), frame);
    const starts = findFrameStarts(bytes);
    expect(starts[0]).toBe(0);
    expect(starts).toHaveLength(3);
    expect(starts[1]).toBe(frame.length);
    expect(starts[2]).toBe(frame.length + 4);
  });

  it('无魔数返回空数组', () => {
    expect(findFrameStarts(Buffer.from('not zstd at all'))).toEqual([]);
  });
});

describe('decodeZstdFrames 正常路径', () => {
  it('多帧输出按顺序拼接成整体文本', () => {
    const result = decodeZstdFrames(compressFrames(['{"a":1}\n', '{"b":2}\n', '{"c":3}\n']));
    expect(result.text).toBe('{"a":1}\n{"b":2}\n{"c":3}\n');
    expect(result.stats).toEqual({ frames: 3, failedFrames: 0 });
  });

  it('单帧可含多行（帧与行不是 1:1）', () => {
    const result = decodeZstdFrames(compressFrames(['l1\nl2\nl3\n']));
    expect(result.text).toBe('l1\nl2\nl3\n');
    expect(result.stats).toEqual({ frames: 1, failedFrames: 0 });
  });

  it('一行跨两帧也不撕裂（R3：先拼全部帧，再按行切）', () => {
    const result = decodeZstdFrames(compressFrames(['hel', 'lo\nworld\n']));
    expect(result.text).toBe('hello\nworld\n');
    expect(result.text.split('\n').filter((line) => line !== '')).toEqual(['hello', 'world']);
  });

  it('跨帧的多字节字符不被撕坏（先拼字节再解码 UTF-8）', () => {
    const text = '会话标题：多帧切分测试\n';
    const bytes = Buffer.from(text, 'utf8');
    // 在 UTF-8 三字节字符中间切开：只要拼接顺序对，解码仍然正确。
    const middle = 8;
    const result = decodeZstdFrames(
      concatBytes(
        compressFrames([bytes.subarray(0, middle)]),
        compressFrames([bytes.subarray(middle)]),
      ),
    );
    expect(result.text).toBe(text);
    expect(result.stats).toEqual({ frames: 2, failedFrames: 0 });
  });

  it('空字节流 → 空文本、零统计', () => {
    expect(decodeZstdFrames(Buffer.alloc(0))).toEqual({
      text: '',
      stats: { frames: 0, failedFrames: 0 },
    });
  });

  it('完全不含魔数的垃圾字节 → 零帧，不抛', () => {
    expect(decodeZstdFrames(Buffer.from('garbage without magic'))).toEqual({
      text: '',
      stats: { frames: 0, failedFrames: 0 },
    });
  });

  it('decodeZstdFrameBytes 返回逐帧原始字节（tar 解包复用，不做 UTF-8 解码）', () => {
    const result = decodeZstdFrameBytes(compressFrames(['abc', 'def']));
    expect(result.stats).toEqual({ frames: 2, failedFrames: 0 });
    expect(result.chunks.map((chunk) => Buffer.from(chunk).toString('utf8'))).toEqual([
      'abc',
      'def',
    ]);
  });
});

describe('decodeZstdFrames 容错（坏帧跳过并计数，绝不抛）', () => {
  it('中间夹一个坏帧：好帧照常解出，坏帧计 failedFrames', () => {
    const good1 = compressFrames(['{"a":1}\n']);
    const good2 = compressFrames(['{"b":2}\n']);
    const bytes = concatBytes(good1, bogusFrame(), good2);
    const result = decodeZstdFrames(bytes);
    expect(result.text).toBe('{"a":1}\n{"b":2}\n');
    expect(result.stats).toEqual({ frames: 2, failedFrames: 1 });
  });

  it('撕裂尾帧：最后一帧只有前半段，跳过并计数，前面的帧不丢', () => {
    const good = compressFrames(['{"a":1}\n']);
    const torn = compressFrames(['{"b":2}\n']).subarray(0, 12);
    const result = decodeZstdFrames(concatBytes(good, torn));
    expect(result.text).toBe('{"a":1}\n');
    expect(result.stats).toEqual({ frames: 1, failedFrames: 1 });
  });

  it('只有撕裂帧的文件 → 空文本 + failedFrames=1（不抛）', () => {
    const torn = compressFrames(['{"a":1}\n']).subarray(0, 10);
    const result = decodeZstdFrames(concatBytes(torn));
    expect(result.text).toBe('');
    expect(result.stats).toEqual({ frames: 0, failedFrames: 1 });
  });

  it('单帧输出超过 maxOutputBytes → 按坏帧跳过（防 OOM），不抛', () => {
    const big = compressFrames([`{"pad":"${'x'.repeat(4096)}"}\n`]);
    const result = decodeZstdFrames(concatBytes(big), { maxFrameOutputBytes: 64 });
    expect(result.text).toBe('');
    expect(result.stats).toEqual({ frames: 0, failedFrames: 1 });
  });

  it('超限只影响该帧：超限帧前后的小帧仍然解出', () => {
    const small1 = compressFrames(['a\n']);
    const big = compressFrames([`${'y'.repeat(4096)}\n`]);
    const small2 = compressFrames(['b\n']);
    const result = decodeZstdFrames(concatBytes(small1, big, small2), {
      maxFrameOutputBytes: 128,
    });
    expect(result.text).toBe('a\nb\n');
    expect(result.stats).toEqual({ frames: 2, failedFrames: 1 });
  });

  it('首帧即为坏帧：后续帧仍被解出', () => {
    const result = decodeZstdFrames(concatBytes(bogusFrame(), compressFrames(['{"a":1}\n'])));
    expect(result.text).toBe('{"a":1}\n');
    expect(result.stats).toEqual({ frames: 1, failedFrames: 1 });
  });

  it('候选右界个数受限（maxFrameEndCandidates=1）时坏帧不再尝试后续候选', () => {
    const good = compressFrames(['a']);
    const bytes = concatBytes(good, bogusFrame([0x01]), bogusFrame([0x02]));
    const result = decodeZstdFrames(bytes, { maxFrameEndCandidates: 1 });
    // 第一帧成功；两个假帧各自只试一个右界，都失败。
    expect(result.stats.frames).toBe(1);
    expect(result.stats.failedFrames).toBe(2);
  });
});

describe('帧尾探测：假魔数多于候选上限时仍取到精确帧尾（t3 D1）', () => {
  /** 压缩数据里恰好出现魔数是常态：这里用 N 个假帧把候选预算彻底耗尽。 */
  function falseMagics(count: number): Buffer {
    return concatBytes(...Array.from({ length: count }, (_, i) => bogusFrame([0x10 + i, 0x20 + i])));
  }

  /** 确定性伪随机字节（LCG）：保证测试离线可复现，且熵足够高。 */
  function pseudoRandomBytes(length: number, seed: number): Buffer {
    const bytes = Buffer.alloc(length);
    let state = seed >>> 0;
    for (let i = 0; i < length; i += 1) {
      state = (state * 1664525 + 1013904223) >>> 0;
      bytes[i] = (state >>> 24) & 0xff;
    }
    return bytes;
  }

  /**
   * 造一个**单个合法 zstd 帧**，其压缩后的字节里夹着 count 个魔数——这正是真实
   * 样本 `.tar.zst` 的形态（tar 里预压缩的 DSH `.zstd` 成员的字面量被 zstd 原样
   * 存放）。旧实现只试 4 个候选右界，真帧尾永远轮不到 → 整帧被判坏。
   */
  function frameHidingMagics(count: number): { frame: Buffer; payload: Buffer } {
    const parts: Buffer[] = [];
    for (let i = 0; i < count; i += 1) {
      parts.push(pseudoRandomBytes(400, 1000 + i));
      parts.push(Buffer.from(ZSTD_FRAME_MAGIC_BYTES));
    }
    const payload = Buffer.concat(parts);
    return { frame: zstdCompressSync(payload), payload };
  }

  it('单帧内夹 7 个假魔数（starts=8 > 候选上限 4）：整帧解出、零坏帧', () => {
    const { frame, payload } = frameHidingMagics(7);
    const starts = findFrameStarts(frame);
    expect(starts.length).toBe(8);
    expect(starts.length).toBeGreaterThan(DEFAULT_MAX_FRAME_END_CANDIDATES);
    expect(starts[0]).toBe(0);

    const result = decodeZstdFrameBytes(frame);
    expect(result.stats).toEqual({ frames: 1, failedFrames: 0 });
    expect(Buffer.from(result.chunks[0]).equals(payload)).toBe(true);
  });

  it('快路径候选全被假魔数占满：真帧尾仍精确，后续真实帧不被吞掉', () => {
    const good1 = compressFrames(['{"a":1}\n']);
    const good2 = compressFrames(['{"b":2}\n']);
    const good3 = compressFrames(['{"c":3}\n']);
    const bytes = concatBytes(good1, falseMagics(6), good2, good3);

    // 起点数 = 3 个真实帧 + 6 个假魔数，远大于默认候选上限（4）。
    const starts = findFrameStarts(bytes);
    expect(starts.length).toBe(9);
    expect(starts.length).toBeGreaterThan(DEFAULT_MAX_FRAME_END_CANDIDATES);

    const result = decodeZstdFrames(bytes);
    // 三帧都解出；6 个夹在帧间的假帧按契约各计一次 failedFrames。
    // 若用 bytes.length 当兜底成功右界，后两帧会被第一帧吞掉（frames=1），本断言即失败。
    expect(result.text).toBe('{"a":1}\n{"b":2}\n{"c":3}\n');
    expect(result.stats).toEqual({ frames: 3, failedFrames: 6 });
    expect(result.text).not.toContain('\uFFFD');
  });

  it('最后一帧的帧尾就是文件末尾：必须能试到 bytes.length', () => {
    const good1 = compressFrames(['第一帧\n']);
    const good2 = compressFrames(['第二帧\n']);
    // 假魔数全部夹在两帧之间：第二个真实帧的起点超出任何固定候选预算。
    const bytes = concatBytes(good1, falseMagics(6), good2);
    expect(findFrameStarts(bytes).length).toBe(8);

    const result = decodeZstdFrameBytes(bytes);
    expect(result.stats).toEqual({ frames: 2, failedFrames: 6 });
    expect(result.chunks.map((chunk) => Buffer.from(chunk).toString('utf8'))).toEqual([
      '第一帧\n',
      '第二帧\n',
    ]);

    // 输出上限仍然逐帧生效（不能因为换了帧尾算法而丢掉 R9 保护）。
    const capped = decodeZstdFrameBytes(bytes, { maxFrameOutputBytes: 4 });
    expect(capped.stats.frames).toBe(0);
    expect(capped.stats.failedFrames).toBe(8);
  });

  it('maxFrameEndCandidates=0（关闭快路径）仍精确，不误用 bytes.length 吞帧', () => {
    const good1 = compressFrames(['one\n']);
    const good2 = compressFrames(['two\n']);
    const bytes = concatBytes(good1, falseMagics(5), good2);

    const result = decodeZstdFrames(bytes, { maxFrameEndCandidates: 0 });
    expect(result.text).toBe('one\ntwo\n');
    expect(result.stats).toEqual({ frames: 2, failedFrames: 5 });
  });

  it('假魔数之后紧跟撕裂帧：好的帧解出、撕裂帧计失败，不崩', () => {
    const good = compressFrames(['ok\n']);
    const torn = compressFrames(['lost\n']).subarray(0, 10);
    const bytes = concatBytes(good, falseMagics(5), torn);

    const result = decodeZstdFrames(bytes);
    expect(result.text).toBe('ok\n');
    expect(result.stats.frames).toBe(1);
    expect(result.stats.failedFrames).toBe(6);
  });
});

describe('readZstdJsonl', () => {
  it('从文件读取并解码（多帧）', () => {
    const dir = makeSessionDir();
    const path = writeFramesFile(dir, 'session.v4.jsonl.zstd', ['{"a":1}\n', '{"b":2}\n']);
    expect(readZstdJsonl(path)).toEqual({
      text: '{"a":1}\n{"b":2}\n',
      stats: { frames: 2, failedFrames: 0 },
    });
  });

  it('空文件 → 空文本、零统计', () => {
    const dir = makeSessionDir();
    const path = join(dir, 'session.v4.jsonl.zstd');
    writeFileSync(path, Buffer.alloc(0));
    expect(readZstdJsonl(path)).toEqual({ text: '', stats: { frames: 0, failedFrames: 0 } });
  });

  it('文件不存在时抛 IO 错误（路径问题是调用方的错，不吞）', () => {
    const dir = makeSessionDir();
    expect(() => readZstdJsonl(join(dir, 'missing.v4.jsonl.zstd'))).toThrow();
  });
});
