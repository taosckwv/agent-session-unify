/**
 * core/zstd.ts —— 格式无关的多帧 zstd 字节解码（DESIGN §4.3、t1 裁决 R1/R9）。
 *
 * 为什么在 core：DSH 会话日志（dsh/frames.ts）与归档（core/archive.ts）都要解
 * 多帧 zstd；解码本身只吃字节、不碰文件系统，属于两条线共用的底层能力。
 * 放在 dsh/ 会让 core → dsh 反向依赖（DESIGN §4 依赖方向只有
 * `dsh/cc → core`、`index → 全部`），所以单点真相放 core，dsh/frames.ts 只做
 * 「读文件 + 再导出」的壳。
 *
 * 容器事实（本机实证：617 个会话文件、53046 帧，零解码失败；单帧最大输出 4.83MB）：
 * - 文件是一串独立 zstd 帧首尾相接，每帧以魔数 `28 B5 2F FD` 开头（RFC 8878）；
 * - 帧与行**不是** 1:1：一个帧可含多行，一行也可能跨帧（实测 1358 帧 → 2544 行），
 *   所以必须「全部帧解码后拼接成整体文本，再按 \n 切行」；逐帧切行会把跨帧的行
 *   撕成两半（R3）；
 * - `zlib.zstdDecompressSync` 一次只解**第一帧**，其后的多余字节被忽略；输入被
 *   截断（不足一整帧）则必然报错。也就是说「以 end 为右界能否解开」对 end 单调：
 *   end < 真实帧尾必失败，end ≥ 真实帧尾必成功且输出的是同一帧。因此真实帧尾 =
 *   能解开的最小右界。
 * - 帧是紧邻的，真实帧尾之前不会再有真帧，于是「按魔数候选升序试解，第一个成功
 *   的候选」就是精确帧尾。但压缩数据内部可能偶然出现魔数（D1 实测整包 .tar.zst
 *   有 7 个假魔数），候选个数不能设成硬上限——否则真帧尾 `bytes.length` 轮不到
 *   （t3 D1）。这里分两步：
 *   1. 快路径：最多试 `maxFrameEndCandidates` 个紧随其后的候选（正常帧 1 次命中）；
 *   2. 慢路径：快路径全失败时，先用 `bytes.length` 证明当前帧完好（多余字节被
 *      忽略），再在「剩余魔数候选 + 文件末尾」中二分最小可解右界，得到精确帧尾。
 *      绝不把 `bytes.length` 当成功答案直接吞掉后续真实帧。
 * - 成功解出一帧后把游标跳到第一个 ≥ 帧尾的魔数位置，帧内假魔数不会重复计入
 *   `failedFrames`。
 *
 * 容错纪律（AGENTS.md：坏行/坏帧/撕裂尾帧跳过并计数，不抛异常中断整份文件）：
 * - 解压失败（坏帧、撕裂尾帧、单帧超上限）→ 跳过该帧并计入 `failedFrames`；
 * - 单帧解压输出上限（`maxOutputLength`）防 OOM，超限按坏帧处理并计数；
 * - 累计输出上限（`maxTotalOutputBytes`，可选）是整段流的保险丝：多帧各自合规
 *   但拼起来仍然过大时，拼接前就抛 RangeError（R9：归档侧按归档体积上限卡）；
 * - 只读原始字节，不主动扫盘、不猜路径（路径全部来自调用方）。
 * - 本模块不 import node:fs：读文件属于调用方（dsh/frames.ts、core/archive.ts）。
 */

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
 * 快路径最多尝试的候选右界个数（不是硬上限）。正常帧第一次就成功；只有
 * 「魔数字节串恰好出现在压缩数据内部」（概率约 2^-32/字节）时才需要往后多试。
 * 快路径失败后有精确回退（见 decodeZstdFrameBytes），所以即使假魔数比这个数多，
 * 帧尾仍能被准确定位，不会把后续真实帧一起吞掉（t3 D1）。
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
  /** 快路径最多尝试的候选右界个数（超过后走精确回退，不是硬上限）。 */
  maxFrameEndCandidates?: number;
  /**
   * 全部成功帧解压输出的累计上限（字节，可选）。
   * 多帧各自合规但总量过大时在拼接前抛 RangeError（不按坏帧吞掉：整段流不可用）。
   * 归档侧传归档体积上限（R9）；DSH 解析器不传，行为不变。
   */
  maxTotalOutputBytes?: number;
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

/** 解码结果：逐帧原始字节 + 帧级统计（tar 解包等二进制场景用）。 */
export interface ZstdBytesResult {
  /** 全部成功帧的解压输出，按容器顺序。 */
  chunks: Uint8Array[];
  stats: FrameDecodeStats;
}

/**
 * 试解 `bytes[start, end)`：成功返回解压输出，失败（截断/坏帧/超限）返回
 * `undefined`。右界性质：end 小于真实帧尾必然失败，end 不小于真实帧尾返回
 * 同一帧的输出（多余字节被 zstd 解码器忽略）。
 */
