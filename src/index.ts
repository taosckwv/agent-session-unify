/**
 * 命令行入口：`parse` 命令 + 编排 + 终端摘要（DESIGN §4.3/§7/§11、t1 §2 契约、
 * 裁决 R8/R10、t9/t10 交接）。
 *
 * 流水线（DESIGN §4）：路径分派（.zstd → DSH、.jsonl → CC；目录按内容取文件）
 *   → 解析器产会话树（dsh/parse、cc/parse）
 *   → 组装层 buildSpans（脱敏唯一入口，字段三去向，时间回填）
 *   → serializeTracesData（键序固定）→ writeSessionFile（<out>/<tool>/<id>__<agent>.json）
 *   → 终端摘要（每会话 step 数/工具数/跳过与丢弃计数；R10 空树标 [empty]）。
 *
 * 退出码（R8）：
 * - 0 = 全部成功，或部分成功（单文件失败不中断整批，错误树照常落盘可对账）；
 * - 1 = 全部会话解析/写盘失败（没有任何成功产出）；
 * - 2 = 输入/用法错误（路径不存在、扩展名无法分派、参数缺失）。
 *
 * 交接约束：t9 —— CC 解析器已在 agentLabel 层做 sidechain 唯一化，本层直接用
 * parser 给的 label 生成文件名与 span key，不加二次后缀（避免双重消歧）；
 * t10 —— Stats.usageSnapshots 已是正式字段，spanBuilder 全字段兜底自动落盘。
 *
 * 确定性（DESIGN §10）：本模块不读时钟/随机/locale；输出文件字节由
 * ids/spanBuilder/otlp 的确定性保证，本层只做编排，顺序 = 路径给定顺序。
 *
 * 用法（DESIGN §7）：`parse <文件或目录路径...> [--out <目录>]`（默认 data/unified/）。
 * 纯手动传路径：不做自动发现、不主动扫盘；目录参数只取其直接子文件里的会话文件
 * （DSH 按 DESIGN §5 只读最高 vN）。
 */

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseCcSession } from './cc/parse.js';
import { buildSpans } from './core/spanBuilder.js';
import { serializeTracesData, writeSessionFile } from './core/otlp.js';
import { parseDshSessions, pickHighestVersionSessionFile, sessionFileVersion } from './dsh/parse.js';
import { emptyStats, type SessionNode } from './core/model.js';

/** CLI 版本（package.json version 的镜像；tests/smoke.test.ts 断言其形状）。 */
export const VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// 常量（t1 检查单：魔数具名 + 出处）
// ---------------------------------------------------------------------------

/** 默认输出目录（DESIGN §7：data/unified/，已在 .gitignore）。 */
export const DEFAULT_OUT_DIR = 'data/unified';

/** 退出码：成功（含 R8 部分成功）。 */
export const EXIT_OK = 0;
/** 退出码：输入/用法错误（路径不存在、无法分派、参数缺失）。 */
export const EXIT_INPUT_ERROR = 2;
/** 退出码：全部会话解析/写盘失败（R8：全失败才非 0）。 */
export const EXIT_PARSE_ERROR = 1;

/** DSH 容器文件扩展名。 */
const DSH_EXTENSION = '.zstd';
/** CC 会话文件扩展名。 */
const CC_EXTENSION = '.jsonl';

/** 同名冲突后缀起点（otlp.ts sanitizeFileComponent 钦定本层兜底）。 */
const NAME_COLLISION_SUFFIX_START = 2;

/** 终端摘要里「跳过」字段的语义名（§7 摘要行：跳过与丢弃计数）。 */
const SUMMARY_LABELS = {
  dshTool: 'dsh',
  ccTool: 'claude-code',
} as const;

// ---------------------------------------------------------------------------
// 参数解析（纯函数，可单测）
// ---------------------------------------------------------------------------

/** 参数解析成功形态。 */
interface ParsedArgs {
  ok: true;
  /** 会话文件/目录路径（原样，未展开）。 */
  paths: string[];
  /** 输出目录。 */
  outDir: string;
}

/** 参数解析失败形态。 */
interface ParsedArgsError {
  ok: false;
  /** 面向终端的用法/错误信息。 */
  message: string;
}

