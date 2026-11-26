/**
 * core/archive.ts —— Claude Code 会话归档（.tar.zst 等）解包。
 *
 * 只做一件事：把归档里的 `.jsonl` 会话文件还原到临时目录，交给现有 CLI 扫描。
 * 不引用系统 tar、不引入第三方库；tar 解析只覆盖会话归档会用到的形态：
 * ustar、ustar prefix、PAX `path`、GNU 长名（L），普通文件/目录/链接。
 *
 * 安全纪律（归档可能来自外部）：
 * - 只写 `.jsonl`，其余条目跳过并计数（内层归档也不展开，R12）；
 * - 拒绝绝对路径、盘符、`..`、Windows 非法字符；win32 另拒段尾点/空格与
 *   大小写重复条目（会静默塌缩/覆盖，R11）；
 * - 拒绝符号链接/硬链接/设备文件，绝不把链接目标写出去；
 * - 校验 tar 头校验和，截断/超限/重复条目一律报错，不猜半截；
 * - 先 stat 后读（R10），zstd 解包带单帧与累计双上限（R9）；
 * - 报错文本只用 `displayPath`（默认真实路径），调用方传逻辑路径即可避免把
 *   解包临时目录写进诊断（R7）。
 *
 * 本模块只依赖 core 内部与 node 内置（t1 裁决 R1：dsh 可依赖 core，反向不行）。
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { decodeZstdFrameBytes } from './zstd.js';

/** 支持的归档扩展名（小写比较）。 */
export const ARCHIVE_EXTENSIONS = [
  '.tar.zst',
  '.tar.zstd',
  '.tar.gz',
  '.tgz',
  '.tar',
] as const;

/** 归档输入总大小上限（压缩前/后的字节数都按这个卡）。 */
export const DEFAULT_MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
/** 单个解包文件上限。 */
export const DEFAULT_MAX_ENTRY_BYTES = 256 * 1024 * 1024;
/** tar 头块数上限（含 PAX/GNU 等结构扩展头；内容条目数另见 `entries`）。 */
export const DEFAULT_MAX_ENTRIES = 100_000;
/** 路径层数上限，防止异常深目录。 */
const MAX_PATH_DEPTH = 64;
const BLOCK = 512;

export interface ExtractArchiveOptions {
  maxArchiveBytes?: number;
  maxEntryBytes?: number;
  maxEntries?: number;
  /**
   * 报错里展示的归档路径（默认真实路径）。归档先解到临时目录时，调用方传逻辑
   * 路径，保证诊断文本里不出现临时目录（t1 裁决 R7）。
   */
  displayPath?: string;
}

export interface ExtractArchiveResult {
  /** 已解出的 `.jsonl` 绝对路径，按归档内顺序。 */
  files: string[];
  /** 跳过的条目数（非 jsonl、目录、链接、特殊文件；未解出的条目也计在这里）。 */
  skippedEntries: number;
  /**
   * 归档内「内容条目」总数：普通文件、目录、链接、设备等，**不含** PAX/GNU
   * 结构扩展头（x/g/L/K）。每条内容条目要么解出（进 `files`），要么跳过
   * （进 `skippedEntries`），所以恒有 `files.length + skippedEntries === entries`
   * （t6 F1：终端摘要的「解出 + 跳过 = 共 N 条」按这个口径对账）。
   */
  entries: number;
}

/** 解包失败时已读到的条目统计（终端对账用，t5 D3/R13）。 */
export interface ArchivePartialStats {
  /** 已成功落盘的 `.jsonl` 数。 */
  extracted: number;
  /** 已跳过的条目数。 */
  skippedEntries: number;
  /** 已读到的内容条目数（不含扩展头；= 已解出 + 已跳过）。 */
  entries: number;
}

/**
 * 解包错误：`parseTar` 已经读过部分条目时携带统计，终端据此打印
 * `[归档]` 对账行（解包失败也要能对账，t5）。
 */
export class ArchiveExtractionError extends Error {
  readonly partial: ArchivePartialStats | undefined;

  constructor(message: string, partial?: ArchivePartialStats) {
    super(message);
    this.name = 'ArchiveExtractionError';
    this.partial = partial;
  }
}

/** 按扩展名判断是否归档（`.tar.zst` 优先于 `.zst`，不会误判成 DSH 日志）。 */
export function isArchivePath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return ARCHIVE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * 解包归档到 destDir，只写 `.jsonl`。
 * 归档损坏、路径不安全、超限时抛 Error（消息是中文，调用方转成输入错误）。
 */
