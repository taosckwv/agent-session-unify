/**
 * OTLP JSON 类型、键序固定序列化与会话文件落盘（DESIGN §3.1/§3.2/§4.3/§10、
 * t1 契约 §2 core/otlp.ts 与裁决 R13）。
 *
 * 硬约束（t1 检查单）：
 * - 字节级确定：序列化只走本文件手写的固定键序路径（schema 字段序：
 *   traceId→spanId→parentSpanId→name→kind→startTimeUnixNano→endTimeUnixNano→
 *   attributes→status；oneof 分支序见 VALUE_BRANCHES），不依赖对象插入顺序，
 *   不掺当前时间/随机数（DESIGN §10）。数组元素顺序按调用方给定顺序原样输出
 *   ——属性键的排序策略归组装层 spanBuilder，本模块不越权。
 * - OTLP JSON 语义（R13）：traceId/spanId/parentSpanId 用小写 hex 字符串
 *   （protobuf JSON 映射里 bytes 的十六进制形态；base64 是 wire 格式，不用于
 *   JSON 文件）；startTimeUnixNano/endTimeUnixNano 用纳秒十进制字符串（int64
 *   的字符串形态，纳秒值超 2^53，禁 Number 运算）。
 * - 值 oneof 须恰好一个分支，否则抛错（编程错误早暴露，不静默猜）；intValue
 *   的 number 形态只收安全整数（超界用字符串形态），doubleValue 只收有限数
 *   （NaN/±Infinity 在 JSON 不可表达，宁可早抛不静默产出 null）。
 * - 落盘（DESIGN §3.1/§4.3、R4）：writeSessionFile 写
 *   <outDir>/<toolName>/<sessionId>__<agentLabel>.json，内容恰为传入 json 的
 *   utf-8 字节（不追加换行、不加时间戳），目录递归创建。文件名部件做字符级
 *   净化（路径安全）；span/trace id 与属性值保持原样，净化只影响路径。
 * - 本模块不 import redact：脱敏唯一入口在组装层（DESIGN §4.4），tests 里以
 *   源码断言钉住这条边界。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** OTLP span kind（JSON 字符串形态，照 opentelemetry-proto JSON 映射）。 */
export type SpanKind =
  | 'SPAN_KIND_UNSPECIFIED'
  | 'SPAN_KIND_INTERNAL'
  | 'SPAN_KIND_SERVER'
  | 'SPAN_KIND_CLIENT'
  | 'SPAN_KIND_PRODUCER'
  | 'SPAN_KIND_CONSUMER';

/** OTLP status code（JSON 字符串形态）。 */
export type StatusCode = 'STATUS_CODE_UNSET' | 'STATUS_CODE_OK' | 'STATUS_CODE_ERROR';

/**
 * OTLP 属性值（oneof）。intValue 的 string 形态承载超 2^53 的整数
 * （OTLP JSON 允许 int64 以字符串出现，与 R13 同一理由）。
 */
export type AttributeValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: number | string }
  | { doubleValue: number }
  | { arrayValue: { values: AttributeValue[] } }
  | { kvlistValue: { values: KeyValue[] } };

/** OTLP 键值对。 */
export interface KeyValue {
  key: string;
  value: AttributeValue;
}

/** resource：描述「这份数据是谁产生的」，不带时间（DESIGN §3.5）。 */
export interface Resource {
  attributes: KeyValue[];
}

/** instrumentation scope。 */
export interface Scope {
  name: string;
  version?: string;
}

export interface ScopeSpans {
  scope: Scope;
  spans: Span[];
}

export interface ResourceSpans {
  resource: Resource;
  scopeSpans: ScopeSpans[];
}

export interface Status {
  code: StatusCode;
  description?: string;
}

/**
 * OTLP span（字段名照 opentelemetry-proto JSON 映射：traceId/spanId/
 * parentSpanId/…）。时间字段为纳秒十进制字符串（R13）。
 */
export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes?: KeyValue[];
  status?: Status;
}

/** OTLP tracesData：单个输出文件的顶层结构（DESIGN §3.2）。 */
export interface TracesData {
  resourceSpans: ResourceSpans[];
}

/** 本转换器的 instrumentation scope 名（version 留空不猜）。 */
export const SCOPE_NAME = 'agent-session-unify';

/** JSON 字符串的规范转义（ES 规范的确定性路径，不引入第三方）。 */
function jstr(s: string): string {
  return JSON.stringify(s);
}

/** 属性值 oneof 分支的固定识别顺序（校验与序列化共用）。 */
const VALUE_BRANCHES = [
  'stringValue',
  'boolValue',
  'intValue',
  'doubleValue',
  'arrayValue',
  'kvlistValue',
] as const;

function serializeIntValue(n: number | string): string {
  if (typeof n === 'number') {
    if (!Number.isSafeInteger(n)) {
      throw new RangeError(
        `OTLP intValue 的 number 形态须为安全整数（|n| < 2^53），实际 ${n}；超界请用字符串形态`,
      );
    }
    return String(n);
  }
  if (!/^-?\d+$/.test(n)) {
    throw new TypeError(`OTLP intValue 的 string 形态须为十进制整数：${jstr(n)}`);
  }
  return jstr(n);
}

