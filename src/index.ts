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
 * 纯手动传路径：不做自动发现、不主动扫盘；目录参数**递归**展开，会话文件
 * （DSH `.zstd`、CC `.jsonl`）与归档（`.tar.zst`/`.tar.gz`/`.tgz`/`.tar`）都收；
 * 归档先解到临时目录再扫，DSH 按「同一目录只读最高 vN」分组（DESIGN §5），
 * 扁平命名（`session-<uuid>.jsonl.zstd` / `<uuid>.jsonl.zstd`）的文件各算一个会话。
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseCcSession } from './cc/parse.js';
import { buildSpans } from './core/spanBuilder.js';
import {
  ArchiveExtractionError,
  extractArchive,
  isArchivePath,
  type ArchivePartialStats,
} from './core/archive.js';
import { serializeTracesData, writeSessionFile } from './core/otlp.js';
import {
  isDshSessionContainer,
  parseDshSessions,
  pickHighestVersionSessionFile,
  sessionFileVersion,
} from './dsh/parse.js';
import { emptyStats, asSessionSource, type SessionNode, type SessionSource } from './core/model.js';

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

/** 目录递归深度上限（防止符号链接环/异常深目录；正常会话远小于此）。 */
const MAX_WALK_DEPTH = 64;

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
// 路径分派（按扩展名与内容；目录递归展开）
// ---------------------------------------------------------------------------

/**
 * 一个输入路径展开后的分派组（目录可能同时产出 DSH 组与 CC 组）。
 * 文件用 `SessionSource`：物理路径读盘，逻辑路径进输出（R4），归档成员因此
 * 不会把 mkdtemp 临时目录写进结果。
 */
interface DispatchGroup {
  kind: 'dsh' | 'cc';
  files: SessionSource[];
}

/** 一个归档的终端对账信息（R13：条目数不再丢弃）。 */
export interface ArchiveReport {
  /** 归档的逻辑路径（输出用；不含临时目录）。 */
  logicalPath: string;
  /** 解出的 `.jsonl` 数。 */
  extracted: number;
  /** 跳过的条目数（非会话文件、目录、链接等）。 */
  skippedEntries: number;
  /**
   * 归档内内容条目总数（不含 PAX/GNU 扩展头）= 解出 + 跳过，
   * 终端摘要按此对账（t6 F1）。
   */
  entries: number;
  /** 解包失败：此时上面三项是已读到的部分统计（t5 对账）。 */
  failed?: boolean;
}

/** 一个输入路径的展开结果：0..n 个分派组、0..n 个归档报告、0..n 条输入错误。 */
interface DispatchResult {
  groups: DispatchGroup[];
  archives: ArchiveReport[];
  errors: string[];
  /** 因「已处理过」而跳过的归档数（重复参数去重，不重复计数，t5 D2）。 */
  skippedDuplicates?: number;
}

/** 目录递归扫描的中间结果。 */
interface CollectedSessions {
  /** 逻辑目录 → 该目录下的 DSH 会话容器（版本化只取最高 vN；扁平命名各算一个）。 */
  dshByDir: Map<string, SessionSource[]>;
  /** CC 会话文件（每个文件各自成树）。 */
  ccFiles: SessionSource[];
  /** 扫描到的归档，稍后解包。 */
  archives: SessionSource[];
}

function emptyCollected(): CollectedSessions {
  return { dshByDir: new Map(), ccFiles: [], archives: [] };
}

/**
 * 递归收集目录下的会话文件与归档。
 * - 不跟符号链接（避免环、避免把链接目标写出去）；
 * - 字典序展开，保证确定性；
 * - 归档先只记路径，由调用方统一解包（解包要临时目录）；
 * - `logicalArchive` 用于归档解出的临时目录：成员逻辑路径为
 *   `` `${归档参数}!/${成员相对路径}` ``，物理临时前缀不参与任何输出（R4）。
 */