export function extractArchive(
  archivePath: string,
  destDir: string,
  options: ExtractArchiveOptions = {},
): ExtractArchiveResult {
  const maxArchiveBytes = options.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES;
  const maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const displayPath = options.displayPath ?? archivePath;

  // 先 stat 再读：超限文件不整份读进内存（R10）。stat 失败按 IO 错误上抛。
  const declaredSize = statSync(archivePath).size;
  if (declaredSize > maxArchiveBytes) {
    throw new Error(
      `归档过大（${declaredSize} 字节，上限 ${maxArchiveBytes}）：${displayPath}`,
    );
  }
  const archiveBytes = readFileSync(archivePath);

  const lower = archivePath.toLowerCase();
  let tarBytes: Uint8Array;
  if (lower.endsWith('.tar')) {
    tarBytes = archiveBytes;
  } else if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    try {
      tarBytes = gunzipSync(archiveBytes, { maxOutputLength: maxArchiveBytes });
    } catch (error) {
      throw new Error(`gzip 解压失败（${displayPath}）：${errorMessage(error)}`);
    }
  } else if (lower.endsWith('.tar.zst') || lower.endsWith('.tar.zstd')) {
    const { chunks, stats } = decodeZstdFrameBytes(archiveBytes, {
      maxFrameOutputBytes: maxArchiveBytes,
      // 累计上限（R9）：多帧各自合规也不能拼出超过归档上限的 tar 流。
      maxTotalOutputBytes: maxArchiveBytes,
    });
    if (stats.failedFrames > 0) {
      throw new Error(
        `zstd 解包失败（${displayPath}）：${stats.failedFrames} 帧无法解压（归档可能损坏或被截断）`,
      );
    }
    if (chunks.length === 0) {
      throw new Error(`zstd 解包失败（${displayPath}）：没有可解压的帧`);
    }
    tarBytes = Buffer.concat(chunks);
  } else {
    throw new Error(`不支持的归档格式：${displayPath}`);
  }

  if (tarBytes.length > maxArchiveBytes) {
    throw new Error(
      `归档解压后过大（${tarBytes.length} 字节，上限 ${maxArchiveBytes}）：${displayPath}`,
    );
  }

  try {
    return parseTar(Buffer.from(tarBytes), destDir, maxEntryBytes, maxEntries);
  } catch (error) {
    const partial = error instanceof ArchiveExtractionError ? error.partial : undefined;
    throw new ArchiveExtractionError(
      `解包失败（${displayPath}）：${errorMessage(error)}`,
      partial,
    );
  }
}

