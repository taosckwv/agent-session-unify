/**
 * 脱敏规则与占位符（DESIGN §8、t1 契约 core/redact.ts）。
 *
 * - 最小规则集（V1）：① 凭据前缀 sk-/AKIA/ghp_/xox/JWT/Bearer 开头的字符串；
 *   ② 配置里 apiKey/token/password/secret 字段的值（redactObject，字段名任意
 *   大小写/分隔符变体）。
 * - 规则 ③（自由文本口令，2026-11-26 真实案例补）：日志里大量出现的是**对话正文
 *   中被粘贴的口令**（如 `密码：eds@1234sangfornetwork`、`sshpass -p '...'`、
 *   连接串 `mysql://root:xxx@host`、命令行 `--password=xxx`），既没有已知前缀、
 *   也不在敏感字段名下，前两条规则管不住。这里按「锚点 + 形态」双重判定：
 *   锚点必须明确（密码/口令/password 等关键词、`--password=` 这类参数名、URL 的
 *   `user:pass@`、sshpass -p），值还要像凭据（≥4 字符、含 ASCII 字母且含数字或
 *   符号），避免把「密码是错的」这类正文误杀。另有一条窄规则兜「裸的
 *   `xxx@数字xxx` 但在 @ 后没有点」的形态（邮箱与 user@host 都有点，或以非数字开头）。
 * - 同一原文永远得到同一占位符（hashPlaceholder，确定性）；
 * - 纯函数、无副作用、不读配置文件（t1 裁决 R14）；只改字符串值，
 *   非字符串叶值原样保留。
 * - 组装层（spanBuilder）是唯一调用入口（DESIGN §4.4）；解析器/otlp 不 import 本模块。
 * - 时机：组装层写字符串属性前过滤 → 落盘文件里只有占位符，原文不落盘。
 * - 已知风险（DESIGN §8）：规则 ③ 之外的凭据仍会落进输出；输出文件按
 *   原始日志同级敏感级别管理，只放本地 data/。
 * - 待办（遇到真实案例再补）：Authorization 头的完整解析、kerberos 票据等。
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

/** 同一原文 → 同一占位符（确定性，R14）。 */
function placeholderFor(secret: string): string {
  return `${ASU_REDACTED_PREFIX}.${hashPlaceholder(secret)}`;
}

/** 是否已经是占位符（避免二次脱敏、保持幂等）。 */
function isPlaceholder(s: string): boolean {
  return s.includes(ASU_REDACTED_PREFIX + '.');
}

/**
 * 自由文本里的「像凭据」判定（规则 ③ 的第二道闸）：≥4 字符、含 ASCII 字母，
 * 且含数字或符号。纯字母词（sangfornetwork）与纯中文（请输入正确密码）都不算——
 * 否则「密码是错的」这类正文会被误杀，违反 AGENTS「对话正文保留」。
 */
function looksLikeSecret(value: string): boolean {
  if (value.length < 4) return false;
  if (!/[A-Za-z]/.test(value)) return false;
  return /[0-9]/.test(value) || /[^A-Za-z0-9]/.test(value);
}

/** 取值组里第一个非 undefined 的捕获（引号/裸值多分支正则用）。 */
function firstCaptured(groups: readonly unknown[]): string | undefined {
  for (const group of groups) {
    if (typeof group === 'string') return group;
  }
  return undefined;
}

/** 值来自哪个引号分支 → 原样补回同一对引号（脱敏只换值，不改标点）。 */
function quoteOf(dq?: string, sq?: string, bq?: string): string {
  if (dq !== undefined) return '"';
  if (sq !== undefined) return "'";
  if (bq !== undefined) return '`';
  return '';
}

/**
 * 规则 ③a：关键词赋值 `密码：xxx` / `password = xxx` / `口令是 xxx`，
 * 值可带引号或裸写（裸写不允许空白与常见标点，避免吞掉后半句）。
 */
const KEYWORD_ASSIGN =
  /((?:密码|口令|passwd|password|pwd)\s*(?:是|为|[:：=＝])\s*)(?:"([^"\n]{4,})"|'([^'\n]{4,})'|`([^`\n]{4,})`|([^\s,，;；。、"'`)]{4,}))/gi;

/**
 * 规则 ③b：命令行参数 `--password=xxx` / `--token xxx` / `-pwd=xxx`。
 * 值同样可带引号；标签原样保留。
 */
