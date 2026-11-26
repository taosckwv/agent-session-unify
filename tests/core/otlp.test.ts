/**
 * core/otlp.ts 单元测试（t5 合同）：
 * - 键序固定：golden 精确字符串断言（schema 字段序 + oneof 分支序）；
 * - 字节级确定：同对象两次序列化、structuredClone 后序列化，字节完全一致；
 * - OTLP 语义（R13）：intValue number/string 形态、doubleValue 有限数；
 * - oneof 恰好一分支，违例抛错（编程错误早暴露）；
 * - writeSessionFile：路径形状（R4）、净化、内容字节恰等、嵌套目录创建；
 * - 源码边界：otlp.ts 不得 import redact（§4.4 脱敏唯一入口在组装层）。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SCOPE_NAME,
  serializeTracesData,
  writeSessionFile,
  type Span,
  type TracesData,
} from '../../src/core/otlp.js';

// -- 测试数据工厂 -----------------------------------------------------------

const TRACE_ID = 'a'.repeat(32);
const SPAN_ID = 'b'.repeat(16);
const PARENT_SPAN_ID = 'c'.repeat(16);

function makeSpan(overrides: Partial<Span> = {}): Span {
  return {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    name: 'test-span',
    kind: 'SPAN_KIND_INTERNAL',
    startTimeUnixNano: '1790000000000000000',
    endTimeUnixNano: '1790000000000000001',
    ...overrides,
  };
}

function makeTracesData(spans: Span[]): TracesData {
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'dsh' } }] },
        scopeSpans: [{ scope: { name: SCOPE_NAME }, spans }],
      },
    ],
  };
}

// -- 序列化：键序与精确字节 --------------------------------------------------

describe('serializeTracesData — 键序固定与精确字节', () => {
  it('空 tracesData → {"resourceSpans":[]}', () => {
    expect(serializeTracesData({ resourceSpans: [] })).toBe('{"resourceSpans":[]}');
  });

  it('最小 span：字段序 traceId→spanId→name→kind→startTimeUnixNano→endTimeUnixNano', () => {
    const td = makeTracesData([makeSpan()]);
    expect(serializeTracesData(td)).toBe(
      '{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"dsh"}}]},' +
        `"scopeSpans":[{"scope":{"name":"agent-session-unify"},"spans":[` +
        `{"traceId":"${TRACE_ID}","spanId":"${SPAN_ID}","name":"test-span","kind":"SPAN_KIND_INTERNAL",` +
        '"startTimeUnixNano":"1790000000000000000","endTimeUnixNano":"1790000000000000001"}]}]}]}',
    );
  });

  it('parentSpanId 紧跟 spanId（可选字段仅在存在时输出，位置固定）', () => {
    const td = makeTracesData([makeSpan({ parentSpanId: PARENT_SPAN_ID })]);
    expect(serializeTracesData(td)).toContain(
      `{"traceId":"${TRACE_ID}","spanId":"${SPAN_ID}","parentSpanId":"${PARENT_SPAN_ID}","name":"test-span"`,
    );
  });

  it('属性：key 在前 value 在后；span 无属性时不输出 span.attributes', () => {
    const withAttrs = makeTracesData([
      makeSpan({ attributes: [{ key: 'gen_ai.usage.input_tokens', value: { intValue: 5 } }] }),
    ]);
    expect(serializeTracesData(withAttrs)).toContain(
      '"endTimeUnixNano":"1790000000000000001","attributes":[{"key":"gen_ai.usage.input_tokens","value":{"intValue":5}}]',
    );
    // span 级 attributes 缺省：完整序列化里只有一个 "attributes"（resource 的，恒存在）
    const withoutAttrs = serializeTracesData(makeTracesData([makeSpan()]));
    expect(withoutAttrs).toBe(
      '{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"dsh"}}]},' +
        `"scopeSpans":[{"scope":{"name":"agent-session-unify"},"spans":[` +
        `{"traceId":"${TRACE_ID}","spanId":"${SPAN_ID}","name":"test-span","kind":"SPAN_KIND_INTERNAL",` +
        '"startTimeUnixNano":"1790000000000000000","endTimeUnixNano":"1790000000000000001"}]}]}]}',
    );
    expect((withoutAttrs.match(/"attributes"/g) ?? []).length).toBe(1);
  });

  it('属性值 oneof 分支全形态：string/bool/int(number/string)/double/array/kvlist', () => {
    const span = makeSpan({
      attributes: [
        { key: 'a.str', value: { stringValue: 'hello "quoted"' } },
        { key: 'b.bool', value: { boolValue: true } },
        { key: 'c.int', value: { intValue: 5 } },
        { key: 'd.bigint', value: { intValue: '9007199254740993' } },
        { key: 'e.double', value: { doubleValue: 1.5 } },
        {
          key: 'f.array',
          value: { arrayValue: { values: [{ stringValue: 'x' }, { intValue: 2 }] } },
        },
        {
          key: 'g.kvlist',
          value: {
            kvlistValue: {
              values: [
                { key: 'inner', value: { stringValue: 'v' } },
                { key: 'inner2', value: { boolValue: false } },
              ],
            },
          },
        },
      ],
    });
    expect(serializeTracesData(makeTracesData([span]))).toBe(
      '{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"dsh"}}]},' +
        `"scopeSpans":[{"scope":{"name":"agent-session-unify"},"spans":[` +
        `{"traceId":"${TRACE_ID}","spanId":"${SPAN_ID}","name":"test-span","kind":"SPAN_KIND_INTERNAL",` +
        '"startTimeUnixNano":"1790000000000000000","endTimeUnixNano":"1790000000000000001",' +
        '"attributes":[' +
        '{"key":"a.str","value":{"stringValue":"hello \\"quoted\\""}},' +
        '{"key":"b.bool","value":{"boolValue":true}},' +
        '{"key":"c.int","value":{"intValue":5}},' +
        '{"key":"d.bigint","value":{"intValue":"9007199254740993"}},' +
        '{"key":"e.double","value":{"doubleValue":1.5}},' +
        '{"key":"f.array","value":{"arrayValue":{"values":[{"stringValue":"x"},{"intValue":2}]}}},' +
        '{"key":"g.kvlist","value":{"kvlistValue":{"values":[{"key":"inner","value":{"stringValue":"v"}},{"key":"inner2","value":{"boolValue":false}}]}}}' +
        ']}]}]}]}',
    );
  });

  it('status：无 description 时只输出 code；有则 code→description', () => {
    const withStatus = makeTracesData([
      makeSpan({ status: { code: 'STATUS_CODE_ERROR' } }),
    ]);
    expect(serializeTracesData(withStatus)).toContain(
      ',"status":{"code":"STATUS_CODE_ERROR"}',
    );
    const withDesc = makeTracesData([
      makeSpan({ status: { code: 'STATUS_CODE_ERROR', description: 'boom' } }),
    ]);
    expect(serializeTracesData(withDesc)).toContain(
      ',"status":{"code":"STATUS_CODE_ERROR","description":"boom"}',
    );
  });

  it('scope 带 version 时 name→version 键序', () => {
    const td: TracesData = {
      resourceSpans: [
        {
          resource: { attributes: [] },
          scopeSpans: [{ scope: { name: 'x', version: '1.2.3' }, spans: [] }],
        },
      ],
    };
    expect(serializeTracesData(td)).toBe(
      '{"resourceSpans":[{"resource":{"attributes":[]},"scopeSpans":[{"scope":{"name":"x","version":"1.2.3"},"spans":[]}]}]}',
    );
  });

  it('多 span / 多 scopeSpans 按数组序逗号连接', () => {
    const td = makeTracesData([makeSpan(), makeSpan({ spanId: 'd'.repeat(16) })]);
    const out = serializeTracesData(td);
    expect(out).toContain(`,"spanId":"${SPAN_ID}","name":"test-span"`);
    expect(out).toContain(`,"spanId":"${'d'.repeat(16)}","name":"test-span"`);
    expect((out.match(/"name":"test-span"/g) ?? []).length).toBe(2);
  });

  it('字符串转义走 JSON 规范路径（含中文/控制字符）', () => {
    const span = makeSpan({ attributes: [{ key: 'k', value: { stringValue: '中文\t行' } }] });
    expect(serializeTracesData(makeTracesData([span]))).toContain(
      '{"key":"k","value":{"stringValue":"中文\\t行"}}',
    );
  });
});

// -- 字节级确定性 --------------------------------------------------------------

describe('serializeTracesData — 字节级确定性', () => {
  const td = makeTracesData([
    makeSpan({
      attributes: [
        { key: 'b', value: { intValue: 1 } },
        { key: 'a', value: { stringValue: 'x' } },
      ],
    }),
    makeSpan({
      spanId: 'd'.repeat(16),
      status: { code: 'STATUS_CODE_ERROR' },
    }),
  ]);

  it('同一对象两次序列化字节完全一致', () => {
    expect(serializeTracesData(td)).toBe(serializeTracesData(td));
  });

  it('结构相等的不同对象（structuredClone）序列化字节完全一致', () => {
    expect(serializeTracesData(td)).toBe(serializeTracesData(structuredClone(td)));
  });

  it('反向验证：JSON.parse 后与 JSON.parse(JSON.stringify(td)) deep-equal（语义不漂移）', () => {
    expect(JSON.parse(serializeTracesData(td))).toEqual(JSON.parse(JSON.stringify(td)));
  });
});

// -- 值校验（编程错误早暴露）---------------------------------------------------

describe('serializeTracesData — 值校验', () => {
  it('oneof 零分支抛 TypeError', () => {
    const span = makeSpan({
      // 测试用故意构造非法结构：cast 绕过类型检查
      attributes: [{ key: 'k', value: {} as never }],
    });
    expect(() => serializeTracesData(makeTracesData([span]))).toThrow(TypeError);
  });

  it('oneof 双分支抛 TypeError', () => {
    const span = makeSpan({
      attributes: [
        { key: 'k', value: { stringValue: 'a', boolValue: true } as never },
      ],
    });
    expect(() => serializeTracesData(makeTracesData([span]))).toThrow(TypeError);
  });

  it('intValue number 形态非安全整数抛 RangeError', () => {
    const span = makeSpan({
      attributes: [{ key: 'k', value: { intValue: 9007199254740993 } }],
    });
    expect(() => serializeTracesData(makeTracesData([span]))).toThrow(RangeError);
  });

  it('intValue string 形态非十进制整数抛 TypeError', () => {
    const span = makeSpan({
      attributes: [{ key: 'k', value: { intValue: '12x' } }],
    });
    expect(() => serializeTracesData(makeTracesData([span]))).toThrow(TypeError);
  });

  it('doubleValue NaN 抛 RangeError', () => {
    const span = makeSpan({
      attributes: [{ key: 'k', value: { doubleValue: Number.NaN } }],
    });
    expect(() => serializeTracesData(makeTracesData([span]))).toThrow(RangeError);
  });

  it('intValue 字符串形态合法：大整数（> 2^53）走字符串', () => {
    const span = makeSpan({
      attributes: [{ key: 'k', value: { intValue: '1790000000000000000' } }],
    });
    expect(serializeTracesData(makeTracesData([span]))).toContain(
      '"value":{"intValue":"1790000000000000000"}',
    );
  });
});

// -- writeSessionFile ---------------------------------------------------------

describe('writeSessionFile — 路径与内容', () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'asu-otlp-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      // Windows 下 rmSync 偶发 ENOTEMPTY（句柄延迟释放）→ 重试兜底（t8 审核 L1，t13）
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it('路径形状：<outDir>/<toolName>/<sessionId>__<agentLabel>.json（R4）', () => {
    const outDir = makeTempDir();
    const path = writeSessionFile(outDir, 'dsh', 'sess-1', 'main', '{"x":1}');
    expect(path).toBe(join(outDir, 'dsh', 'sess-1__main.json'));
  });

  it('内容恰为传入 json 的 utf-8 字节（无换行/追加）', () => {
    const outDir = makeTempDir();
    const json = '{"resourceSpans":[]}';
    const path = writeSessionFile(outDir, 'dsh', 'sess-1', 'main', json);
    expect(readFileSync(path, 'utf8')).toBe(json);
  });

  it('同参再次写入覆盖且字节相同（幂等）', () => {
    const outDir = makeTempDir();
    const json = '{"a":2}';
    const p1 = writeSessionFile(outDir, 'claude-code', 's2', 'sidechain-agent1', json);
    const p2 = writeSessionFile(outDir, 'claude-code', 's2', 'sidechain-agent1', json);
    expect(p1).toBe(p2);
    expect(readFileSync(p2, 'utf8')).toBe(json);
  });

  it('危险文件名字符净化为 _（路径层面，内容不管）', () => {
    const outDir = makeTempDir();
    const path = writeSessionFile(outDir, 'dsh', 'a/b\\c:d', 'e f', '{}');
    expect(path).toBe(join(outDir, 'dsh', 'a_b_c_d__e_f.json'));
  });

  it("'.' 与 '..' 前缀加下划线防路径穿越", () => {
    const outDir = makeTempDir();
    const path = writeSessionFile(outDir, 'dsh', '..', 'main', '{}');
    expect(path).toBe(join(outDir, 'dsh', '_..__main.json'));
    const path2 = writeSessionFile(outDir, 'dsh', '.', 'main', '{}');
    expect(path2).toBe(join(outDir, 'dsh', '_.__main.json'));
  });

  it('嵌套输出目录自动创建', () => {
    const outDir = join(makeTempDir(), 'nested', 'deep');
    const path = writeSessionFile(outDir, 'dsh', 'sess', 'main', '{}');
    expect(readFileSync(path, 'utf8')).toBe('{}');
  });
});

// -- 源码边界（§4.4 脱敏唯一入口）----------------------------------------------

describe('源码边界 — otlp.ts 不 import redact', () => {
  it('otlp.ts 源码里没有 redact import（import 语句行内不出现 redact）', () => {
    const source = readFileSync(
      new URL('../../src/core/otlp.ts', import.meta.url),
      'utf8',
    );
    const importLines = source
      .split('\n')
      .filter((line) => /^\s*import\b/.test(line));
    for (const line of importLines) {
      expect(line).not.toMatch(/redact/);
    }
  });
});
