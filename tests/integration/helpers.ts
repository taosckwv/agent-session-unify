/**
 * 集成测试独立工具（tests/integration/helpers.ts）。
 *
 * 设计原则：**不复用 src/ 与 tests/helpers.ts 的树级工具**，只从 CLI 落盘的
 * OTLP JSON 反推事实（条数守恒、字段齐全、父子关系、脱敏），避免「用实现验证
 * 实现」。唯一 import 的 src/ 是测试驱动入口 `runParse`。
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { expect } from 'vitest';

// ---------------------------------------------------------------------------
// 临时目录 / 文件
// ---------------------------------------------------------------------------

export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 删除临时目录：Windows 上偶发句柄未释放（ENOTEMPTY），重试后仍失败不影响断言。 */
export function removeTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // 临时目录清理失败不是产品缺陷；留给系统临时目录清理。
  }
}

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 每段各压成一个 zstd 帧后首尾相接（R3：帧 ≠ 行，一个帧可含多行）。 */
export function compressChunksToFrames(chunks: Array<Buffer | string>): Buffer {
  const frames = chunks.map((chunk) => zstdCompressSync(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')));
  return Buffer.concat(frames);
}

/** 写 DSH 会话文件（默认文件名 session.v4.jsonl.zstd），返回绝对路径。 */
export function writeDshSessionFile(
  dir: string,
  chunks: Array<Buffer | string>,
  fileName = 'session.v4.jsonl.zstd',
): string {
  const path = join(dir, fileName);
  writeFileSync(path, compressChunksToFrames(chunks));
  return path;
}

/** 写 CC 会话文件（对象逐行 JSON.stringify，字符串原样作为一行），返回绝对路径。 */
export function writeCcSessionFile(
  dir: string,
  lines: Array<Record<string, unknown> | string>,
  fileName = 'cc-session.jsonl',
): string {
  const text = lines
    .map((line) => (typeof line === 'string' ? line : JSON.stringify(line)))
    .join('\n');
  const path = join(dir, fileName);
  writeFileSync(path, text);
  return path;
}

/** 递归列出目录下的普通文件（相对路径，posix 分隔符，字典序）。 */
export function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(relative(dir, full).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

// ---------------------------------------------------------------------------
// OTLP 输出读取
// ---------------------------------------------------------------------------

export interface OtlpAttribute {
  key: string;
  value: Record<string, unknown>;
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes?: OtlpAttribute[];
  status?: { code?: string; message?: string };
}

export interface OtlpTracesData {
  resourceSpans?: Array<{
    resource?: { attributes?: OtlpAttribute[] };
    scopeSpans?: Array<{ scope?: { name?: string }; spans?: OtlpSpan[] }>;
  }>;
}

export interface OutputFile {
  /** 输出根目录内的相对路径（posix 分隔符）。 */
  relPath: string;
  absolutePath: string;
  text: string;
  data: OtlpTracesData;
  spans: OtlpSpan[];
  resourceAttributes: OtlpAttribute[];
}

/** 读一个 output JSON，并拍平成 spans 列表（不假设只有一层 scopeSpans）。 */
export function readOutputFile(absolutePath: string, baseDir: string): OutputFile {
  const text = readFileSync(absolutePath, 'utf8');
  const data = JSON.parse(text) as OtlpTracesData;
  const spans: OtlpSpan[] = [];
  const resourceAttributes: OtlpAttribute[] = [];
  for (const resourceSpan of data.resourceSpans ?? []) {
    resourceAttributes.push(...(resourceSpan.resource?.attributes ?? []));
    for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
      spans.push(...(scopeSpan.spans ?? []));
    }
  }
  return {
    relPath: relative(baseDir, absolutePath).split(sep).join('/'),
    absolutePath,
    text,
    data,
    spans,
    resourceAttributes,
  };
}

/** 读输出目录下全部 `*.json`（按相对路径排序）。 */
export function loadOutputDir(baseDir: string): OutputFile[] {
  return listFilesRecursive(baseDir)
    .filter((rel) => rel.endsWith('.json'))
    .map((rel) => readOutputFile(join(baseDir, rel), baseDir));
}

// ---------------------------------------------------------------------------
// 属性读取（OTLP 值 oneof：stringValue / intValue / doubleValue / boolValue）
// ---------------------------------------------------------------------------

export function attributeValue(span: OtlpSpan, key: string): Record<string, unknown> | undefined {
  return span.attributes?.find((attribute) => attribute.key === key)?.value;
}

export function hasAttribute(span: OtlpSpan, key: string): boolean {
  return attributeValue(span, key) !== undefined;
}

/** 只接受 stringValue（`asu.stats.*` 必须是字符串标量，R18）。 */
export function stringAttribute(span: OtlpSpan, key: string): string | undefined {
  const value = attributeValue(span, key);
  return value !== undefined && typeof value['stringValue'] === 'string'
    ? (value['stringValue'] as string)
    : undefined;
}

/** 只接受 intValue。 */
export function intAttribute(span: OtlpSpan, key: string): number | undefined {
  const value = attributeValue(span, key);
  return value !== undefined && typeof value['intValue'] === 'number'
    ? (value['intValue'] as number)
    : undefined;
}

/** 任意标量形态（intValue 或 stringValue），用于身份/统计的宽松断言。 */
export function scalarAttribute(span: OtlpSpan, key: string): string | number | boolean | undefined {
  const value = attributeValue(span, key);
  if (value === undefined) return undefined;
  if (typeof value['stringValue'] === 'string') return value['stringValue'] as string;
  if (typeof value['intValue'] === 'number') return value['intValue'] as number;
  if (typeof value['doubleValue'] === 'number') return value['doubleValue'] as number;
  if (typeof value['boolValue'] === 'boolean') return value['boolValue'] as boolean;
  return undefined;
}

export function resourceAttribute(file: OutputFile, key: string): string | number | undefined {
  const attribute = file.resourceAttributes.find((item) => item.key === key);
  if (attribute === undefined) return undefined;
  const value = attribute.value;
  if (typeof value['stringValue'] === 'string') return value['stringValue'] as string;
  if (typeof value['intValue'] === 'number') return value['intValue'] as number;
  return undefined;
}

export function findSpan(file: OutputFile, predicate: (span: OtlpSpan) => boolean): OtlpSpan {
  const span = file.spans.find(predicate);
  expect(span, '期望的 span 不存在').toBeDefined();
  return span as OtlpSpan;
}

export function spansNamed(file: OutputFile, name: string): OtlpSpan[] {
  return file.spans.filter((span) => span.name === name);
}

/**
 * 四层 span 判定：session/turn/step 的 name 有固定前缀；其余非 compaction 即 tool。
 * 注意 `asu.compaction` 是布尔属性（kv 走 boolValue），这里不绑定具体 oneof 分支。
 */
export function isCompactionSpan(span: OtlpSpan): boolean {
  const flag = scalarAttribute(span, 'asu.compaction');
  return flag === true || flag === 'true';
}

export function rootSpan(file: OutputFile): OtlpSpan {
  const roots = file.spans.filter((span) => span.parentSpanId === undefined);
  expect(roots, '每个输出文件必须恰好一个根 span').toHaveLength(1);
  return roots[0] as OtlpSpan;
}

// ---------------------------------------------------------------------------
// 三件套之二：字段齐全 + 结构自洽 + 条数守恒（全部从落盘 JSON 独立重算）
// ---------------------------------------------------------------------------

export interface OutputInvariants {
  spanCount: number;
  compactionSpans: number;
  fourLayerSpans: number;
  sourceRefTotal: number;
  inputRecords: number;
  skippedRecords: number;
  traceId: string;
  rootSpanId: string;
}

/**
 * 校验一个输出文件的字段齐全/结构自洽/守恒：
 * - 单 trace、单根、无悬空 parentSpanId、spanId 唯一；
 * - name/kind/纳秒字符串合法，end >= start；
 * - 属性键唯一且按码点序排序；值恰好一个 oneof 分支；intValue 为安全整数；
 * - `asu.stats.*` 全部 stringValue（R18），produced_spans = 实际 span 数；
 * - compaction_spans = 带 asu.compaction=true 的 span 数；
 * - 守恒（R7 修订后口径）：Σ asu.source_ref_count + skipped_records = input_records，
 *   四层 span 数 = span 总数 − compaction span 数。
 */
export function assertOutputInvariants(file: OutputFile): OutputInvariants {
  const spans = file.spans;
  expect(spans.length, `${file.relPath} 必须至少 1 个 span`).toBeGreaterThan(0);

  const ids = new Set(spans.map((span) => span.spanId));
  expect(ids.size, `${file.relPath} spanId 必须唯一`).toBe(spans.length);

  const traceIds = new Set(spans.map((span) => span.traceId));
  expect(traceIds.size, `${file.relPath} 单文件必须单 trace`).toBe(1);
  const traceId = spans[0]?.traceId as string;
  expect(traceId).toMatch(/^[0-9a-f]{32}$/);

  const root = rootSpan(file);
  expect(root.parentSpanId).toBeUndefined();

  for (const span of spans) {
    const label = `${file.relPath}#${span.name}`;
    expect(span.name.length, `${label} name 非空`).toBeGreaterThan(0);
    expect(span.kind, `${label} kind`).toBe('SPAN_KIND_INTERNAL');
    expect(span.spanId, `${label} spanId 形态`).toMatch(/^[0-9a-f]{16}$/);
    expect(span.startTimeUnixNano, `${label} start 纳秒字符串`).toMatch(/^\d+$/);
    expect(span.endTimeUnixNano, `${label} end 纳秒字符串`).toMatch(/^\d+$/);
    expect(
      BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano),
      `${label} end >= start`,
    ).toBe(true);
    if (span.parentSpanId !== undefined) {
      expect(ids.has(span.parentSpanId), `${label} parentSpanId 不得悬空`).toBe(true);
      expect(span.parentSpanId).toMatch(/^[0-9a-f]{16}$/);
    }
    const attributes = span.attributes ?? [];
    const keys = attributes.map((attribute) => attribute.key);
    expect(new Set(keys).size, `${label} 属性键不得重复`).toBe(keys.length);
    expect(keys, `${label} 属性必须按码点序排序`).toEqual([...keys].sort());
    for (const attribute of attributes) {
      const branches = Object.keys(attribute.value);
      expect(branches, `${label} 属性 ${attribute.key} 必须恰好一个 oneof 分支`).toHaveLength(1);
      if ('intValue' in attribute.value) {
        expect(Number.isSafeInteger(attribute.value['intValue']), `${label} intValue 必须安全整数`).toBe(true);
      }
      if ('stringValue' in attribute.value) {
        expect(typeof attribute.value['stringValue'], `${label} stringValue 必须是字符串`).toBe('string');
      }
    }
    // R18：asu.stats.* 必须是字符串标量（unknown_event_types.<type> 也算）。
    for (const attribute of attributes) {
      if (!attribute.key.startsWith('asu.stats.')) continue;
      expect(
        typeof attribute.value['stringValue'],
        `${label} 的 ${attribute.key} 必须是 stringValue`,
      ).toBe('string');
    }
  }

  const producedSpans = Number(stringAttribute(root, 'asu.stats.produced_spans'));
  expect(producedSpans, `${file.relPath} produced_spans 必须是数字`).not.toBeNaN();
  expect(producedSpans, `${file.relPath} produced_spans = 落盘 span 数`).toBe(spans.length);

  const compactionSpans = spans.filter(isCompactionSpan).length;
  const declaredCompaction = Number(stringAttribute(root, 'asu.stats.compaction_spans'));
  expect(declaredCompaction, `${file.relPath} compaction_spans 必须是数字`).not.toBeNaN();
  expect(declaredCompaction, `${file.relPath} compaction span 计账`).toBe(compactionSpans);

  const sourceRefTotal = spans.reduce((sum, span) => sum + (intAttribute(span, 'asu.source_ref_count') ?? 0), 0);
  const inputRecords = Number(stringAttribute(root, 'asu.stats.input_records'));
  const skippedRecords = Number(stringAttribute(root, 'asu.stats.skipped_records'));
  expect(inputRecords, `${file.relPath} input_records 必须是数字`).not.toBeNaN();
  expect(skippedRecords, `${file.relPath} skipped_records 必须是数字`).not.toBeNaN();
  expect(
    sourceRefTotal + skippedRecords,
    `${file.relPath} 条数守恒：Σsource_refs(${sourceRefTotal}) + skipped(${skippedRecords}) = input(${inputRecords})`,
  ).toBe(inputRecords);

  return {
    spanCount: spans.length,
    compactionSpans,
    fourLayerSpans: spans.length - compactionSpans,
    sourceRefTotal,
    inputRecords,
    skippedRecords,
    traceId,
    rootSpanId: root.spanId,
  };
}

/** source_ref_count 必须等于该节点 sourceRefs 长度——此处只能校验根 span 与 stats 的关系。 */
export function assertResourceIdentity(
  file: OutputFile,
  expected: { tool: string; sessionId: string; agentLabel: string },
): void {
  expect(resourceAttribute(file, 'service.name')).toBe(expected.tool);
  expect(resourceAttribute(file, 'asu.session.id')).toBe(expected.sessionId);
  expect(resourceAttribute(file, 'asu.session.agent_label')).toBe(expected.agentLabel);
  const keys = file.resourceAttributes.map((attribute) => attribute.key);
  expect(keys).toEqual([...keys].sort());
  expect(new Set(keys).size).toBe(keys.length);
}

// ---------------------------------------------------------------------------
// 脱敏泄漏扫描（在落盘字节上检索）
// ---------------------------------------------------------------------------

/** 输出文件里不允许出现的凭据形态（真实形态，不是占位符）。 */
const CREDENTIAL_LEAK_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'sk-', pattern: /sk-[A-Za-z0-9_-]{10,}/ },
  { label: 'AKIA', pattern: /AKIA[0-9A-Z]{16}/ },
  { label: 'ghp_', pattern: /ghp_[A-Za-z0-9]{20,}/ },
  { label: 'xox', pattern: /xox[abprs]-[A-Za-z0-9-]{10,}/ },
  { label: 'Bearer', pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{10,}/ },
  { label: 'JWT', pattern: /JWT\s+eyJ[A-Za-z0-9._-]{10,}/ },
];

/** 断言落盘文本里没有任何未脱敏凭据；返回命中的标签列表（空数组即通过）。 */
export function findCredentialLeaks(text: string): string[] {
  return CREDENTIAL_LEAK_PATTERNS.filter((item) => item.pattern.test(text)).map((item) => item.label);
}

export function assertNoCredentialLeak(file: OutputFile): void {
  expect(findCredentialLeaks(file.text), `${file.relPath} 不得泄漏凭据`).toEqual([]);
}

/** 落盘文本里出现占位符即可证明脱敏路径真的执行过（不是恰好没有敏感输入）。 */
export function countRedactionPlaceholders(text: string): number {
  return text.split('asu.redacted.').length - 1;
}