function walkSessions(
  root: string,
  collected: CollectedSessions,
  depth: number,
  logicalArchive?: string,
  memberPrefix = '',
): void {
  if (depth > MAX_WALK_DEPTH) return;
  const names = readdirSync(root).sort();
  for (const name of names) {
    const entry = join(root, name);
    let info;
    try {
      info = lstatSync(entry);
    } catch {
      continue; // 坏链接/权限问题：跳过单个条目，不中断整棵树
    }
    if (info.isSymbolicLink()) continue;
    const member = `${memberPrefix}${name}`;
    const logical =
      logicalArchive === undefined ? entry : `${logicalArchive}!/${member}`;
    if (info.isDirectory()) {
      walkSessions(entry, collected, depth + 1, logicalArchive, `${member}/`);
      continue;
    }
    if (!info.isFile()) continue;
    if (isArchivePath(name)) {
      collected.archives.push({ physicalPath: entry, logicalPath: logical });
    } else if (isDshSessionContainer(name)) {
      // 容器判定只看 `.jsonl.zstd` 后缀：版本化（session.vN）与扁平（<uuid>）都收，
      // 版本/折叠规则留到 buildGroups 按目录处理。
      // 分组键也用逻辑目录：物理临时目录名每次都不同，不能进排序。
      const dirKey =
        logicalArchive === undefined ? root : `${logicalArchive}!/${memberPrefix}`;
      const files = collected.dshByDir.get(dirKey) ?? [];
      files.push({ physicalPath: entry, logicalPath: logical });
      collected.dshByDir.set(dirKey, files);
    } else if (extname(name).toLowerCase() === CC_EXTENSION) {
      collected.ccFiles.push({ physicalPath: entry, logicalPath: logical });
    }
  }
}

/**
 * 把收集到的文件变成分派组。
 *
 * DSH 按目录分组（DESIGN §5），目录内再按命名布局分流：
 * - 版本化 `session.vN.jsonl.zstd`：同一目录只读最高 vN（不同目录可能是不同会话，
 *   不能全局只留一个最高版本）；
 * - 扁平 `session-<uuid>.jsonl.zstd` / `<uuid>.jsonl.zstd`：一个文件就是一个独立会话，
 *   全部保留、**不折叠**（导出 dump 的布局）；
 * - 两种混放时各按各自的规则处理（版本化折叠成一个，扁平的照收）。
 *
 * 排序键一律用逻辑路径（R4 确定性）。
 */
function buildGroups(collected: CollectedSessions): DispatchGroup[] {
  const groups: DispatchGroup[] = [];
  const dshFiles: SessionSource[] = [];
  for (const dir of [...collected.dshByDir.keys()].sort()) {
    const files = collected.dshByDir.get(dir) as SessionSource[];
    const byLogical = new Map(files.map((file) => [file.logicalPath, file]));
    const best = pickHighestVersionSessionFile(files.map((file) => file.logicalPath));
    const versioned = best !== undefined ? byLogical.get(best) : undefined;
    if (versioned !== undefined) dshFiles.push(versioned);
    const flat = files
      .filter((file) => sessionFileVersion(file.logicalPath) === undefined)
      .sort((a, b) =>
        a.logicalPath < b.logicalPath ? -1 : a.logicalPath > b.logicalPath ? 1 : 0,
      );
    dshFiles.push(...flat);
  }
  if (dshFiles.length > 0) groups.push({ kind: 'dsh', files: dshFiles });
  if (collected.ccFiles.length > 0) {
    const sorted = [...collected.ccFiles].sort((a, b) =>
      a.logicalPath < b.logicalPath ? -1 : a.logicalPath > b.logicalPath ? 1 : 0,
    );
    groups.push({ kind: 'cc', files: sorted });
  }
  return groups;
}