/** 解析 argv（不含 node/脚本名）：`parse <paths...> [--out <dir>]`。 */
export function parseCliArgs(argv: readonly string[]): ParsedArgs | ParsedArgsError {
  const command = argv[0];
  if (command === undefined) {
    return { ok: false, message: '缺少命令：用法 parse <文件或目录路径...> [--out <目录>]' };
  }
  if (command !== 'parse') {
    return { ok: false, message: `未知命令：${command}（V1 只有 parse）` };
  }

  const paths: string[] = [];
  let outDir: string | undefined;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--out') {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ok: false, message: '--out 缺少目录参数' };
      }
      if (outDir !== undefined) {
        return { ok: false, message: '--out 只能指定一次' };
      }
      outDir = value;
      i += 1;
    } else if (arg.startsWith('--out=')) {
      if (outDir !== undefined) {
        return { ok: false, message: '--out 只能指定一次' };
      }
      outDir = arg.slice('--out='.length);
    } else if (arg.startsWith('--')) {
      return { ok: false, message: `未知参数：${arg}（只支持 --out）` };
    } else {
      paths.push(arg);
    }
  }

  if (paths.length === 0) {
    return { ok: false, message: '至少提供一个文件或目录路径' };
  }
  return { ok: true, paths, outDir: outDir ?? DEFAULT_OUT_DIR };
}

// ---------------------------------------------------------------------------
// 路径分派（按扩展名与内容；目录只看直接子文件，不递归）
// ---------------------------------------------------------------------------

/** 一个输入路径展开后的分派组（目录可能同时产出 DSH 组与 CC 组）。 */
interface DispatchGroup {
  kind: 'dsh' | 'cc';
  files: string[];
}

/** 一个输入路径的展开结果：0..n 个分派组，或一条输入错误。 */
interface DispatchResult {
  groups: DispatchGroup[];
  error?: string;
}

/**
 * 把一个调用方给的路径展开成分派组。
 * - 文件：按扩展名分派（.zstd → DSH、.jsonl → CC、其他 → 输入错误）；
 * - 目录：目录内直接子文件里，`session.v*.jsonl.zstd` 归 DSH（§5 只读最高 vN，
 *   由 dsh/parse 的 resolveSessionInput 处理），其余 `*.jsonl` 归 CC（含
 *   `.orphaned-*`/`.superseded-*`，由 cc/parse 整文件计跳过，R7）；都不存在 → 错误。
 * - 路径不存在 → 输入错误（R8 归 2 类）。
 */
function dispatchInput(path: string): DispatchResult {
  if (!existsSync(path)) {
    return { groups: [], error: `路径不存在：${path}` };
  }
  const info = statSync(path);
  if (info.isFile()) {
    const ext = extname(path).toLowerCase();
    if (ext === DSH_EXTENSION) return { groups: [{ kind: 'dsh', files: [path] }] };
    if (ext === CC_EXTENSION) return { groups: [{ kind: 'cc', files: [path] }] };
    return { groups: [], error: `无法分派的文件扩展名（仅 .zstd/.jsonl）：${path}` };
  }
  if (info.isDirectory()) {
    const dshFiles: string[] = [];
    const ccFiles: string[] = [];
    const names = readdirSync(path).sort(); // 字典序：确定性顺序
    for (const name of names) {
      const entry = join(path, name);
      if (!statSync(entry).isFile()) continue; // 目录参数不递归（§7 纯手动）
      if (sessionFileVersion(name) !== undefined) {
        dshFiles.push(entry);
      } else if (extname(name).toLowerCase() === CC_EXTENSION) {
        ccFiles.push(entry);
      }
    }
    if (dshFiles.length === 0 && ccFiles.length === 0) {
      return { groups: [], error: `目录内没有会话文件（.zstd/.jsonl）：${path}` };
    }
    // 混合目录：DSH 文件与 CC 文件各自成组。DSH 组先做「只读最高 vN」
    // （DESIGN §5）：目录里的 session.v*.jsonl.zstd 是同一会话的版本演进，
    // 交最高版给解析器；CC 组按文件各自成树（.orphaned-*/.superseded-* 由
    // cc/parse 整文件计跳过，R7）。
    const groups: DispatchGroup[] = [];
    if (dshFiles.length > 0) {
      const best = pickHighestVersionSessionFile(dshFiles);
      groups.push({ kind: 'dsh', files: best !== undefined ? [best] : dshFiles });
    }
    if (ccFiles.length > 0) groups.push({ kind: 'cc', files: ccFiles });
    return { groups };
  }
  return { groups: [], error: `既不是文件也不是目录：${path}` };
}

