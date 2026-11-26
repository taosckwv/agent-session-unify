/**
 * dsh/frames.ts —— DSH 多帧 zstd 会话文件的读取壳（DESIGN §4.3、t1 裁决 R1）。
 *
 * 解码本身是格式无关的字节能力，已下沉到 `core/zstd.ts`（core 不得反向依赖
 * dsh，见 DESIGN §4 依赖方向）。本文件只剩 DSH 专属的两件事：
 * - 从路径读文件（IO 错误照常抛，属调用方路径/IO 错误；帧级错误不抛）；
 * - 把 `core/zstd.ts` 的全部解码符号再导出，保持既有 import 与测试零改动。
 *
 * 容器事实与容错纪律见 `core/zstd.ts` 顶部注释。
 */

import { readFileSync } from 'node:fs';
import { decodeZstdFrames, type FrameDecodeOptions, type ZstdJsonlResult } from '../core/zstd.js';

export {
  ZSTD_FRAME_MAGIC_BYTES,
  ZSTD_FRAME_MAGIC_HEX,
  DEFAULT_MAX_FRAME_OUTPUT_BYTES,
  DEFAULT_MAX_FRAME_END_CANDIDATES,
  findFrameStarts,
  decodeZstdFrameBytes,
  decodeZstdFrames,
} from '../core/zstd.js';
export type {
  FrameDecodeStats,
  FrameDecodeOptions,
  ZstdBytesResult,
  ZstdJsonlResult,
} from '../core/zstd.js';

/**
 * 读一个 DSH `.zstd` 会话文件并解出整体 jsonl 文本（读文件失败照常抛，属调用方
 * 路径/IO 错误；帧级错误不抛）。
 */
export function readZstdJsonl(path: string, options: FrameDecodeOptions = {}): ZstdJsonlResult {
  return decodeZstdFrames(readFileSync(path), options);
}