const FLAG_ASSIGN =
  /((?:^|[\s"'`])--?(?:password|passwd|pwd|token|secret|api[-_]?key)\s*[= ]\s*)(?:"([^"\n]{2,})"|'([^'\n]{2,})'|`([^`\n]{2,})`|([^\s"'`]{2,}))/gi;

/** 规则 ③c：连接串 / URL 的 userinfo（`协议://用户:口令@主机`），只脱口令。 */
const URL_USERINFO = /([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:/@]{1,64}:)([^\s@/]{1,256})@/g;

/** 规则 ③d：`sshpass -p <口令>`（明文传口令的最常见写法）。 */
const SSHPASS_FLAG =
  /((?:^|[\s"'`])sshpass\s+-p\s*)(?:"([^"\n]{2,})"|'([^'\n]{2,})'|`([^`\n]{2,})`|([^\s"'`]{2,}))/gi;

/**
 * 规则 ③e：裸的密码形态 `字母@数字…`，且 `@` 之后没有点。
 * 邮箱（`a@b.com`）与 `user@host` / `root@10.1.1.1` 都带点，因此被排除；
 * 真实案例里的 `eds@1234sangfornetwork` 正是这种形态。
 */
const BARE_AT_TOKEN = /\b([A-Za-z][A-Za-z0-9_.+-]{0,63}@\d[A-Za-z0-9_@+-]{2,63})\b/g;

/**
 * 规则 ③f：正文里出现的已知前缀凭据（`sk-…` / `AKIA…` / `ghp_…` /
 * `xox?-…` / `AIza…` / `Bearer <token>`）。规则 ① 只判「整串就是凭据」，
 * 会话正文常把 key 粘在句子里，需要按 token 形态就地替换。
 * 前缀后的字符数与字符集都收紧，避免把普通单词当凭据。
 */
const PREFIX_TOKEN =
  /(?<![A-Za-z0-9])(sk-[A-Za-z0-9_-]{10,}|AKIA[A-Z0-9]{12,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,})/g;

/** `Bearer <token>`：只换 token，`Bearer ` 这个说明词保留。 */
const BEARER_TOKEN = /(\bBearer[ \t]+)([A-Za-z0-9._~+/-]{12,}=*)/g;

/** 模板插值（`${DB_PASSWORD}`）与文档占位（`<password>`）都不是字面口令。 */
function isTemplateOrDocValue(value: string): boolean {
  if (value.includes('${') || value.startsWith('${')) return true;
  return /^<[^<>]*>$/.test(value);
}

/**
 * 字符串值脱敏：
 * - 整个字符串就是凭据（规则 ①）→ 整串替换成占位符；
 * - 否则做自由文本替换（规则 ③）：把文本里锚定到的口令就地换成占位符，
 *   标签、路径、正文其余部分原样保留；
 * - 占位符本身不再命中规则（幂等：再输入一次得到同一个占位符）。
 */
export function redactString(s: string): string {
  if (s.startsWith(ASU_REDACTED_PREFIX + '.')) return s;
  if (isCredentialString(s)) return placeholderFor(s);
  return redactFreeText(s);
}

/** 规则 ③：自由文本口令替换（纯函数，确定性的就地占位）。 */
export function redactFreeText(s: string): string {
  let out = s.replace(
    KEYWORD_ASSIGN,
    (match: string, label: string, dq?: string, sq?: string, bq?: string, bare?: string) => {
      const value = firstCaptured([dq, sq, bq, bare]);
      if (value === undefined || isPlaceholder(value) || isTemplateOrDocValue(value)) return match;
      // 裸值必须自己「像凭据」；带引号的值由「锚点 + 引号」定性，纯字母口令
      // （`DB_PASSWORD: "sangfornetwork"`）也要拦住，但仍要求长度与字母。
      const quoted = dq !== undefined || sq !== undefined || bq !== undefined;
      const acceptable = quoted
        ? value.length >= 6 && /[A-Za-z]/.test(value)
        : looksLikeSecret(value);
      if (!acceptable) return match;
      const quote = quoteOf(dq, sq, bq);
      return label + quote + placeholderFor(value) + quote;
    },
  );
  out = out.replace(
    FLAG_ASSIGN,
    (match: string, label: string, dq?: string, sq?: string, bq?: string, bare?: string) => {
      const value = firstCaptured([dq, sq, bq, bare]);
      if (value === undefined || isPlaceholder(value) || isTemplateOrDocValue(value)) return match;
      if (!looksLikeSecret(value)) return match;
      const quote = quoteOf(dq, sq, bq);
      return label + quote + placeholderFor(value) + quote;
    },
  );
  out = out.replace(URL_USERINFO, (match: string, prefix: string, secret: string) => {
    if (isPlaceholder(secret)) return match;
    // 模板插值不是字面口令（如 postgres://${DB_USER}:${DB_PASSWORD:?未设置}@host），
    // 换成占位符会把配置正文改坏，跳过。
    if (/[$]/.test(secret) || /[{}]/.test(secret)) return match;
    // URL 里的口令不需要「像凭据」：位置本身已足够明确。
    return prefix + placeholderFor(secret) + '@';
  });
  out = out.replace(
    SSHPASS_FLAG,
    (match: string, label: string, dq?: string, sq?: string, bq?: string, bare?: string) => {
      const value = firstCaptured([dq, sq, bq, bare]);
      if (value === undefined || isPlaceholder(value) || isTemplateOrDocValue(value)) return match;
      const quote = quoteOf(dq, sq, bq);
      return label + quote + placeholderFor(value) + quote;
    },
  );
  out = out.replace(
    PREFIX_TOKEN,
    (match: string, token: string) => (isPlaceholder(token) ? match : placeholderFor(token)),
  );
  out = out.replace(
    BEARER_TOKEN,
    (match: string, label: string, token: string) =>
      isPlaceholder(token) ? match : label + placeholderFor(token),
  );
  out = out.replace(
    BARE_AT_TOKEN,
    (match: string, token: string, offset: number, whole: string) => {
      const at = token.indexOf('@');
      const accountPart = token.slice(0, at);
      const hostPart = token.slice(at + 1);
      if (hostPart.includes('.') || isPlaceholder(token)) return match;
      // 邮箱前缀被截断的情形：命中恰好在 '@' 后紧跟 '.'（如 a@123.com 命中 a@123）时不动。
      if (whole[offset + token.length] === '.') return match;
      // 反例：npm 临时目录名 `@scope-2+3-3-4@0_32` 之类会被裸 @ 规则误伤，
      // 而它是要保留的路径。收紧成「账号段不含 '+'、主机段含字母」才认。
      if (accountPart.includes('+')) return match;
      if (!/^[A-Za-z0-9_-]+$/.test(hostPart) || !/[A-Za-z]/.test(hostPart)) return match;
      if (!looksLikeSecret(token)) return match;
      return placeholderFor(token);
    },
  );
  return out;
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
 * - 普通字段中的字符串值仍走 redactString（规则 ①/③ 独立生效）；
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