// ---------------------------------------------------------------------------
// 编排（纯函数返回结构化结果，main 只做终端接线）
// ---------------------------------------------------------------------------

/** 一个会话的终端摘要行 + 落盘信息。 */
export interface SessionSummary {
  /** 解析器身份（文件名用）。 */
  tool: 'dsh' | 'claude-code';
  /** 输出文件名主体（<sessionId>__<agentLabel>，t9：直接用解析器 label）。 */
  sessionId: string;
  agentLabel: string;
  /** step 数（跨全部 turn）。 */
  steps: number;
  /** 工具数（跨全部 step）。 */
  tools: number;
  /** 跳过/丢弃计数（skippedRecords + badLines）。 */
  skippedRecords: number;
  /** 丢弃的 v3 会话数（R5）。 */
  skippedV3: number;
  /** 未识别事件类型种数（§11 清单长度）。 */
  unknownEventTypes: number;
  /** 单文件级解析错误（R8 计 parseErrors）。 */
  parseErrors: number;
  /** 空树（0 step，R10：终端标 [empty]）。 */
  empty: boolean;
  /** 完整摘要行（断言与终端共用一份文案）。 */
  line: string;
  /** 落盘路径（写盘失败时 undefined）。 */
  file: string | undefined;
}

/** runParse 的结构化结果（main 据此打印与退出）。 */
export interface ParseRunResult {
  /** 退出码（R8 三态）。 */
  exitCode: number;
  /** 每会话摘要（按输入顺序）。 */
  sessions: SessionSummary[];
  /** 成功写盘的会话数。 */
  successCount: number;
  /** 解析/写盘失败的会话数（含错误树）。 */
  parseFailureCount: number;
  /** 输入错误（路径/分派）条数。 */
  inputErrorCount: number;
  /** 错误行（[输入错误]/[解析失败]/[输出失败]，stderr 用）。 */
  errorLines: string[];
  /** 全部终端行（stdout：会话摘要 + 汇总行）。 */
  lines: string[];
  /** 实际写出的文件路径。 */
  writtenFiles: string[];
}

/** 数会话树里 step 与 tool 总数。 */
function countStepsAndTools(tree: SessionNode): { steps: number; tools: number } {
  let steps = 0;
  let tools = 0;
  for (const turn of tree.turns) {
    steps += turn.steps.length;
    for (const step of turn.steps) tools += step.tools.length;
  }
  return { steps, tools };
}

/** 组一行会话摘要（§7/§11：step 数、工具数、跳过与丢弃计数；R10 [empty]）。 */
function sessionSummaryLine(
  tool: 'dsh' | 'claude-code',
  sessionId: string,
  agentLabel: string,
  steps: number,
  tools: number,
  stats: {
    skippedRecords: number;
    skippedV3: number;
    unknownEventTypes: number;
    parseErrors: number;
  },
  empty: boolean,
): string {
  const head = `[${tool === 'dsh' ? SUMMARY_LABELS.dshTool : SUMMARY_LABELS.ccTool}] ${sessionId}__${agentLabel}`;
  const counts = `${steps}步/${tools}工具`;
  const parts = [
    `跳过=${stats.skippedRecords}`,
    stats.skippedV3 > 0 ? `v3=${stats.skippedV3}` : '',
    `未识别=${stats.unknownEventTypes}`,
    stats.parseErrors > 0 ? `解析错误=${stats.parseErrors}` : '',
    empty ? '[empty]' : '',
  ].filter((p) => p !== '');
  return `${head}：${counts}，${parts.join(' ')}`;
}