function tryDecodeZstdFrame(
  bytes: Uint8Array,
  start: number,
  end: number,
  maxOutputLength: number,
): Uint8Array | undefined {
  if (end <= start) return undefined;
  try {
    return zstdDecompressSync(bytes.subarray(start, end), { maxOutputLength });
  } catch {
    return undefined;
  }
}

/**
 * 解一段多帧 zstd 字节流，返回逐帧原始字节（不做 UTF-8 解码）。
 * 坏帧/撕裂尾帧/单帧超限帧跳过并计数；累计输出超过 `maxTotalOutputBytes`
 * 时抛 RangeError（整段流已不可用，调用方按输入错误处理）。
 */
export function decodeZstdFrameBytes(
  bytes: Uint8Array,
  options: FrameDecodeOptions = {},
): ZstdBytesResult {
  const maxFrameOutputBytes =
    options.maxFrameOutputBytes ?? DEFAULT_MAX_FRAME_OUTPUT_BYTES;
  const maxFrameEndCandidates =
    options.maxFrameEndCandidates ?? DEFAULT_MAX_FRAME_END_CANDIDATES;
  const maxTotalOutputBytes = options.maxTotalOutputBytes;
  const starts = findFrameStarts(bytes);
  const chunks: Uint8Array[] = [];
  let frames = 0;
  let failedFrames = 0;
  let totalBytes = 0;

  for (let k = 0; k < starts.length; ) {
    const start = starts[k] as number;
    let decoded: Uint8Array | undefined;
    let end = start;

    // 快路径：紧随其后的魔数候选里，第一个能整帧解开的右界就是精确帧尾
    // （真帧尾之前的假魔数只会切出截断帧而失败）。
    const fastLast = Math.min(k + maxFrameEndCandidates, starts.length - 1);
    for (let j = k + 1; j <= fastLast; j += 1) {
      const candidate = starts[j] as number;
      const result = tryDecodeZstdFrame(bytes, start, candidate, maxFrameOutputBytes);
      if (result !== undefined) {
        decoded = result;
        end = candidate;
        break;
      }
    }

    if (decoded === undefined) {
      // 慢路径：快路径没命中（假魔数比快路径预算多，或这是最后一帧）。
      // 先用文件末尾证明当前帧完好：成功说明 start 处确实是一整帧。
      const whole = tryDecodeZstdFrame(bytes, start, bytes.length, maxFrameOutputBytes);
      if (whole === undefined) {
        // 帧本身损坏/截断/超限：跳过并计数，继续看后面的候选。
        failedFrames += 1;
        k += 1;
        continue;
      }
      decoded = whole;
      // 在「快路径之后的魔数候选 + 文件末尾」里二分最小可解右界。
      // 成功性对右界单调，所以二分结果就是精确帧尾；这样既不会把后续真实帧
      // 吞进本帧，也不会因为候选个数上限而定位失败。
      const candidates: number[] = [];
      for (let j = fastLast + 1; j < starts.length; j += 1) {
        candidates.push(starts[j] as number);
      }
      candidates.push(bytes.length);
      let lo = 0;
      let hi = candidates.length - 1; // 已知成功（bytes.length）
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        const candidate = candidates[mid] as number;
        if (tryDecodeZstdFrame(bytes, start, candidate, maxFrameOutputBytes) !== undefined) {
          hi = mid;
        } else {
          lo = mid + 1;
        }
      }
      end = candidates[hi] as number;
    }

    totalBytes += decoded.length;
    if (maxTotalOutputBytes !== undefined && totalBytes > maxTotalOutputBytes) {
      throw new RangeError(
        `zstd 解码输出超过上限（累计 ${totalBytes} 字节，上限 ${maxTotalOutputBytes}）`,
      );
    }
    frames += 1;
    chunks.push(decoded);

    // 跳到帧尾之后的第一个魔数：帧内部的假魔数按已消费处理，不重复计数。
    let next = k + 1;
    while (next < starts.length && (starts[next] as number) < end) next += 1;
    k = next;
  }

  return { chunks, stats: { frames, failedFrames } };
}

/**
 * 解一段多帧 zstd 字节流：逐帧解压、拼接输出。
 * 坏帧/撕裂尾帧/单帧超限帧跳过并计数；累计上限同 `decodeZstdFrameBytes`。
 */
export function decodeZstdFrames(
  bytes: Uint8Array,
  options: FrameDecodeOptions = {},
): ZstdJsonlResult {
  const { chunks, stats } = decodeZstdFrameBytes(bytes, options);

  // 先拼接再解码 UTF-8：跨帧的多字节字符也安全（R3 的同一条理由）。
  const text = chunks.length === 0 ? '' : Buffer.concat(chunks).toString('utf8');
  return { text, stats };
}
