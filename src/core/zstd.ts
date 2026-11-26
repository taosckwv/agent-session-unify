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
 * - `zlib.zstdDecompressSync` 一次只解**第一帧**，其后的多余字节被忽略。
 * - 帧边界**按帧结构算，不靠「能不能解开」猜**：Decoding 的宽容度随 Node 版本变
 *   （2026-11-26 生产环境 Node 25 实测：截断帧不再抛错，而是静默返回部分文本），
 *   所以「end < 真实帧尾必失败」这条单调性在 Node 25 上不成立；靠它二分会把
 *   截断帧当成完整帧、吞掉半帧数据。现在先按 RFC 8878 解出帧头与块头得到精确
 *   帧尾（`readZstdFrameStructure`），再只解 [帧头, 帧尾) 这一段字节。
 * - 结构解析不出来（未知变体、撕裂尾帧、异常数据）才回退旧启发式：
 *   按魔数候选升序试解，第一个成功的候选就是精确帧尾；快路径最多试
 *   `maxFrameEndCandidates` 个候选，全失败则先用 `bytes.length` 证明当前帧完好，
 *   再在「剩余候选 + 文件末尾」里二分最小可解右界。绝不把 `bytes.length` 当成功
 *   答案直接吞掉后续真实帧。
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

/** zstd 块最大字节数（RFC 8878 §3.1.1.2.2：Block_Size 上限 128 KiB）。 */
const ZSTD_MAX_BLOCK_SIZE = 128 * 1024;

/**
 * 帧结构解析结果（RFC 8878 §3.1）：帧尾是算出来的，不是试出来的。
 * 只要帧本身完整，`end` 就是下一帧的起点，与 Node 版本无关。
 */
export interface ZstdFrameStructure {
  /** 帧尾（不含），即下一帧起点。 */
  end: number;
  /** 帧头字节数（含 4 字节魔数）。 */
  headerBytes: number;
  /** 块个数。 */
  blocks: number;
  /** 帧尾是否带 4 字节内容校验和（xxh64）。 */
  checksum: boolean;
  /** 帧头声明的解压后字节数（未声明则 undefined）。 */
  declaredContentSize: number | undefined;
}