/** 错误信息提取（任意 throw 值 → 单行文本，不带堆栈避免终端噪音）。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** 失败树的错误摘要（extras.parse_error 原文；无则用统计兜底）。 */
function parseErrorText(tree: SessionNode): string {
  const raw = tree.extras['parse_error'];
  if (raw !== undefined && typeof raw === 'object' && raw !== null) {
    const message = (raw as Record<string, unknown>)['message'];
    if (typeof message === 'string') return message;
  }
  return `parseErrors=${tree.stats.parseErrors}（无错误详情）`;
}

/**
 * 跑一轮解析（不碰终端：返回结构化结果，main 负责打印）。
 * R8：单文件失败不中断整批——DSH 侧 parseDshSessions 自带隔离（IO 失败产占位
 * 错误树）；CC 侧在本层逐文件 try/catch 产占位错误树。两者错误树都照常写盘。
 */
export function runParse(paths: readonly string[], outDir: string): ParseRunResult {
  const sessions: SessionSummary[] = [];
  const errorLines: string[] = [];
  const lines: string[] = [];
  const writtenFiles: string[] = [];
  const usedNames = new Map<string, string>(); // 净化后的 <tool>/<base>.json → 实际相对名
  let successCount = 0;
  let parseFailureCount = 0;
  let inputErrorCount = 0;

  const emitSession = (tree: SessionNode, hasError: boolean): void => {
    const { steps, tools } = countStepsAndTools(tree);
    const stats = {
      skippedRecords: tree.stats.skippedRecords,
      skippedV3: tree.stats.skippedV3,
      unknownEventTypes: Object.keys(tree.stats.unknownEventTypes).length,
      parseErrors: tree.stats.parseErrors,
    };
    const empty = steps === 0;
    const line = sessionSummaryLine(
      tree.tool,
      tree.sessionId,
      tree.agentLabel,
      steps,
      tools,
      stats,
      empty,
    );
    const summary: SessionSummary = {
      tool: tree.tool,
      sessionId: tree.sessionId,
      agentLabel: tree.agentLabel,
      steps,
      tools,
      skippedRecords: stats.skippedRecords,
      skippedV3: stats.skippedV3,
      unknownEventTypes: stats.unknownEventTypes,
      parseErrors: stats.parseErrors,
      empty,
      line,
      file: undefined,
    };

    // 组装 + 写盘。写盘失败：计 [输出失败]，会话仍进摘要（file=undefined）。
    // R8 失败树（parseErrors>0）额外加 [解析失败] 行（dsh 占位树/ccErrorTree）。
    try {
      const json = serializeTracesData(buildSpans(tree));
      const dirKey = tree.tool;
      const base = `${sanitize(tree.sessionId)}__${sanitize(tree.agentLabel)}`;
      let actualBase = `${base}.json`;
      if (usedNames.has(`${dirKey}/${actualBase}`)) {
        // otlp.ts 净化撞名兜底：-2 递增后缀（确定性：按出现顺序）。
        // writeSessionFile 只认未净化 id 组名，冲突时本层直接按兜底名写盘
        // （目录结构与净化规则与 writeSessionFile 完全一致）。
        let suffix = NAME_COLLISION_SUFFIX_START;
        while (usedNames.has(`${dirKey}/${base}-${suffix}.json`)) suffix += 1;
        actualBase = `${base}-${suffix}.json`;
      }
      usedNames.set(`${dirKey}/${actualBase}`, actualBase);

      let written: string;
      if (actualBase === `${base}.json`) {
        written = writeSessionFile(outDir, tree.tool, tree.sessionId, tree.agentLabel, json);
      } else {
        // 撞名兜底路径：writeSessionFile 无法表达 -N 名，本层按同规则写。
        const dir = join(outDir, sanitize(tree.tool));
        mkdirSync(dir, { recursive: true });
        written = join(dir, actualBase);
        writeFileSync(written, json, 'utf8');
      }
      summary.file = written;
      writtenFiles.push(written);
      if (hasError) {
        parseFailureCount += 1;
        errorLines.push(
          `[解析失败] ${tree.tool} ${tree.sessionId}__${tree.agentLabel}：` +
            `${parseErrorText(tree)}（已写仅统计文件）`,
        );
      } else {
        successCount += 1;
      }
    } catch (error) {
      parseFailureCount += 1;
      errorLines.push(`[输出失败] ${tree.tool} ${tree.sessionId}__${tree.agentLabel}：${errorMessage(error)}`);
    }
    sessions.push(summary);
    lines.push(line);
  };

  for (const path of paths) {
    const dispatch = dispatchInput(path);
    if (dispatch.error !== undefined) {
      inputErrorCount += 1;
      errorLines.push(`[输入错误] ${dispatch.error}`);
      continue;
    }
    for (const group of dispatch.groups) {
      if (group.kind === 'dsh') {
        // parseDshSessions：镜像分组 + (sessionId,seq) 去重 + IO 失败占位错误树（R8 内建）
        for (const tree of parseDshSessions(group.files)) {
          emitSession(tree, tree.stats.parseErrors > 0);
        }
      } else {
        for (const file of group.files) {
          let tree: SessionNode;
          try {
            tree = parseCcSession(file);
          } catch (error) {
            // R8：读失败产占位错误树（与 dsh/parse 的 buildFileErrorTree 同口径）
            tree = ccErrorTree(file, error);
          }
          emitSession(tree, tree.stats.parseErrors > 0);
        }
      }
    }
  }

  // 汇总行（§7）
  lines.push(`完成：${sessions.length} 个会话、写入 ${writtenFiles.length} 个文件`);

  // 退出码三态（R8）：
  // - 无任何会话产出：纯输入错误（或什么都没有）→ 2；
  // - 有会话但全部失败（successCount=0，只剩错误树）→ 1；
  // - 其余（含部分成功）→ 0。
  if (sessions.length === 0) {
    return {
      exitCode: EXIT_INPUT_ERROR,
      sessions,
      successCount,
      parseFailureCount,
      inputErrorCount,
      errorLines,
      lines,
      writtenFiles,
    };
  }
  if (successCount === 0) {
    return {
      exitCode: EXIT_PARSE_ERROR,
      sessions,
      successCount,
      parseFailureCount,
      inputErrorCount,
      errorLines,
      lines,
      writtenFiles,
    };
  }
  return {
    exitCode: EXIT_OK,
    sessions,
    successCount,
    parseFailureCount,
    inputErrorCount,
    errorLines,
    lines,
    writtenFiles,
  };
}

