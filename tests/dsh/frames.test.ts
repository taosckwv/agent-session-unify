/**
 * dsh/frames.ts 单测（DESIGN §4.3、§9、§10；t1 裁决 R3）。
 *
 * 全部用合成容器：不依赖本机真实会话，也不进仓库（AGENTS「数据纪律」）。
 * 重点验证四条容错纪律：坏帧跳过、撕裂尾帧跳过、单帧输出超限跳过、跨帧行不撕裂。
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_FRAME_END_CANDIDATES,
  DEFAULT_MAX_FRAME_OUTPUT_BYTES,
  decodeZstdFrames,
  findFrameStarts,
  readZstdJsonl,
  ZSTD_FRAME_MAGIC_BYTES,
  ZSTD_FRAME_MAGIC_HEX,
} from '../../src/dsh/frames.js';
import { compressFrames, makeSessionDir, writeFramesFile } from './synthetic.js';

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