/**
 * 解包一个归档到临时目录，再按目录规则收集。
 *
 * 归档里套归档**不展开**：`extractArchive` 只把 `.jsonl` 写到临时目录
 * （`core/archive.ts` 的 parseTar 对其余条目只计数），内层归档条目根本不会
 * 落盘，所以递归展开是死代码（R12 裁决，已核实）。内层归档按「非会话条目」
 * 跳过并计入 `skippedEntries`，在终端摘要里可对账。
 *
 * 解出的临时目录登记到 tempDirs，由 runParse 收尾删除；错误文本与返回的
 * 逻辑路径都不含临时目录名（R4/R7）。
 */
function expandArchive(
  archive: SessionSource,
  tempDirs: string[],
  seenArchives: Set<string>,
): DispatchResult {
  // 同一归档（含相对/绝对两种写法）只解一次：重复参数不重复计数、不重复出
  // `[归档]` 行、不产生 `-2` 文件（t5 D2）。
  const archiveKey = canonicalPath(archive.physicalPath);
  if (seenArchives.has(archiveKey)) {
    return { groups: [], archives: [], errors: [], skippedDuplicates: 1 };
  }
  seenArchives.add(archiveKey);

  let tempDir: string;
  try {
    tempDir = mkdtempSync(join(tmpdir(), 'asu-archive-'));
  } catch (error) {
    return {
      groups: [],
      archives: [
        {
          logicalPath: archive.logicalPath,
          extracted: 0,
          skippedEntries: 0,
          entries: 0,
          failed: true,
        },
      ],
      errors: [
        `无法创建解包临时目录：${errorMessage(error)}（${archive.logicalPath}）`,
      ],
    };
  }
  tempDirs.push(tempDir);

  let extracted: { files: string[]; skippedEntries: number; entries: number };
  try {
    extracted = extractArchive(archive.physicalPath, tempDir, {
      displayPath: archive.logicalPath,
    });
  } catch (error) {
    // 解包失败也打印 `[归档]` 对账行：带上已读到的部分统计（t5）。
    const partial: ArchivePartialStats | undefined =
      error instanceof ArchiveExtractionError ? error.partial : undefined;
    return {
      groups: [],
      archives: [
        {
          logicalPath: archive.logicalPath,
          extracted: partial?.extracted ?? 0,
          skippedEntries: partial?.skippedEntries ?? 0,
          entries: partial?.entries ?? 0,
          failed: true,
        },
      ],
      errors: [
        error instanceof ArchiveExtractionError
          ? error.message
          : errorMessage(error),
      ],
    };
  }
  const report: ArchiveReport = {
    logicalPath: archive.logicalPath,
    extracted: extracted.files.length,
    skippedEntries: extracted.skippedEntries,
    entries: extracted.entries,
  };

  const collected = emptyCollected();
  try {
    walkSessions(tempDir, collected, 0, archive.logicalPath);
  } catch (error) {
    return {
      groups: [],
      archives: [report],
      errors: [
        `归档解出后扫描失败（${archive.logicalPath}）：${errorMessage(error)}`,
      ],
    };
  }

  const groups = buildGroups(collected);
  const errors: string[] = [];
  if (groups.length === 0) {
    errors.push(
      `归档内没有 .jsonl 会话文件（归档只展开 .jsonl，DSH .zstd 会话不在支持范围）：${archive.logicalPath}`,
    );
  }
  return { groups, archives: [report], errors };
}

/** 目录输入：递归扫描 + 解包目录内归档。 */
function dispatchDirectory(
  dir: string,
  tempDirs: string[],
  seenArchives: Set<string>,
): DispatchResult {
  const collected = emptyCollected();
  try {
    walkSessions(dir, collected, 0);
  } catch (error) {
    return {
      groups: [],
      archives: [],
      errors: [`目录扫描失败（${dir}）：${errorMessage(error)}`],
    };
  }
  const groups = buildGroups(collected);
  const archives: ArchiveReport[] = [];
  const errors: string[] = [];
  let skippedDuplicates = 0;
  for (const archive of collected.archives) {
    const expanded = expandArchive(archive, tempDirs, seenArchives);
    groups.push(...expanded.groups);
    archives.push(...expanded.archives);
    errors.push(...expanded.errors);
    skippedDuplicates += expanded.skippedDuplicates ?? 0;
  }
  if (groups.length === 0 && errors.length === 0 && skippedDuplicates === 0) {
    errors.push(`目录内没有会话文件（*.jsonl.zstd / *.jsonl 或 .tar.zst 等归档）：${dir}`);
  }
  return { groups, archives, errors, skippedDuplicates };
}