/** CC 读失败的占位错误树（与 dsh/parse.buildFileErrorTree 同口径，R8）。 */
function ccErrorTree(file: string, error: unknown): SessionNode {
  const stats = emptyStats();
  stats.producedSpans = 1; // 错误树仍有会话根 span（统计要挂根）
  stats.parseErrors = 1;
  const name = basename(file);
  const stem = name.replace(/\.jsonl$/i, '');
  return {
    sourceRefs: [],
    extras: { parse_error: { path: file, message: errorMessage(error) } },
    tool: 'claude-code',
    sessionId: stem.length > 0 ? stem : name,
    agentLabel: 'main',
    turns: [],
    stats,
  };
}

/** 文件名部件净化（与 core/otlp.sanitizeFileComponent 同规则的本地副本，见下注）。 */
function sanitize(component: string): string {
  const replaced = component.replace(/[^A-Za-z0-9._-]/g, '_');
  return replaced === '.' || replaced === '..' ? `_${replaced}` : replaced;
}

// ---------------------------------------------------------------------------
// main：终端接线（唯一碰 console/exit 的地方）
// ---------------------------------------------------------------------------

/** 主入口：argv（不含 node/脚本名）→ 退出码。打印会话摘要（stdout）与错误（stderr）。 */
export function main(argv: readonly string[]): number {
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    console.error(parsed.message);
    return EXIT_INPUT_ERROR;
  }

  const result = runParse(parsed.paths, parsed.outDir);
  for (const line of result.errorLines) console.error(line);
  for (const line of result.lines) console.log(line);
  return result.exitCode;
}

// 直接执行（node dist/index.js / tsx src/index.ts）时跑 main。
// 比较用 node:url 的 pathToFileURL：Windows 盘符路径会得到 file:///D:/… 形态
// （含百分号编码），朴素 `file://${path}` 模板串永远不等，守卫会失效；
// vitest 下 argv[1] 是 vitest 自身路径 → 不相等 → 不触发（smoke 兼容）。
// 用 process.exitCode 而非 process.exit：避免截断尚未冲刷的 stdout 管道。
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = main(process.argv.slice(2));
}
