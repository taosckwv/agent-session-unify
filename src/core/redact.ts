/**
 * 脱敏规则与占位符（DESIGN §8、t1 契约 core/redact.ts）。
 *
 * - 最小规则集（V1）：① 凭据前缀 sk-/AKIA/ghp_/xox/JWT/Bearer 开头的字符串；
 *   ② 配置里 apiKey/token/password/secret 字段的值（redactObject，字段名任意
 *   大小写/分隔符变体）。
 * - 同一原文永远得到同一占位符（hashPlaceholder，确定性）；
 * - 纯函数、无副作用、不读配置文件（t1 裁决 R14）；只改字符串值，
 *   非字符串叶值原样保留。
 * - 组装层（spanBuilder）是唯一调用入口（DESIGN §4.4）；解析器/otlp 不 import 本模块。
 * - 时机：组装层写字符串属性前过滤 → 落盘文件里只有占位符，原文不落盘。
 * - 已知风险（DESIGN §8）：V1 规则未覆盖的凭据会落进输出；输出文件按
 *   原始日志同级敏感级别管理，只放本地 data/。
 * - 待办（遇到真实案例再补）：连接串里的账号口令、URL 里的 token、
 *   Authorization 头的完整解析。
 */

import { hashPlaceholder } from './ids.js';

/** 占位符前缀（R14 契约建议：asu.redacted.<hash>）。 */
export const ASU_REDACTED_PREFIX = 'asu.redacted';

/** 命中即替换的凭据前缀（DESIGN §8 规则 1）。 */
const CREDENTIAL_PREFIXES = ['sk-', 'AKIA', 'ghp_', 'xox', 'JWT', 'Bearer'] as const;

/**
 * 前缀命中要求的最小剩余长度：防止正文里恰好出现 'Bearer'/'xox' 这类
 * 短字样被误杀（AGENTS：路径、代码、对话正文保留）。值为 4：前缀之外
 * 至少还要有 4 个字符才认定为凭据形态（真实凭据远长于此）。
 */
const MIN_TAIL_LENGTH = 4;

/**
 * 敏感字段名（DESIGN §8 规则 2）：apiKey / token / password / secret，
 * 大小写不敏感，接受驼峰/下划线/中划线分隔的变体与前后缀组合
 * （如 api_key、x-apiKey、clientSecret、auth-token、USER_TOKEN）。
 * 判定方式：去掉分隔符后小写化的名字里含有这四个词之一。
 */
const SENSITIVE_FIELD_WORDS = ['apikey', 'token', 'password', 'secret'] as const;

/** 判断字段名是否命中敏感词（大小写/分隔符不敏感）。 */
function isSensitiveFieldName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[\s_-]/g, '');
  return SENSITIVE_FIELD_WORDS.some((word) => normalized.includes(word));
}

/** 完整字符串凭据判定：已知前缀开头且尾部足够长。 */
function isCredentialString(s: string): boolean {
  return CREDENTIAL_PREFIXES.some(
    (p) => s.startsWith(p) && s.length - p.length >= MIN_TAIL_LENGTH,
  );
}

/**
 * 字符串值脱敏：命中凭据形态 → `asu.redacted.<16hex>` 占位符；否则原样返回。
 * 占位符本身不再命中规则（幂等：再输入一次得到同一个占位符）。
 */
export function redactString(s: string): string {
  if (s.startsWith(ASU_REDACTED_PREFIX + '.')) return s;
  if (!isCredentialString(s)) return s;
  return `${ASU_REDACTED_PREFIX}.${hashPlaceholder(s)}`;
}

/** 未知 JSON 值的宽松类型（redactObject 只处理普通对象/数组/字符串叶）。 */
type JsonLike = string | number | boolean | null | JsonLike[] | { [k: string]: JsonLike };

/** 数组/普通对象判定（排除 null、Map/Set/Date 等非 JSON 形态——它们原样返回）。 */
function isPlainObjectOrArray(v: unknown): v is JsonLike[] | { [k: string]: JsonLike } {
  if (typeof v !== 'object' || v === null) return false;
  if (Array.isArray(v)) return true;
  const proto = Object.getPrototypeOf(v) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * 递归对象脱敏（规则 ② 的执行者）：
 * - 键命中敏感字段名且值为字符串 → 该值无条件替换成占位符（即使无凭据前缀：
 *   配置字段里的 token 就该脱）；
 * - 键命中但值为对象/数组 → 整棵值树继续按同规则递归（值内部再脱）；
 * - 普通字段中的字符串值仍走 redactString（前缀规则 ① 独立生效）；
 * - 非字符串叶值（数字/布尔/null）原样保留（R14）。
 * 纯函数：不修改输入；Map/Set/Date 等非 JSON 形态原样引用返回。
 * 循环引用安全：已访问对象直接返回原引用（其字符串叶不再重脱，避免死循环）。
 */
export function redactObject<T>(value: T): T {
  return redactValue(value, new Set()) as T;
}

function redactValue(value: JsonLike | unknown, seen: Set<object>): unknown {
  if (typeof value === 'string') return redactString(value);
  if (!isPlainObjectOrArray(value)) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (isSensitiveFieldName(k) && typeof v === 'string') {
      // 字段规则 ②：值无条件替换（配置字段里的 token 本身就是凭据，
      // 无前缀也脱）；已是占位符则原样保留（幂等）。
      out[k] = v.startsWith(`${ASU_REDACTED_PREFIX}.`)
        ? v
        : `${ASU_REDACTED_PREFIX}.${hashPlaceholder(v)}`;
      continue;
    }
    out[k] = redactValue(v, seen);
  }
  return out;
}