/**
 * 把一个调用方给的路径展开成分派组。
 * - 文件：归档 → 解包后递归收集；`.zstd` → DSH；`.jsonl` → CC；其他 → 输入错误；
 * - 目录：递归收集（DSH 同一目录只读最高 vN；CC 每文件各自成树；
 *   归档解包后再收集），一个会话文件都没有 → 错误；
 * - 路径不存在/不是文件也不是目录 → 输入错误（R8 归 2 类）。
 */
function dispatchInput(
  path: string,
  tempDirs: string[],
  seenArchives: Set<string>,
): DispatchResult {
  if (!existsSync(path)) {
    return { groups: [], archives: [], errors: [`路径不存在：${path}`] };
  }
  let info;
  try {
    info = statSync(path);
  } catch (error) {
    return {
      groups: [],
      archives: [],
      errors: [`无法读取路径（${path}）：${errorMessage(error)}`],
    };
  }
  if (info.isFile()) {
    const source = asSessionSource(path);
    if (isArchivePath(path)) return expandArchive(source, tempDirs, seenArchives);
    const ext = extname(path).toLowerCase();
    if (ext === DSH_EXTENSION) {
      return { groups: [{ kind: 'dsh', files: [source] }], archives: [], errors: [] };
    }
    if (ext === CC_EXTENSION) {
      return { groups: [{ kind: 'cc', files: [source] }], archives: [], errors: [] };
    }
    return {
      groups: [],
      archives: [],
      errors: [`无法分派的文件扩展名（仅 .zstd/.jsonl/.tar.zst 等归档）：${path}`],
    };
  }
  if (info.isDirectory()) return dispatchDirectory(path, tempDirs, seenArchives);
  return { groups: [], archives: [], errors: [`既不是文件也不是目录：${path}`] };
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

/**
 * 物理路径规范化键：realpath（Windows 大小写/短名也算同一文件）。realpath 失败
 * 就按原路径，让解析器按自己的口径报错并产错误树。
 */
function canonicalPath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return filePath;
  }
}

/**
 * 命令行参数全局去重（t5 D2）：同一路径（含相对/绝对写法）只展开一次。
 * 保留首次出现的写法与顺序，输出因此仍由输入顺序决定（DESIGN §10）。
 * 去掉的重复参数数一并返回，终端要报出来（t6 F9：去重不该是静默行为）。
 */
