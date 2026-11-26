/**
 * 确定性 id 派生（DESIGN §4.2/§4.3/§10、t1 契约 core/ids.ts）。
 *
 * 全部纯函数：node:crypto sha256（域分隔后截断），同输入永远同输出；
 * 禁 Math.random / Date.now / 环境状态 —— 两次跑出字节相同的文件（§10）。
 *
 * 借鉴 jwilson411/dsh-otel 的「span 树 + 派生 id」思路（见 docs/RESEARCH.md §6.2），
 * 按本仓库约定重写：hash 域分隔、序号校验、跨文件父引用专用派生。
 */

import { createHash } from 'node:crypto';

/** sha256 十六进制长度。 */
const SHA256_HEX_LENGTH = 64;
/** OTLP trace_id：16 字节 = 32 个 hex 字符。 */
export const TRACE_ID_HEX_LENGTH = 32;
/** OTLP span_id：8 字节 = 16 个 hex 字符。 */
export const SPAN_ID_HEX_LENGTH = 16;
/** 占位符 hash 截断长度（16 hex = 64 bit，足以对账且简短）。 */
export const PLACEHOLDER_HASH_HEX_LENGTH = 16;

/** trace_id 派生的域分隔前缀（防同一文本跨用途撞 id）。 */
const DOMAIN_TRACE = 'asu:trace:';

/** span_id 派生的域分隔前缀。 */
const DOMAIN_SPAN = 'asu:span:';

/** 占位符 hash 的域分隔前缀。 */
const DOMAIN_PLACEHOLDER = 'asu:redacted:';

/** 跨文件父会话引用的域分隔前缀。 */
const DOMAIN_PARENT_REF = 'asu:parent-ref:';

/** sha256 十六进制小写（单一路径，供各派生函数与测试锚定）。 */
export function sha256Hex(input: string): string {
  const hex = createHash('sha256').update(input, 'utf8').digest('hex');
  return hex.length === SHA256_HEX_LENGTH ? hex : hex.slice(0, SHA256_HEX_LENGTH);
}

/** 非负整数校验：序号非法（负/非整数/NaN/Infinity）直接抛错，不静默产出错误路径。 */
function assertOrdinal(ordinal: number, what: string): void {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new RangeError(`非法序号 ${what} = ${ordinal}（须为非负整数）`);
  }
}

/**
 * 会话键 <sessionId>__<agentLabel>（与输出文件名同一约定，DESIGN §3.1）。
 * 同 session_id 不同 agent 的 span_id 从不同键派生（互不撞），但共享同一 trace_id。
 */
export function sessionKey(sessionId: string, agentLabel: string): string {
  return `${sessionId}__${agentLabel}`;
}

/**
 * trace_id 派生：同一 session_id 的主/子 agent 文件共享同一 trace（DESIGN §3.1
 * 跨文件父子引用的前提）。32 位小写 hex。
 */
export function deriveTraceId(sessionId: string): string {
  return sha256Hex(`${DOMAIN_TRACE}${sessionId}`).slice(0, TRACE_ID_HEX_LENGTH);
}

/**
 * 父会话 span 引用（DESIGN §3.1/§3.5：跨文件父子不靠合并文件表达）。
 * 在本会话文件里以 asu.* 属性携带对父会话根 span 的 {traceId, spanId} 引用；
 * 父文件缺失时读文件方仍能用 traceId 对上。
 */
export function deriveParentSpanRef(
  parentSessionId: string,
  parentAgentLabel: string,
): { traceId: string; spanId: string } {
  return {
    traceId: deriveTraceId(parentSessionId),
    spanId: deriveSpanId(
      sessionKey(parentSessionId, parentAgentLabel),
      sessionSpanPath(),
    ),
  };
}

/** 根（会话）span 路径。 */
export function sessionSpanPath(): string {
  return 'session';
}

/** 轮 span 路径：turn/<轮序号>。 */
export function turnSpanPath(turnOrdinal: number): string {
  assertOrdinal(turnOrdinal, 'turnOrdinal');
  return `turn/${turnOrdinal}`;
}

/** 步 span 路径：turn/<轮>/step/<步序号>。 */
export function stepSpanPath(turnOrdinal: number, stepOrdinal: number): string {
  assertOrdinal(stepOrdinal, 'stepOrdinal');
  return `${turnSpanPath(turnOrdinal)}/step/${stepOrdinal}`;
}

/** 工具 span 路径：turn/<轮>/step/<步>/tool/<工具序号>。 */
export function toolSpanPath(
  turnOrdinal: number,
  stepOrdinal: number,
  toolOrdinal: number,
): string {
  assertOrdinal(toolOrdinal, 'toolOrdinal');
  return `${stepSpanPath(turnOrdinal, stepOrdinal)}/tool/${toolOrdinal}`;
}

/**
 * span_id 派生：从会话键 + span 树路径确定性派生（16 位小写 hex）。
 * 路径含层间前缀关系（父层路径是子层路径的前缀），派生域隔离见 DOMAIN_SPAN。
 */
export function deriveSpanId(key: string, spanPath: string): string {
  return sha256Hex(`${DOMAIN_SPAN}${key}:${spanPath}`).slice(0, SPAN_ID_HEX_LENGTH);
}

/**
 * 占位符 hash（DESIGN §8：命中凭据 → 带确定性 hash 前缀的占位符，
 * 同一原文同一占位符，可对账）。16 位小写 hex。
 */
export function hashPlaceholder(plaintext: string): string {
  return sha256Hex(`${DOMAIN_PLACEHOLDER}${plaintext}`).slice(
    0,
    PLACEHOLDER_HASH_HEX_LENGTH,
  );
}
