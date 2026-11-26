/**
 * 三件套断言助手（DESIGN §4.1/§4.5/§9、t1 裁决 R7）：两家（tests/dsh、tests/cc）
 * 引用同一份口径，断言代码只写一份。对 data/ 真实样本副本跑；目录为空自动跳过
 * 由各家的 sample-gated describe 自行处理，本文件不猜数据存在性。
 *
 * 三件套：
 * 1. 条数守恒 assertConservation —— 输入记录数 = 有归属节点引用数 + 跳过/丢弃数；
 * 2. 字段齐全 assertFieldCoverage —— 输出对照契约字段清单（SESSION_NODE_FIELD_KEYS），
 *    未识别字段只能进 extras（unknownEventTypes 点名）；
 * 3. 两次解析一致 assertDeterministic —— 同输入解析两次，序列化结果相同。
 */

import { expect } from 'vitest';
import {
  SESSION_NODE_FIELD_KEYS,
  type SessionNode,
  type StepNode,
  type ToolNode,
  type TurnNode,
} from '../src/core/model.js';

/** 四层节点计数。 */
export interface TreeNodeCounts {
  sessions: number;
  turns: number;
  steps: number;
  tools: number;
}

/** 遍历所有节点（不含会话根：callback 只收轮/步/工具；根单独数）。 */
function forEachNode(
  tree: SessionNode,
  fn: (node: TurnNode | StepNode | ToolNode) => void,
): void {
  for (const turn of tree.turns) {
    fn(turn);
    for (const step of turn.steps) {
      fn(step);
      for (const tool of step.tools) fn(tool);
    }
  }
}

/** 四层节点总数（= 产出 span 数，R7）。 */
export function countTreeNodes(tree: SessionNode): TreeNodeCounts {
  const counts: TreeNodeCounts = { sessions: 1, turns: 0, steps: 0, tools: 0 };
  forEachNode(tree, (node) => {
    if ('steps' in node) counts.turns += 1;
    else if ('tools' in node) counts.steps += 1;
    else counts.tools += 1;
  });
  return counts;
}

/** 有归属的输入记录数：全树 sourceRefs 条数之和（条数守恒的分子）。 */
export function coveredSourceRefCount(tree: SessionNode): number {
  let covered = tree.sourceRefs.length;
  forEachNode(tree, (node) => {
    covered += node.sourceRefs.length;
  });
  return covered;
}

/** 守恒对账输入。 */
export interface ConservationInput {
  /** 输入记录总数（R7 口径：DSH = 解码帧内 jsonl 行数；CC = 文件行数）。 */
  inputRecords: number;
  /** 跳过/丢弃记录数（v3 行、orphaned/superseded 文件行、镜像去重……）。 */
  skippedRecords: number;
  /** 样本/用例名，出现在失败信息里便于定位。 */
  reason: string;
}

/**
 * 断言 ① 条数守恒（R7）：有归属 + 跳过/丢弃 = 输入，一个都不许凭空消失。
 * 输入来源二选一：显式传 { inputRecords, skippedRecords }，或省略以用树内
 * stats（tree.stats.inputRecords / skippedRecords）对账。
 */
export function assertConservation(
  tree: SessionNode,
  input: Omit<ConservationInput, 'reason'> & { reason?: string } = {},
): void {
  const inputRecords =
    input.inputRecords !== undefined ? input.inputRecords : tree.stats.inputRecords;
  const skippedRecords =
    input.skippedRecords !== undefined ? input.skippedRecords : tree.stats.skippedRecords;
  const covered = coveredSourceRefCount(tree);
  const accounted = covered + skippedRecords;
  const label = input.reason ?? tree.sessionId;
  expect(
    accounted,
    `条数守恒失败 [${label}]：有归属 ${covered} + 跳过/丢弃 ${skippedRecords} = ${accounted}，输入 ${inputRecords}（差 ${inputRecords - accounted} 条去向不明）`,
  ).toBe(inputRecords);
}

/** 收集树内出现的、契约清单之外的字段（跨四层节点）。 */
function collectUnknownFields(tree: SessionNode): string[] {
  const allowed = new Set<string>(SESSION_NODE_FIELD_KEYS);
  const unknown = new Set<string>();
  const nodes: Array<Record<string, unknown>> = [
    tree as unknown as Record<string, unknown>,
    ...tree.turns,
  ];
  forEachNode(tree, (node) => nodes.push(node as unknown as Record<string, unknown>));
  for (const node of nodes) {
    for (const key of Object.keys(node)) {
      if (!allowed.has(key)) unknown.add(key);
    }
  }
  return [...unknown];
}

/**
 * 断言 ② 字段齐全（DESIGN §9）：输出逐字段对照契约清单，每个输入字段都有
 * 明确去向；未识别的事件/字段类型必须点名在 stats.unknownEventTypes（不许
 * 静默丢弃）。允许存在未识别事件（计数不猜是设计决定），但它们必须被计数。
 */
export function assertFieldCoverage(tree: SessionNode): void {
  // 契约外字段 = 违反三去向纪律（应进 extras 而不是新字段），点名报错。
  const unknownFields = collectUnknownFields(tree);
  expect(
    unknownFields,
    `字段齐全失败 [${tree.sessionId}]：树节点出现契约之外的字段（应放 extras 走 asu.*）：${unknownFields.join(', ')}`,
  ).toEqual([]);

  // 未识别事件类型被计数为正即可（0 值键是统计口径写脏了）。
  const zeroCounted = Object.entries(tree.stats.unknownEventTypes).filter(
    ([, n]) => n <= 0,
  );
  expect(
    zeroCounted,
    `字段齐全失败 [${tree.sessionId}]：unknownEventTypes 出现非正计数（应删除零值键）`,
  ).toEqual([]);
}

/** 确定性断言的序列化器：两次结果比对用（字节级由 otlp 序列化保证，这里比结构）。 */
export type TreeSerializer = (tree: SessionNode) => string;

/** 确定性断言输入。 */
export interface DeterminismOptions {
  /** 序列化方式（默认 JSON.stringify）。 */
  serialize?: TreeSerializer;
  /** 样本/用例名。 */
  reason?: string;
}

/**
 * 断言 ③ 两次解析一致（DESIGN §10）：同输入解析两次，序列化结果相同。
 * parseTree 每次调用都应独立重新解析（不缓存），本断言不猜缓存语义。
 */
export async function assertDeterministic(
  parseTree: () => SessionNode | Promise<SessionNode>,
  options: DeterminismOptions = {},
): Promise<void> {
  const serialize: TreeSerializer = options.serialize ?? ((t) => JSON.stringify(t));
  const label = options.reason ?? '未命名样本';
  const first = await parseTree();
  const second = await parseTree();
  expect(serialize(first), `两次解析不一致 [${label}]（确定性被破坏）`).toBe(
    serialize(second),
  );
}