function uniquePaths(paths: readonly string[]): { paths: string[]; skipped: number } {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    const key = canonicalPath(path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return { paths: out, skipped: paths.length - out.length };
}

/**
 * 去掉重复文件：同一文件被多个参数/目录扫到，或解包后与直接传入重合时只解析一次。
 * 去重键用物理路径的 realpath（Windows 大小写/短名也算同一文件）；realpath 失败就按
 * 原路径。保留首个来源，逻辑路径因此取输入里第一次出现的写法（确定性，R4）。
 * `seen` 可由调用方跨组共享，做到全局只解析一次（t5 D2）。
 */
function uniqueFiles(
  files: readonly SessionSource[],
  seen: Set<string> = new Set(),
): SessionSource[] {
  const out: SessionSource[] = [];
  for (const file of files) {
    const key = canonicalPath(file.physicalPath);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(file);
  }
  return out;
}

/** 归档对账行（§11：解出数、跳过数、条目总数，三者可对账；失败也打印，t5）。 */
function archiveSummaryLine(report: ArchiveReport): string {
  if (report.failed === true) {
    // 失败行同样按「解出 + 跳过 = 已读」对账（t6 F1）：未解出的残缺条目计入跳过。
    return (
      `[归档] ${report.logicalPath}：解包失败，已解出 ${report.extracted} 个 .jsonl，` +
      `跳过 ${report.skippedEntries} 个条目（已读 ${report.entries} 条）`
    );
  }
  return (
    `[归档] ${report.logicalPath}：解出 ${report.extracted} 个 .jsonl，` +
    `跳过 ${report.skippedEntries} 个非会话条目（共 ${report.entries} 条）`
  );
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

  const tempDirs: string[] = [];
  // 全局去重（t5 D2）：重复参数/重复归档/同文件多处出现都只处理一次，统计不翻倍。
  const seenArchives = new Set<string>();
  const seenFiles = new Set<string>();
  // 因「已处理过」而跳过的重复输入数（t6 F9：只算不报会让去重不可见）。
  let skippedDuplicateCount = 0;
  try {
    // 入口参数去重也算「重复输入」（t6 F9）：同一路径传两次同样要在摘要里可见。
  const uniqueInputs = uniquePaths(paths);
  skippedDuplicateCount += uniqueInputs.skipped;
  for (const path of uniqueInputs.paths) {
      let dispatch: DispatchResult;
      try {
        dispatch = dispatchInput(path, tempDirs, seenArchives);
      } catch (error) {
        // 目录不可读等：记输入错误，不中断整批（R8 隔离口径）。
        inputErrorCount += 1;
        errorLines.push(`[输入错误] 展开失败（${path}）：${errorMessage(error)}`);
        continue;
      }
      for (const message of dispatch.errors) {
        inputErrorCount += 1;
        errorLines.push(`[输入错误] ${message}`);
      }
      skippedDuplicateCount += dispatch.skippedDuplicates ?? 0;
      // 归档对账（R13）：条目数不再丢弃，终端可核对「解出 + 跳过 = 总数」。源条目
      // 只数内容条目（不含 PAX/GNU 扩展头），见 core/archive.ts 的 entries 注释。
      for (const report of dispatch.archives) {
        lines.push(archiveSummaryLine(report));
      }
      for (const group of dispatch.groups) {
        if (group.kind === 'dsh') {
          // parseDshSessions：镜像分组 + (sessionId,seq) 去重 + IO 失败占位错误树（R8 内建）
          for (const tree of parseDshSessions(uniqueFiles(group.files, seenFiles))) {
            emitSession(tree, tree.stats.parseErrors > 0);
          }
        } else {
          for (const file of uniqueFiles(group.files, seenFiles)) {
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
  } finally {
    // 归档解出的临时目录只在本轮有效；清理失败不影响已写出的结果。
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // 忽略：临时目录残留不应让整批失败
      }
    }
  }

  // 汇总行（§7）；重复输入去重若真的发生了，先打一行让「少解析了一次」可见（t6 F9）。
  if (skippedDuplicateCount > 0) {
    lines.push(`重复输入已跳过 ${skippedDuplicateCount} 项`);
  }
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

/**
 * CC 读失败的占位错误树（与 dsh/parse.buildFileErrorTree 同口径，R8）。
 * 错误树只写逻辑路径：归档成员的 mkdtemp 目录名不得进输出（R4/R7）。
 */
function ccErrorTree(source: SessionSource, error: unknown): SessionNode {
  const stats = emptyStats();
  stats.producedSpans = 1; // 错误树仍有会话根 span（统计要挂根）
  stats.parseErrors = 1;
  const logical = source.logicalPath;
  const name = basename(logical);
  const stem = name.replace(/\.jsonl$/i, '');
  return {
    sourceRefs: [],
    extras: { parse_error: { path: logical, message: errorMessage(error) } },
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
