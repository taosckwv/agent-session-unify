/**
 * DSH 解析器测试的合成样本工厂（DESIGN §9：样本一律合成/脱敏，仓库不放真实会话）。
 *
 * 只做三件事：
 * 1. 造多帧 zstd 容器（每段文本压成一帧，首尾相接）——用于测帧边界、跨帧行、坏帧；
 * 2. 造 v4/v3 会话 jsonl 文本（信头 + 事件 + 可注入的坏行）；
 * 3. 落盘到临时目录（`mkdtemp`），路径交给解析器。
 *
 * 时间基准 `BASE_MS` 是 13 位 epoch 毫秒（2025-11-23 前后），与真实 DSH 事件同量级，
 * 保证「毫秒 → 纳秒」路径走的是真实数值范围而不是玩具值。
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

/** 毫秒基准：2025-11-23T00:00:00Z（13 位，Number 安全）。 */
export const BASE_MS = 1763856000000;

/** 造一个临时目录（每个用例独立，避免互相污染与并发冲突）。 */
export function makeSessionDir(): string {
  return mkdtempSync(join(tmpdir(), 'asu-dsh-'));
}

/** 把若干段文本（或原始字节）各自压成一帧，首尾相接成多帧 zstd 容器。 */
export function compressFrames(chunks: readonly (string | Uint8Array)[]): Buffer {
  return Buffer.concat(
    chunks.map((chunk) =>
      zstdCompressSync(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk),
    ),
  );
}

/** 把一个多帧 zstd 容器写到 `<dir>/<name>`，返回路径。 */
export function writeFramesFile(
  dir: string,
  name: string,
  chunks: readonly (string | Uint8Array)[],
): string {
  const path = join(dir, name);
  writeFileSync(path, compressFrames(chunks));
  return path;
}

/** 一条事件（不含空字段：可选键只在给了值时出现）。 */
export interface SyntheticEvent {
  type: string;
  seq?: number;
  time?: number | string;
  data?: unknown;
  /** 事件级额外键（surfaceOp / sourceEventSeqs 等）。 */
  [key: string]: unknown;
}

/** 一个合成会话：信头字段 + 事件序列。 */
export interface SyntheticSession {
  /** 信头版本；`null` = 不写信头（用于「缺信头」用例）。 */
  version?: number | null;
  id?: string;
  origin?: string;
  cwd?: string;
  createdAt?: number;
  /** 信头额外/覆盖字段（例如 agentPreset、delegationDepth、未知字段）。 */
  headerExtra?: Record<string, unknown>;
  events: readonly SyntheticEvent[];
  /** 事件之后追加的原始行（注入坏 JSON、空行等）。 */
  rawLines?: readonly string[];
}

/** 造 v4 会话的信头对象。`id: ''` 表示不写 id（测 R6 文件名回退）。 */
export function sessionHeader(session: SyntheticSession = { events: [] }): Record<string, unknown> {
  const header: Record<string, unknown> = {
    type: 'session',
    version: session.version ?? 4,
    createdAt: session.createdAt ?? BASE_MS,
    cwd: session.cwd ?? 'D:/work/demo',
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'default',
  };
  if (session.id !== '') header.id = session.id ?? 'sess-synthetic-1';
  if (session.origin !== undefined) header.origin = session.origin;
  return { ...header, ...(session.headerExtra ?? {}) };
}

/** 会话的整段 jsonl 文本（每行一条记录，末尾带换行）。 */
export function sessionText(session: SyntheticSession): string {
  const lines: string[] = [];
  if (session.version !== null) lines.push(JSON.stringify(sessionHeader(session)));
  for (const event of session.events) lines.push(JSON.stringify(event));
  for (const raw of session.rawLines ?? []) lines.push(raw);
  return `${lines.join('\n')}\n`;
}

/**
 * 造一个会话文件：整段文本压成**一帧**（最接近真实写法的默认形态）。
 * `fileName` 默认 `session.v<version>.jsonl.zstd`。
 */
export function writeSessionFile(
  dir: string,
  session: SyntheticSession,
  fileName?: string,
): string {
  const version = session.version === null ? undefined : (session.version ?? 4);
  const name = fileName ?? (version === undefined ? 'session.jsonl.zstd' : `session.v${version}.jsonl.zstd`);
  const path = join(dir, name);
  writeFileSync(path, compressFrames([sessionText(session)]));
  return path;
}

/**
 * 造一个会话文件，按**多帧**写（每行一帧；也可显式给帧切分）——用于验证
 * 「全部帧拼接后再切行」以及跨帧行（R3）。
 */
export function writeSessionFileMultiFrame(
  dir: string,
  session: SyntheticSession,
  frameChunks?: readonly string[],
  fileName?: string,
): string {
  const version = session.version === null ? undefined : (session.version ?? 4);
  const name = fileName ?? (version === undefined ? 'session.jsonl.zstd' : `session.v${version}.jsonl.zstd`);
  const chunks = frameChunks ?? sessionText(session).split('\n').filter((line) => line !== '');
  const path = join(dir, name);
  writeFileSync(path, compressFrames(chunks));
  return path;
}

/** 便捷：一条带 seq/time 的事件。 */
export function event(
  type: string,
  seq: number,
  offsetMs: number,
  data?: unknown,
  extra: Record<string, unknown> = {},
): SyntheticEvent {
  const e: SyntheticEvent = { type, seq, time: BASE_MS + offsetMs, ...extra };
  if (data !== undefined) e.data = data;
  return e;
}
