/**
 * 测试用 tar / tar.zst 容器工厂（合成数据，不入库真实会话）。
 *
 * 只实现本仓库要覆盖的几种 tar 形态：ustar 前缀字段、PAX 扩展头（path）、
 * GNU 长名头（L）、普通文件、目录、符号链接。用来验证 `core/archive.ts`
 * 的解包安全与兼容性，不试图做通用打包器。
 */

import { zstdCompressSync } from 'node:zlib';

/** tar 块大小（POSIX ustar）。 */
const BLOCK = 512;

export interface TarEntry {
  /** 归档内路径（POSIX 分隔符）。 */
  name: string;
  /** 文件内容；目录/链接忽略。 */
  content?: string | Uint8Array;
  type?: 'file' | 'dir' | 'symlink';
  /** 符号链接目标（type=symlink 时用）。 */
  linkName?: string;
  /** 超长路径用 PAX `path` 记录（默认直接截断，测试里应显式声明）。 */
  pax?: boolean;
  /** 超长路径拆到 ustar prefix 字段（目录部分 ≤155 字节）。 */
  prefix?: boolean;
  /** 超长路径用 GNU `L` 头。 */
  gnuLongName?: boolean;
}

/** 写一个 ustar 头（512 字节）。 */
function writeHeader(
  name: string,
  size: number,
  type: string,
  linkName = '',
  prefix = '',
): Buffer {
  const header = Buffer.alloc(BLOCK, 0);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 'ascii');
  header.write('0000000\0', 108, 'ascii');
  header.write('0000000\0', 116, 'ascii');
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  header.write('00000000000\0', 136, 'ascii');
  header.fill(0x20, 148, 156); // 校验和字段先填空格
  header.write(type, 156, 1, 'ascii');
  header.write(linkName, 157, 100, 'utf8');
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  header.write('tester\0', 265, 'ascii');
  header.write('tester\0', 297, 'ascii');
  header.write(prefix, 345, 155, 'utf8');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return header;
}

/** 内容补零到 512 的整数倍。 */
function padBody(body: Buffer): Buffer {
  const remainder = body.length % BLOCK;
  if (remainder === 0) return body;
  return Buffer.concat([body, Buffer.alloc(BLOCK - remainder, 0)]);
}

/** 一条 PAX 记录（长度包含长度数字自身）。 */
function paxRecord(key: string, value: string): Buffer {
  const payload = Buffer.from(`${key}=${value}\n`, 'utf8');
  let total = payload.length + 2;
  for (;;) {
    const next = String(total).length + 1 + payload.length;
    if (next === total) break;
    total = next;
  }
  return Buffer.concat([Buffer.from(`${total} `, 'ascii'), payload]);
}

/** 把超长路径拆成 prefix（目录）+ name（文件名），两段都要放得下。 */
function splitPrefix(name: string): { prefix: string; name: string } {
  const index = name.lastIndexOf('/');
  if (index <= 0) return { prefix: '', name: name.slice(0, 100) };
  const prefix = name.slice(0, index);
  const base = name.slice(index + 1);
  if (prefix.length > 155 || base.length > 100) {
    return { prefix: '', name: name.slice(0, 100) };
  }
  return { prefix, name: base };
}

/**
 * 生成一个 tar 字节流。条目按给定顺序写入，末尾补两个全零块。
 * 超长路径默认截断到 100 字节；需要验证 PAX/GNU/prefix 时显式开关。
 */
export function buildTar(entries: readonly TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const type = entry.type ?? 'file';
    const body: Buffer =
      type !== 'file'
        ? Buffer.alloc(0)
        : typeof entry.content === 'string'
          ? Buffer.from(entry.content, 'utf8')
          : entry.content === undefined
            ? Buffer.alloc(0)
            : Buffer.from(entry.content);
    const longName = entry.name.length > 100;
    let headerName = entry.name;
    let prefix = '';

    if (longName && entry.pax === true) {
      const paxBody = paxRecord('path', entry.name);
      parts.push(writeHeader('PaxHeaders/entry', paxBody.length, 'x'));
      parts.push(padBody(paxBody));
      headerName = entry.name.slice(0, 100);
    } else if (longName && entry.gnuLongName === true) {
      const gnuBody = Buffer.from(`${entry.name}\0`, 'utf8');
      parts.push(writeHeader('././@LongLink', gnuBody.length, 'L'));
      parts.push(padBody(gnuBody));
      headerName = entry.name.slice(0, 100);
    } else if (longName && entry.prefix === true) {
      const split = splitPrefix(entry.name);
      headerName = split.name;
      prefix = split.prefix;
    } else {
      headerName = entry.name.slice(0, 100);
    }

    const typeFlag = type === 'dir' ? '5' : type === 'symlink' ? '2' : '0';
    const linkName = type === 'symlink' ? (entry.linkName ?? '') : '';
    parts.push(writeHeader(headerName, body.length, typeFlag, linkName, prefix));
    if (body.length > 0) parts.push(padBody(body));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}

/** 单帧 zstd 压缩的 tar 包。 */
export function buildTarZstd(entries: readonly TarEntry[]): Buffer {
  return zstdCompressSync(buildTar(entries));
}

/**
 * 多帧 zstd 压缩的 tar 包：把 tar 字节从中间切开，各压一帧再拼接。
 * 用来验证解包路径按帧解码后仍能还原完整 tar 流。
 */
export function buildTarZstdMultiFrame(entries: readonly TarEntry[]): Buffer {
  const tar = buildTar(entries);
  const middle = Math.floor(tar.length / 2);
  return Buffer.concat([
    zstdCompressSync(tar.subarray(0, middle)),
    zstdCompressSync(tar.subarray(middle)),
  ]);
}