/** 逐块解析 ustar tar，只落地 `.jsonl`。 */
function parseTar(
  data: Buffer,
  destDir: string,
  maxEntryBytes: number,
  maxEntries: number,
): ExtractArchiveResult {
  if (data.length < BLOCK) {
    throw new Error('tar 内容不足一个块');
  }

  const files: string[] = [];
  const seen = new Set<string>();
  let skippedEntries = 0;
  // 对账口径（t6 F1）：`entries` 只数内容条目（文件/目录/链接/设备…），不含
  // PAX/GNU 结构扩展头（x/g/L/K）；每条内容条目要么解出，要么跳过，恒有
  // files.length + skippedEntries === entries。`headerCount` 单独数头块总数，
  // 用来卡 maxEntries（结构头也能撑大循环，不能因为不计数就放过）。
  let entries = 0;
  let headerCount = 0;
  let offset = 0;
  let paxPath: string | undefined;
  let gnuLongName: string | undefined;
  // 结束块：标准 tar（GNU/BSD/Go archive/tar）在最后一个成员后写两个全零块。
  // 流式写入器可能不写结束块，但那样无法区分「正常结束」与「恰在成员块边界被
  // 截断」；本工具选择严格：没有零块就按截断报错，绝不静默接受半个归档
  // （t5 D3）。中段截断仍由 bodyEnd 越界单独报错。
  let sawEndMarker = false;

  try {
    while (offset + BLOCK <= data.length) {
      const header = data.subarray(offset, offset + BLOCK);
      if (isZeroBlock(header)) {
        sawEndMarker = true;
        break;
      }

      headerCount += 1;
      if (headerCount > maxEntries) {
        throw new Error(`tar 条目数超过上限（${maxEntries}）`);
      }

      let size: number;
      let typeFlag: string;
      let bodyStart: number;
      let bodyEnd: number;
      let body: Buffer;
      try {
        const storedChecksum = readNumeric(header, 148, 8);
        verifyChecksum(header, storedChecksum, offset);

        size = readNumeric(header, 124, 12);
        typeFlag = header[156] === undefined ? '\0' : String.fromCharCode(header[156]);
        bodyStart = offset + BLOCK;
        bodyEnd = bodyStart + size;
        if (bodyEnd > data.length) {
          throw new Error(`tar 记录被截断（偏移 ${offset}）`);
        }
        body = data.subarray(bodyStart, bodyEnd);
      } catch (error) {
        // 头字段/记录体读失败的条目也按「一条内容条目、未解出」入账，
        // 解包失败的对账行同样满足 解出 + 跳过 = 已读。
        entries += 1;
        skippedEntries += 1;
        throw error;
      }

      if (typeFlag === 'x') {
        // PAX 扩展头只作用于紧随其后的一个条目。
        paxPath = parsePax(body).get('path') ?? paxPath;
      } else if (typeFlag === 'g') {
        // 全局 PAX 头：本工具用不到，忽略（不改变文件名）。
      } else if (typeFlag === 'L') {
        gnuLongName = cString(body);
      } else if (typeFlag === 'K') {
        // GNU 长链接名：链接条目本身会被跳过，这里只需吃掉内容。
      } else {
        const name = paxPath ?? gnuLongName ?? readName(header);
        paxPath = undefined;
        gnuLongName = undefined;
        // 内容条目：无论最终解出还是跳过都计一条（不含 x/g/L/K 结构头）。
        entries += 1;

        try {
          if (typeFlag === '5' || typeFlag === 'V') {
            // 目录/卷标：目录由文件父路径按需创建，但条目本身要进「跳过」，
            // 否则终端摘要「解出 + 跳过 = 共 N 条」对不上（t6 F1）。
            skippedEntries += 1;
          } else if (typeFlag === '0' || typeFlag === '7' || typeFlag === '\0') {
            if (!name.toLowerCase().endsWith('.jsonl')) {
              skippedEntries += 1;
            } else {
              const parts = safeRelativePath(name);
              const key = seenKey(parts);
              if (seen.has(key)) {
                throw new Error(`归档内重复条目：${key}`);
              }
              seen.add(key);
              if (size > maxEntryBytes) {
                throw new Error(
                  `归档内文件过大（${size} 字节，上限 ${maxEntryBytes}）：${key}`,
                );
              }
              const absolute = join(destDir, ...parts);
              mkdirSync(dirname(absolute), { recursive: true });
              writeFileSync(absolute, body);
              files.push(absolute);
            }
          } else {
            // 符号链接/硬链接/设备/FIFO 等一律跳过，绝不创建。
            skippedEntries += 1;
          }
        } catch (error) {
          // 分类/落盘失败的条目也计入跳过，保持 解出 + 跳过 = 条目总数。
          skippedEntries += 1;
          throw error;
        }
      }

      offset = bodyStart + roundUp(size);
    }
  } catch (error) {
    // 带上已读部分的对账统计，调用方解包失败也能打印 `[归档]` 行（t5）。
    throw new ArchiveExtractionError(errorMessage(error), {
      extracted: files.length,
      skippedEntries,
      entries,
    });
  }

  if (!sawEndMarker) {
    throw new ArchiveExtractionError(
      'tar 缺少结束块（归档可能在成员块边界被截断）',
      { extracted: files.length, skippedEntries, entries },
    );
  }

  return { files, skippedEntries, entries };
}

/**
 * 重复条目的比较键。Windows 文件系统大小写不敏感（`Main.jsonl` 与 `main.jsonl`
 * 会写同一路径、后者静默覆盖前者），所以 win32 下键统一小写；POSIX 保持区分
 * （t1 裁决 R11）。
 */
function seenKey(parts: readonly string[]): string {
  const joined = parts.join('/');
  return process.platform === 'win32' ? joined.toLowerCase() : joined;
}

/** 读 ustar 文件名（含 prefix 字段，仅 ustar 格式使用）。 */
function readName(header: Buffer): string {
  const name = cString(header.subarray(0, 100));
  const magic = header.subarray(257, 263).toString('latin1');
  if (magic !== 'ustar\0') return name;
  const prefix = cString(header.subarray(345, 500));
  return prefix.length === 0 ? name : `${prefix}/${name}`;
}

/** 读 NUL 结尾的字符串。 */
function cString(buffer: Buffer): string {
  const end = buffer.indexOf(0);
  return buffer.toString('utf8', 0, end < 0 ? buffer.length : end);
}

