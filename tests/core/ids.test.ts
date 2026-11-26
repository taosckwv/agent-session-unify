import { describe, expect, it } from 'vitest';
import {
  PLACEHOLDER_HASH_HEX_LENGTH,
  SPAN_ID_HEX_LENGTH,
  TRACE_ID_HEX_LENGTH,
  deriveSpanId,
  deriveTraceId,
  hashPlaceholder,
  sessionKey,
  sessionSpanPath,
  sha256Hex,
  stepSpanPath,
  toolSpanPath,
  turnSpanPath,
} from '../../src/core/ids.js';

describe('sha256Hex', () => {
  it('空串的已知向量（锚定算法确实是 sha256）', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('abc 的已知向量', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('小写 hex、64 位', () => {
    expect(sha256Hex('asu')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('deriveTraceId', () => {
  it('OTLP 要求的 32 位小写 hex（16 字节）', () => {
    expect(deriveTraceId('sess-1')).toMatch(/^[0-9a-f]{32}$/);
    expect(deriveTraceId('sess-1').length).toBe(TRACE_ID_HEX_LENGTH);
  });

  it('确定性：同一 sessionId 两次派生相同', () => {
    expect(deriveTraceId('sess-1')).toBe(deriveTraceId('sess-1'));
  });

  it('不同 sessionId 得到不同 trace_id', () => {
    expect(deriveTraceId('sess-1')).not.toBe(deriveTraceId('sess-2'));
  });

  it('同一 session_id（主/子 agent 各自成文件）共用同一 trace（DESIGN §3.1 跨文件父子引用的前提）', () => {
    expect(deriveTraceId('shared-sess')).toBe(deriveTraceId('shared-sess'));
  });
});

describe('deriveSpanId', () => {
  const key = sessionKey('sess-1', 'main');

  it('OTLP 要求的 16 位小写 hex（8 字节）', () => {
    expect(deriveSpanId(key, sessionSpanPath())).toMatch(/^[0-9a-f]{16}$/);
    expect(deriveSpanId(key, sessionSpanPath()).length).toBe(SPAN_ID_HEX_LENGTH);
  });

  it('确定性：同一 key + 路径两次派生相同', () => {
    expect(deriveSpanId(key, turnSpanPath(0))).toBe(deriveSpanId(key, turnSpanPath(0)));
  });

  it('不同路径得到不同 span_id', () => {
    expect(deriveSpanId(key, turnSpanPath(0))).not.toBe(deriveSpanId(key, turnSpanPath(1)));
    expect(deriveSpanId(key, stepSpanPath(0, 0))).not.toBe(deriveSpanId(key, stepSpanPath(1, 0)));
  });

  it('同一 session 下不同 agent 不撞 span_id（DESIGN §3.1：同 session_id 不同 agent 各自成文件、同 trace）', () => {
    expect(deriveSpanId(sessionKey('s', 'main'), turnSpanPath(0))).not.toBe(
      deriveSpanId(sessionKey('s', 'sub-agent-1'), turnSpanPath(0)),
    );
  });

  it('非法序号（负数/非整数/NaN）直接抛错，不静默产出错误路径', () => {
    expect(() => turnSpanPath(-1)).toThrow();
    expect(() => stepSpanPath(0, 1.5)).toThrow();
    expect(() => toolSpanPath(0, 0, Number.NaN)).toThrow();
  });
});

describe('hashPlaceholder', () => {
  it('16 位小写 hex', () => {
    expect(hashPlaceholder('secret-value')).toMatch(/^[0-9a-f]{16}$/);
    expect(hashPlaceholder('secret-value').length).toBe(PLACEHOLDER_HASH_HEX_LENGTH);
  });

  it('同一原文同一 hash（同一原文同一占位符的根基，DESIGN §8）', () => {
    expect(hashPlaceholder('secret-value')).toBe(hashPlaceholder('secret-value'));
  });

  it('不同原文不同 hash', () => {
    expect(hashPlaceholder('a')).not.toBe(hashPlaceholder('b'));
  });
});

describe('域分隔', () => {
  it('同一文本走不同用途（trace/span/占位符）得到互不相同的 id', () => {
    const s = 'same-seed';
    const trace = deriveTraceId(s);
    const span = deriveSpanId(sessionKey(s, 'main'), turnSpanPath(0));
    const ph = hashPlaceholder(s);
    expect(new Set([trace, span, ph]).size).toBe(3);
  });
});

describe('sessionKey', () => {
  it('格式 <sessionId>__<agentLabel>（与输出文件名同一约定，DESIGN §3.1）', () => {
    expect(sessionKey('abc123', 'main')).toBe('abc123__main');
    expect(sessionKey('abc123', 'sub-agent-1')).toBe('abc123__sub-agent-1');
  });
});

describe('span 路径派生', () => {
  it('各层路径字面量', () => {
    expect(sessionSpanPath()).toBe('session');
    expect(turnSpanPath(3)).toBe('turn/3');
    expect(stepSpanPath(3, 2)).toBe('turn/3/step/2');
    expect(toolSpanPath(3, 2, 1)).toBe('turn/3/step/2/tool/1');
  });

  it('层间前缀关系（父层路径是子层路径的前缀）', () => {
    expect(stepSpanPath(1, 2).startsWith(`${turnSpanPath(1)}/`)).toBe(true);
    expect(toolSpanPath(1, 2, 0).startsWith(`${stepSpanPath(1, 2)}/`)).toBe(true);
  });
});

describe('确定性总闸（DESIGN §10：不掺当前时间与随机数）', () => {
  it('连续两批派生结果完全一致', () => {
    const batchA = [
      deriveTraceId('sess-x'),
      deriveSpanId(sessionKey('sess-x', 'main'), sessionSpanPath()),
      deriveSpanId(sessionKey('sess-x', 'main'), stepSpanPath(0, 0)),
      deriveSpanId(sessionKey('sess-x', 'main'), toolSpanPath(0, 0, 0)),
      hashPlaceholder('some-credential'),
    ];
    const batchB = [
      deriveTraceId('sess-x'),
      deriveSpanId(sessionKey('sess-x', 'main'), sessionSpanPath()),
      deriveSpanId(sessionKey('sess-x', 'main'), stepSpanPath(0, 0)),
      deriveSpanId(sessionKey('sess-x', 'main'), toolSpanPath(0, 0, 0)),
      hashPlaceholder('some-credential'),
    ];
    expect(batchA).toEqual(batchB);
  });
});