/** 小端无符号整数读取；超出安全整数范围返回 undefined（真实帧不可能这么大）。 */
function readLittleEndian(
  bytes: Uint8Array,
  offset: number,
  size: number,
): number | undefined {
  let value = 0;
  for (let i = size - 1; i >= 0; i -= 1) value = value * 256 + (bytes[offset + i] as number);
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * 帧结构解析的三种结果：算得出帧尾 / 字节不够（截断、撕裂尾帧）/ 结构说不通
 * （保留位、保留块类型、假魔数）。截断必须与「说不通」分开：前者绝不能交给
 * 宽松解码器试解，否则 Node 25 会把半帧冒充成整帧（静默丢数据）。
 */
type FrameStructureParse =
  | { status: 'ok'; structure: ZstdFrameStructure }
  | { status: 'truncated' }
  | { status: 'invalid' };

/**
 * 按 RFC 8878 解析 `start` 处的 zstd 帧结构，求出精确帧尾。
 *
 * 为什么不用「能解开就算完整」：`zstdDecompressSync` 对截断输入的宽容度随 Node
 * 版本变（Node 25 实测静默返回部分文本），「能不能解开」不再是帧完整性的判据。
 * 结构化解析只看字节：魔数 → 帧头描述符（FCS/单段/校验和/字典 ID）→ 块头
 * （3 字节：last/type/size）→ 可选 4 字节校验和，算出来的 end 就是帧尾。
 *
 * 不抛异常（AGENTS：坏帧跳过并计数），由调用方决定怎么计数。
 */
function parseZstdFrameStructure(bytes: Uint8Array, start: number): FrameStructureParse {
  const [m0, m1, m2, m3] = ZSTD_FRAME_MAGIC_BYTES as [number, number, number, number];
  if (start + 4 > bytes.length) return { status: 'truncated' };
  if (
    bytes[start] !== m0 ||
    bytes[start + 1] !== m1 ||
    bytes[start + 2] !== m2 ||
    bytes[start + 3] !== m3
  ) {
    return { status: 'invalid' };
  }
  let p = start + 4;

  // 帧头描述符（FHD）。
  if (p >= bytes.length) return { status: 'truncated' };
  const fhd = bytes[p] as number;
  p += 1;
  const fcsFlag = (fhd >> 6) & 3;
  const singleSegment = ((fhd >> 5) & 1) === 1;
  const checksum = ((fhd >> 2) & 1) === 1;
  const dictIdFlag = fhd & 3;
  if (((fhd >> 4) & 1) === 1) return { status: 'invalid' }; // Unused_bit 必须为 0
  if (((fhd >> 3) & 1) === 1) return { status: 'invalid' }; // Reserved_bit 必须为 0

  // 非单段帧紧跟 1 字节 Window_Descriptor（内容不校验，只占位）。
  if (!singleSegment) {
    if (p >= bytes.length) return { status: 'truncated' };
    p += 1;
  }

  const dictIdSize = dictIdFlag === 0 ? 0 : dictIdFlag === 1 ? 1 : dictIdFlag === 2 ? 2 : 4;
  const fcsSize = fcsFlag === 0 ? (singleSegment ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8;
  if (p + dictIdSize + fcsSize > bytes.length) return { status: 'truncated' };
  p += dictIdSize;

  let declaredContentSize: number | undefined;
  if (fcsSize > 0) {
    const size = readLittleEndian(bytes, p, fcsSize);
    if (size === undefined) return { status: 'invalid' };
    // 2 字节形式是「值 - 256」的偏移编码（RFC 8878 §3.1.1.3.1）。
    declaredContentSize = fcsSize === 2 ? size + 256 : size;
    p += fcsSize;
  }
  const headerBytes = p - start;

  // 块序列：每块 3 字节头（bit0=last，bit1-2=type，bit3+ = size）。
  let blocks = 0;
  for (;;) {
    if (p + 3 > bytes.length) return { status: 'truncated' };
    const header =
      (bytes[p] as number) | ((bytes[p + 1] as number) << 8) | ((bytes[p + 2] as number) << 16);
    p += 3;
    const last = (header & 1) === 1;
    const blockType = (header >> 1) & 3;
    const blockSize = header >>> 3;
    if (blockType === 3) return { status: 'invalid' }; // Reserved block type
    if (blockSize > ZSTD_MAX_BLOCK_SIZE) return { status: 'invalid' };
    blocks += 1;
    const dataBytes = blockType === 1 ? 1 : blockSize; // RLE 块只有 1 字节实际数据
    if (p + dataBytes > bytes.length) return { status: 'truncated' };
    p += dataBytes;
    if (last) break;
  }
  if (checksum) {
    if (p + 4 > bytes.length) return { status: 'truncated' };
    p += 4;
  }
  return {
    status: 'ok',
    structure: { end: p, headerBytes, blocks, checksum, declaredContentSize },
  };
}

/** 对外只回答「完整帧的帧尾」；截断与说不通都返回 undefined（区分见内部类型）。 */
export function readZstdFrameStructure(
  bytes: Uint8Array,
  start: number,
): ZstdFrameStructure | undefined {
  const parsed = parseZstdFrameStructure(bytes, start);
  return parsed.status === 'ok' ? parsed.structure : undefined;
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

    // 首选：按帧结构算精确帧尾，只解 [头, 尾) 这一段。与解码器宽容度无关，
    // 所以截断帧不会被「解出一半文本」冒充成完整帧（Node 25 实测行为）。
    const parsed = parseZstdFrameStructure(bytes, start);
    const structure = parsed.status === 'ok' ? parsed.structure : undefined;
    if (parsed.status === 'truncated') {
      // 结构明确说「字节不够」：计坏帧，绝不回退到试解（宽容解码器会吞半帧）。
      failedFrames += 1;
      k += 1;
      continue;
    }
    if (structure !== undefined && structure.end <= bytes.length) {
      const result = tryDecodeZstdFrame(bytes, start, structure.end, maxFrameOutputBytes);
      if (
        result !== undefined &&
        // 帧头声明了大小就核对：对不上说明这一帧本身不可信（计数跳过，不吞半帧）。
        (structure.declaredContentSize === undefined ||
          result.length === structure.declaredContentSize)
      ) {
        decoded = result;
        end = structure.end;
      }
    }

    // 结构解析出了帧（含「被截断」——end 超出文件）但解不开或声明大小不符：
    // 按坏帧跳过。这一步很关键：不能让 Node 25 的宽松解码器把半帧冒充成整帧。
    if (decoded === undefined && structure !== undefined) {
      failedFrames += 1;
      k += 1;
      continue;
    }

    // 回退路径用的候选预算（快路径与慢路径都要用，故声明在块外）。
    const fastLast = Math.min(k + maxFrameEndCandidates, starts.length - 1);

    if (decoded === undefined) {
      // 回退（仅当结构解析不出来时走到这里）：未知变体/假魔数/结构不完整的帧，
      // 沿用试解启发式。快路径：紧随其后的魔数候选里，第一个能整帧解开的右界
      // 就是精确帧尾（真帧尾之前的假魔数只会切出截断帧而失败）。
      for (let j = k + 1; j <= fastLast; j += 1) {
        const candidate = starts[j] as number;
        const result = tryDecodeZstdFrame(bytes, start, candidate, maxFrameOutputBytes);
        if (result !== undefined) {
          decoded = result;
          end = candidate;
          break;
        }
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
