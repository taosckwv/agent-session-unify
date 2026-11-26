/**
 * DSH 多帧 zstd 容器解码（DESIGN §4.3「dsh/frames.ts」、RESEARCH §5、t1 裁决 R3）。
 *
 * 容器事实（本机实证：617 个会话文件、53046 帧，零解码失败；单帧最大输出 4.83MB）：
 * - 文件是一串独立 zstd 帧首尾相接，每帧以魔数 `28 B5 2F FD` 开头（RFC 8878）；
 * - 帧与行**不是** 1:1：一个帧可含多行，一行也可能跨帧（实测 1358 帧 → 2544 行），
 *   所以必须「全部帧解码后拼接成整体文本，再按 \n 切行」；逐帧切行会把跨帧的行
 *   撕成两半（R3）；
 * - `zlib.zstdDecompressSync` 一次只解**第一帧**，其后的多余字节被忽略。这一特性
 *   正好用来定位帧边界：从当前帧起点向后续魔数候选右界逐个试解，第一个解成功
 *   的右界就是该帧的真实结束位置（帧是紧邻的，真实右界之前不会再出现别的魔数，
 *   所以候选右界集合里第一个成功者必然精确）。
 *
 * 容错纪律（AGENTS.md：坏行/坏帧/撕裂尾帧跳过并计数，不抛异常中断整份文件）：
 * - 解压失败（坏帧、撕裂尾帧、超上限）→ 跳过该帧并计入 `failedFrames`，继续后续帧；
 * - 解压输出上限（`maxOutputLength`）防 OOM，超限按坏帧处理并计数；
 * - 只读原始字节，不主动扫盘、不猜路径（路径全部来自调用方）。
 */

import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

/** zstd 帧魔数：字节序列 28 B5 2F FD（RFC 8878 §3.1.1，小端魔数 0xFD2FB528）。 */
export const ZSTD_FRAME_MAGIC_BYTES: readonly number[] = [0x28, 0xb5, 0x2f, 0xfd];

/** 帧魔数的十六进制可读形式（日志/报错里用）。 */
export const ZSTD_FRAME_MAGIC_HEX = '28b52ffd';

/**
 * 单帧解压输出上限（防 OOM）。默认 256 MiB：实证最大单帧输出 4.83MB，
 * 留 50 倍余量；解析器不为异常文件赌内存（超限按坏帧计数，不中断）。
 */
export const DEFAULT_MAX_FRAME_OUTPUT_BYTES = 256 * 1024 * 1024;

/**
 * 单帧最多尝试的候选右界个数。正常帧第一次就成功；只有「魔数字节串恰好出现在
 * 压缩数据内部」（概率约 2^-32/字节）时才需要往后多试。上限避免坏帧后面还有
 * 成千上万个合法帧时退化成 O(n²) 解压尝试。
 */
export const DEFAULT_MAX_FRAME_END_CANDIDATES = 4;

/** 帧级统计（DESIGN §11：汇入根 span 的 asu.stats.*）。 */
export interface FrameDecodeStats {
  /** 解压成功的帧数。 */
  frames: number;
  /** 解压失败/超限被跳过的帧数（坏帧、撕裂尾帧、假魔数）。 */
  failedFrames: number;
}

/** 解码结果：整体 jsonl 文本 + 帧级统计。 */
export interface ZstdJsonlResult {
  /** 全部成功帧的输出按顺序拼接后的完整文本（未切行、未截断）。 */
  text: string;
  stats: FrameDecodeStats;
}

/** 解码选项（测试注入小上限用；生产用默认值）。 */
export interface FrameDecodeOptions {
  /** 单帧解压输出上限（字节），超限按坏帧跳过。 */
  maxFrameOutputBytes?: number;
  /** 单帧最多尝试的候选右界个数。 */
  maxFrameEndCandidates?: number;
}

/**
 * 找出所有帧魔数的起始偏移（升序）。
 * 只是候选集合：压缩数据内部偶然出现的同名字节串也会入选，由解码器逐个试解排除。
 */
export function findFrameStarts(bytes: Uint8Array): number[] {
  const starts: number[] = [];
  const [m0, m1, m2, m3] = ZSTD_FRAME_MAGIC_BYTES as [number, number, number, number];
  for (let i = 0; i + 4 <= bytes.length; i += 1) {
    if (bytes[i] === m0 && bytes[i + 1] === m1 && bytes[i + 2] === m2 && bytes[i + 3] === m3) {
      starts.push(i);
    }
  }
  return starts;
}

/**
 * 解一段多帧 zstd 字节流：逐帧解压、拼接输出。
 * 坏帧/撕裂尾帧/超限帧跳过并计数，绝不抛异常。
 */
export function decodeZstdFrames(
  bytes: Uint8Array,
  options: FrameDecodeOptions = {},
): ZstdJsonlResult {
  const maxFrameOutputBytes =
    options.maxFrameOutputBytes ?? DEFAULT_MAX_FRAME_OUTPUT_BYTES;
  const maxFrameEndCandidates =
    options.maxFrameEndCandidates ?? DEFAULT_MAX_FRAME_END_CANDIDATES;
  const starts = findFrameStarts(bytes);
  const chunks: Uint8Array[] = [];
  let frames = 0;
  let failedFrames = 0;

  for (let k = 0; k < starts.length; k += 1) {
    const start = starts[k] as number;
    let decoded: Uint8Array | undefined;
    // 候选右界：下一个魔数、再下一个……直到文件末尾。
    const attempts = Math.min(maxFrameEndCandidates, starts.length - k);
    for (let m = 1; m <= attempts; m += 1) {
      const endIndex = k + m;
      const end = endIndex < starts.length ? (starts[endIndex] as number) : bytes.length;
      if (end <= start) continue;
      try {
        decoded = zstdDecompressSync(bytes.subarray(start, end), { maxOutputLength: maxFrameOutputBytes });
        break;
      } catch {
        // 该候选右界切断了帧（或帧本身损坏）：试更远的右界。
      }
    }
    if (decoded === undefined) {
      failedFrames += 1;
      continue;
    }
    frames += 1;
    chunks.push(decoded);
  }

  // 先拼接再解码 UTF-8：跨帧的多字节字符也安全（R3 的同一条理由）。
  const text = chunks.length === 0 ? '' : Buffer.concat(chunks).toString('utf8');
  return { text, stats: { frames, failedFrames } };
}

/**
 * 读一个 DSH `.zstd` 会话文件并解出整体 jsonl 文本（读文件失败照常抛，属调用方
 * 路径/IO 错误；帧级错误不抛）。
 */
export function readZstdJsonl(path: string, options: FrameDecodeOptions = {}): ZstdJsonlResult {
  return decodeZstdFrames(readFileSync(path), options);
}