function serializeValue(v: AttributeValue): string {
  const branches = VALUE_BRANCHES.filter((b) => b in v);
  if (branches.length !== 1) {
    throw new TypeError(
      `OTLP 属性值须恰好一个 oneof 分支，实际 ${branches.length} 个（${branches.join('/')}）`,
    );
  }
  if ('stringValue' in v) return `{"stringValue":${jstr(v.stringValue)}}`;
  if ('boolValue' in v) return `{"boolValue":${v.boolValue ? 'true' : 'false'}}`;
  if ('intValue' in v) return `{"intValue":${serializeIntValue(v.intValue)}}`;
  if ('doubleValue' in v) {
    if (!Number.isFinite(v.doubleValue)) {
      throw new RangeError(`OTLP doubleValue 须为有限数：${v.doubleValue}`);
    }
    return `{"doubleValue":${String(v.doubleValue)}}`;
  }
  if ('arrayValue' in v) {
    return `{"arrayValue":{"values":[${v.arrayValue.values.map(serializeValue).join(',')}]}}`;
  }
  if ('kvlistValue' in v) {
    return `{"kvlistValue":{"values":${serializeKeyValues(v.kvlistValue.values)}}}`;
  }
  throw new TypeError('不可达：oneof 分支数已校验为 1');
}

function serializeKeyValues(kvs: KeyValue[]): string {
  return `[${kvs
    .map((kv) => `{"key":${jstr(kv.key)},"value":${serializeValue(kv.value)}}`)
    .join(',')}]`;
}

function serializeStatus(st: Status): string {
  return st.description === undefined
    ? `{"code":${jstr(st.code)}}`
    : `{"code":${jstr(st.code)},"description":${jstr(st.description)}}`;
}

function serializeSpan(sp: Span): string {
  const parts: string[] = ['{"traceId":', jstr(sp.traceId), ',"spanId":', jstr(sp.spanId)];
  if (sp.parentSpanId !== undefined) {
    parts.push(',"parentSpanId":', jstr(sp.parentSpanId));
  }
  parts.push(
    ',"name":',
    jstr(sp.name),
    ',"kind":',
    jstr(sp.kind),
    ',"startTimeUnixNano":',
    jstr(sp.startTimeUnixNano),
    ',"endTimeUnixNano":',
    jstr(sp.endTimeUnixNano),
  );
  if (sp.attributes !== undefined) {
    parts.push(',"attributes":', serializeKeyValues(sp.attributes));
  }
  if (sp.status !== undefined) {
    parts.push(',"status":', serializeStatus(sp.status));
  }
  parts.push('}');
  return parts.join('');
}

function serializeScope(s: Scope): string {
  return s.version === undefined
    ? `{"name":${jstr(s.name)}}`
    : `{"name":${jstr(s.name)},"version":${jstr(s.version)}}`;
}

function serializeResource(r: Resource): string {
  return `{"attributes":${serializeKeyValues(r.attributes)}}`;
}

/**
 * 序列化为 OTLP JSON（无空白、键序固定、字节级确定）。纯函数：
 * 同一结构两次调用产出完全相同的字符串；结构相等（含键插入顺序一致）的
 * 两个对象产出也相同。数字/字符串不自作聪明（见文件头）。
 */
export function serializeTracesData(td: TracesData): string {
  const resourceSpans = td.resourceSpans
    .map(
      (rs) =>
        `{"resource":${serializeResource(rs.resource)},"scopeSpans":[${rs.scopeSpans
          .map(
            (ss) =>
              `{"scope":${serializeScope(ss.scope)},"spans":[${ss.spans
                .map(serializeSpan)
                .join(',')}]}`,
          )
          .join(',')}]}`,
    )
    .join(',');
  return `{"resourceSpans":[${resourceSpans}]}`;
}

/** 文件名部件的安全字符集（其余字符替换为 '_'；仅影响路径，不影响属性原值）。 */
const UNSAFE_FILE_CHARS = /[^A-Za-z0-9._-]/g;

/**
 * 文件名部件净化：跨平台路径安全（Windows 保留字符、分隔符、'.'/'..' 语义）。
 * 纯函数、确定性：同输入同输出。已知取舍：两个不同标识净化后可能撞名
 * （病态情形，调用方 t6 的同名冲突递增后缀负责兜底）。
 */
export function sanitizeFileComponent(component: string): string {
  const replaced = component.replace(UNSAFE_FILE_CHARS, '_');
  return replaced === '.' || replaced === '..' ? `_${replaced}` : replaced;
}

/**
 * 落盘一个 agent 会话文件（DESIGN §3.1/§3.3、§4.3、R4）：
 * <outDir>/<toolName>/<sessionId>__<agentLabel>.json。
 * - 内容恰为传入 json 的 utf-8 字节：不追加换行、不掺当前时间与随机数（§10）；
 * - 目录递归创建（创建行为不影响内容字节）；
 * - 返回写入路径（outDir 原样参与拼接，调用方决定相对/绝对形态）。
 */
export function writeSessionFile(
  outDir: string,
  toolName: string,
  sessionId: string,
  agentLabel: string,
  json: string,
): string {
  const dir = join(outDir, sanitizeFileComponent(toolName));
  mkdirSync(dir, { recursive: true });
  const filePath = join(
    dir,
    `${sanitizeFileComponent(sessionId)}__${sanitizeFileComponent(agentLabel)}.json`,
  );
  writeFileSync(filePath, json, 'utf8');
  return filePath;
}
