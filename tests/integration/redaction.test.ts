/**
 * 脱敏落盘验收（tests/integration/redaction.test.ts）。
 *
 * 验收口径（DESIGN §8 / R14）：
 * - 脱敏只在组装层做（spanBuilder 是唯一入口），dsh/cc/otlp 不 import redact；
 * - 落盘字节里不得出现真实凭据形态（sk-/AKIA/ghp_/xox/Bearer/JWT）；
 * - 命中必须替换成 `asu.redacted.<hash>` 占位符，且路径/代码/对话正文保留；
 * - 已知限制（V1 不覆盖）：argsText 中段、非串首前缀的凭据不替换——单列记录，
 *   不计为验收通过项，也不掩盖。
 *
 * 运行：npx vitest run tests/integration/redaction.test.ts
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runParse } from '../../src/index.js';
import { ccAssistant, ccPrompt, ccToolResult } from '../fixtures/cc.js';
import { dshJsonl, dshRedactionRecords } from '../fixtures/dsh.js';
import {
  assertOutputInvariants,
  countRedactionPlaceholders,
  findCredentialLeaks,
  loadOutputDir,
  makeTempDir,
  removeTempDir,
  stringAttribute,
  writeCcSessionFile,
  writeDshSessionFile,
} from './helpers.js';

const tempDirs: string[] = [];

function workDir(prefix: string): string {
  const dir = makeTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) removeTempDir(dir);
});

describe('脱敏：落盘字节不得出现真实凭据形态', () => {
  it('DSH 侧：sk-/AKIA/Bearer 与 data.apiKey 全部替换成占位符，正文保留', () => {
    const work = workDir('asu-int-redact-dsh-');
    const dshDir = join(work, 'dsh');
    mkdirSync(dshDir, { recursive: true });
    writeDshSessionFile(dshDir, [dshJsonl(dshRedactionRecords())]);
    const outDir = join(work, 'out');
    expect(runParse([dshDir], outDir).exitCode).toBe(0);

    const files = loadOutputDir(outDir);
    expect(files).toHaveLength(1);
    const file = files[0]!;
    assertOutputInvariants(file);

    // 核心断言：任一泄漏形态出现即失败（不是「恰好没有敏感输入」）。
    expect(findCredentialLeaks(file.text), 'DSH 输出不得泄漏凭据').toEqual([]);
    expect(countRedactionPlaceholders(file.text), '必须真的执行了脱敏').toBeGreaterThan(0);

    // 保留：路径、普通正文、中文。
    expect(file.text).toContain('a.txt');
    expect(file.text).toContain('请保留这段中文');
    const tool = file.spans.find((span) => span.name === 'read_file')!;
    expect(stringAttribute(tool, 'gen_ai.tool.call.arguments')).toBe('{"path":"a.txt"}');

    // 字段名规则命中的值被无条件替换（apiKey）。
    const root = file.spans.find((span) => span.parentSpanId === undefined)!;
    expect(stringAttribute(root, 'asu.events')).toContain('asu.redacted.');
    expect(stringAttribute(root, 'asu.events')).not.toContain('sk-dsh-fixture');
  });

  it('CC 侧：提示/工具结果/助手正文/recordMeta 字段名四类位置都被脱敏', () => {
    const work = workDir('asu-int-redact-cc-');
    const ccDir = join(work, 'cc');
    mkdirSync(ccDir, { recursive: true });
    writeCcSessionFile(ccDir, [
      ccPrompt(
        [
          { type: 'text', text: 'sk-live-ABCDEFGHIJKLMNOPQRSTUVWX' },
          { type: 'text', text: '请保留这段中文' },
          { type: 'text', text: 'JWT eyJhbGciOiJIUzI1NiJ9.payload.signature' },
        ],
        { uuid: 'u1', timestamp: '2026-11-25T03:00:00.000Z', extra: { password: 'hunter2-fixture', note: 'keep note' } },
      ),
      ccAssistant({
        uuid: 'a1',
        messageId: 'msg-1',
        blocks: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: { path: 'a.txt' } }],
        apiBlockIndex: 0,
        usage: { input_tokens: 10, output_tokens: 5 },
        timestamp: '2026-11-25T03:00:01.000Z',
      }),
      ccToolResult('call-1', 'AKIAIOSFODNN7EXAMPLE', {
        uuid: 'u2',
        timestamp: '2026-11-25T03:00:02.000Z',
      }),
      ccAssistant({
        uuid: 'a2',
        messageId: 'msg-2',
        blocks: [
          { type: 'text', text: 'Bearer abcdefghijklmnopqrstuvwx' },
          { type: 'text', text: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
          { type: 'text', text: 'xoxb-1234567890-abcdefghij' },
        ],
        apiBlockIndex: 0,
        usage: { input_tokens: 12, output_tokens: 3 },
        timestamp: '2026-11-25T03:00:03.000Z',
      }),
    ]);
    const outDir = join(work, 'out');
    expect(runParse([ccDir], outDir).exitCode).toBe(0);

    const files = loadOutputDir(outDir);
    expect(files).toHaveLength(1);
    const file = files[0]!;
    assertOutputInvariants(file);

    expect(findCredentialLeaks(file.text), 'CC 输出不得泄漏凭据').toEqual([]);
    expect(countRedactionPlaceholders(file.text)).toBeGreaterThanOrEqual(4);
    expect(file.text).toContain('请保留这段中文');
    expect(file.text).toContain('keep note'); // 普通字段照常保留
    expect(file.text).toContain('a.txt');
    // 字段名 password 的值被替换，字段名本身保留（便于追溯哪里被脱敏）。
    expect(file.text).toContain('password');
    expect(file.text).not.toContain('hunter2-fixture');
  });

  it('同一输入两次解析的占位符哈希稳定（脱敏不掺随机盐）', () => {
    const work = workDir('asu-int-redact-determinism-');
    const dshDir = join(work, 'dsh');
    mkdirSync(dshDir, { recursive: true });
    writeDshSessionFile(dshDir, [dshJsonl(dshRedactionRecords())]);
    const outA = join(work, 'out-a');
    const outB = join(work, 'out-b');
    runParse([dshDir], outA);
    runParse([dshDir], outB);
    const [a] = loadOutputDir(outA);
    const [b] = loadOutputDir(outB);
    expect(a!.text).toBe(b!.text);
    const hashesA = a!.text.match(/asu\.redacted\.[0-9a-f]+/g) ?? [];
    const hashesB = b!.text.match(/asu\.redacted\.[0-9a-f]+/g) ?? [];
    expect(hashesA.length).toBeGreaterThan(0);
    // 占位符哈希由内容决定：两次解析得到完全相同的序列（不掺随机盐）。
    expect(hashesB).toEqual(hashesA);
  });
});

describe('脱敏已知限制（V1 不覆盖，记录而不掩盖）', () => {
  /**
   * DESIGN §8 已声明的已知风险：`gen_ai.tool.call.arguments` 是 JSON 串
   * （以 `{` 开头），而 redactString 只按「整串前缀」匹配凭据，所以写在
   * tool_use.input 里的凭据会原样落盘。
   *
   * 这个用例**证明限制存在**：将来若补齐中段/嵌套脱敏，本用例会转红，
   * 提醒改成正向断言（`findCredentialLeaks === []`）。
   */
  it.fails('已知限制：tool_use.input（argsText 中段）里的凭据未脱敏', () => {
    const work = workDir('asu-int-redact-limit-');
    const ccDir = join(work, 'cc');
    mkdirSync(ccDir, { recursive: true });
    writeCcSessionFile(ccDir, [
      ccPrompt([{ type: 'text', text: '读一下' }], { uuid: 'u1', timestamp: '2026-11-25T03:00:00.000Z' }),
      ccAssistant({
        uuid: 'a1',
        messageId: 'msg-1',
        blocks: [
          {
            type: 'tool_use',
            id: 'call-1',
            name: 'Read',
            input: { apiKey: 'sk-live-ABCDEFGHIJKLMNOPQRSTUVWX' },
          },
        ],
        apiBlockIndex: 0,
        usage: { input_tokens: 10, output_tokens: 5 },
        timestamp: '2026-11-25T03:00:01.000Z',
      }),
    ]);
    const outDir = join(work, 'out');
    expect(runParse([ccDir], outDir).exitCode).toBe(0);
    const [file] = loadOutputDir(outDir);
    // 期望（V1 尚未达到）：这里应当是 []。
    expect(findCredentialLeaks(file!.text)).toEqual([]);
  });
});