/** 判断一个头块是否全零（归档结束标记）。 */
function isZeroBlock(header: Buffer): boolean {
  for (const byte of header) {
    if (byte !== 0) return false;
  }
  return true;
}

/** tar 头校验和：校验和字段按空格计，接受有符号/无符号两种历史写法。 */
function verifyChecksum(header: Buffer, stored: number, offset: number): void {
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i += 1) {
    const byte = i >= 148 && i < 156 ? 0x20 : (header[i] as number);
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  if (stored !== unsigned && stored !== signed) {
    throw new Error(`tar 头校验和不匹配（偏移 ${offset}）`);
  }
}

/**
 * 读 tar 数字字段：八进制（空格/NUL 结尾），或 GNU base-256（首字节最高位为 1）。
 */
function readNumeric(buffer: Buffer, offset: number, length: number): number {
  const field = buffer.subarray(offset, offset + length);
  const first = field[0] ?? 0;
  if ((first & 0x80) !== 0) {
    let value = 0n;
    for (let i = 0; i < field.length; i += 1) {
      const byte = i === 0 ? (field[i] as number) & 0x7f : (field[i] as number);
      value = value * 256n + BigInt(byte);
    }
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('tar 数字字段超出安全整数范围');
    }
    return Number(value);
  }
  const text = field.toString('ascii').replace(/\0[\s\S]*$/, '').trim();
  if (text.length === 0) return 0;
  if (!/^[0-7]+$/.test(text)) {
    throw new Error(`tar 数字字段不是八进制：${text}`);
  }
  return Number.parseInt(text, 8);
}

/** 解析 PAX 扩展头（`<长度> <键>=<值>\n`）。 */
function parsePax(body: Buffer): Map<string, string> {
  const values = new Map<string, string>();
  let position = 0;
  while (position < body.length) {
    if (body[position] === 0) break; // 尾随 NUL 填充
    const space = body.indexOf(0x20, position);
    if (space < 0) throw new Error('PAX 记录缺少长度分隔符');
    const lengthText = body.toString('ascii', position, space);
    if (!/^\d+$/.test(lengthText)) throw new Error('PAX 记录长度不是数字');
    const length = Number.parseInt(lengthText, 10);
    if (length <= 0 || position + length > body.length) {
      throw new Error('PAX 记录长度越界');
    }
    const record = body.toString('utf8', space + 1, position + length).replace(/\n$/, '');
    const equals = record.indexOf('=');
    if (equals <= 0) throw new Error('PAX 记录缺少键值分隔符');
    values.set(record.slice(0, equals), record.slice(equals + 1));
    position += length;
  }
  return values;
}

/** 档案内路径转安全相对路径段；越界/非法字符直接抛错。 */
function safeRelativePath(raw: string): string[] {
  if (raw.includes('\0')) {
    throw new Error('归档内路径包含 NUL 字符');
  }
  // 反斜杠只在 Windows 上是分隔符；POSIX 上它是合法文件名字符，不能被静默改写
  // （t6 F10：归档里叫 `a\b.jsonl` 的文件在 Linux 上就该原样落盘）。
  const normalized = process.platform === 'win32' ? raw.replace(/\\/g, '/') : raw;
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`归档内路径不安全（绝对路径）：${raw}`);
  }
  const parts: string[] = [];
  for (const part of normalized.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      throw new Error(`归档内路径不安全（路径穿越）：${raw}`);
    }
    if (process.platform === 'win32') {
      if (/[<>:"|?*]/.test(part)) {
        throw new Error(`归档内路径含 Windows 非法字符：${raw}`);
      }
      // Windows 会静默去掉段尾的点与空格（`sub.` → `sub`），可能让两个不同
      // 条目落到同一路径；直接拒绝，不猜归档意图（t1 裁决 R11）。
      if (/[. ]$/.test(part)) {
        throw new Error(`归档内路径以点或空格结尾（Windows 会塌缩）：${raw}`);
      }
      if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(part)) {
        throw new Error(`归档内路径是 Windows 保留名：${raw}`);
      }
    }
    parts.push(part);
  }
  if (parts.length === 0) {
    throw new Error(`归档内路径为空：${raw}`);
  }
  if (parts.length > MAX_PATH_DEPTH) {
    throw new Error(`归档内路径过深（上限 ${MAX_PATH_DEPTH} 层）：${raw}`);
  }
  return parts;
}

/** 512 对齐。 */
function roundUp(size: number): number {
  return Math.ceil(size / BLOCK) * BLOCK;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
