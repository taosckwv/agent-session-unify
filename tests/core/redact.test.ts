import { describe, expect, it } from 'vitest';
import {
  ASU_REDACTED_PREFIX,
  redactObject,
  redactString,
} from '../../src/core/redact.js';
import { hashPlaceholder } from '../../src/core/ids.js';

describe('redactString — 凭据前缀规则（DESIGN §8 规则 1）', () => {
  it.each([
    'sk-abc123',
    'sk-proj-xxxxxxxxxxxxxxxxxxxx',
    'AKIAIOSFODNN7EXAMPLE',
    'ghp_16CharactersXXXXXXXX',
    'xoxb-123456789012-1234567890123',
    'xoxp-...',
    'xoxs-...',
    'xoxa-...',
    'JWT:eyJhbGciOiJIUzI1NiJ9.payload.sig',
    'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
  ])('命中前缀的整个字符串 → 占位符：%s', (input) => {
    const out = redactString(input);
    expect(out).not.toBe(input);
    expect(out.startsWith(`${ASU_REDACTED_PREFIX}.`)).toBe(true);
  });

  it.each([
    'task',
    'Bearer',
    'JWT',
    'xox', // 前缀本身不是完整凭据（连续命中长度 > 4 才动手）
    'sketch-my-code',
    '公钥不是 JWT：JWT 与正文之间有分隔',
  ])('不命中的普通字符串原样返回：%s', (input) => {
    expect(redactString(input)).toBe(input);
  });

  it('同一原文同一占位符（可对账）', () => {
    expect(redactString('sk-same-secret')).toBe(redactString('sk-same-secret'));
  });

  it('不同原文不同占位符', () => {
    expect(redactString('sk-a')).not.toBe(redactString('sk-b'));
  });

  it('占位符形如 asu.redacted.<16hex>，且与 hashPlaceholder 对得上（与 ids 同一套确定性算法）', () => {
    const out = redactString('sk-abc123');
    const m = /^asu\.redacted\.([0-9a-f]{16})$/.exec(out);
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe(hashPlaceholder('sk-abc123'));
  });

  it('替换的是完整原文：占位符里不含任何原文片段', () => {
    const out = redactString('sk-very-secret-material');
    expect(out).not.toContain('sk-');
    expect(out).not.toContain('secret');
    expect(out).not.toContain('material');
  });

  it('空串原样返回', () => {
    expect(redactString('')).toBe('');
  });
});

describe('redactString — 只在字符串开头认前缀（AGENTS：路径/代码/对话正文保留）', () => {
  it('正文里引用前缀字样但非凭据开头时保留原文（最小规则集刻意保守）', () => {
    const text = '请在请求头里加 Authorization: Bearer <token>，token 放配置文件';
    expect(redactString(text)).toBe(text);
  });
});

describe('redactObject — 敏感字段值规则（DESIGN §8 规则 2）', () => {
  it('apiKey/token/password/secret 字段的值被占位符替换（任意大小写、驼峰/下划线/中划线）', () => {
    const obj = {
      apiKey: 'plain-looking-value',
      api_key: 'plain-looking-value',
      'x-apiKey': 'plain-looking-value',
      Token: 'plain-looking-value',
      'auth-token': 'plain-looking-value',
      PASSWORD: 'plain-looking-value',
      nested: { secret: 'inner-secret', ok: 'keep-me' },
      clientSecret: 'cs-123',
    };
    const out = redactObject(obj);
    expect(out.apiKey).not.toBe('plain-looking-value');
    expect(out.api_key).not.toBe('plain-looking-value');
    expect(out['x-apiKey']).not.toBe('plain-looking-value');
    expect(out.Token).not.toBe('plain-looking-value');
    expect(out['auth-token']).not.toBe('plain-looking-value');
    expect(out.PASSWORD).not.toBe('plain-looking-value');
    expect(out.nested.secret).not.toBe('inner-secret');
    expect(out.nested.ok).toBe('keep-me');
    expect(out.clientSecret).not.toBe('cs-123');
  });

  it('敏感字段值已是前缀命中串 → 仍是同一占位符（幂等一致）', () => {
    const obj = { apiKey: 'sk-abc123' };
    expect(redactObject(obj).apiKey).toBe(redactString('sk-abc123'));
  });

  it('字段名命中但值为对象/数组 → 递归整棵值树脱敏', () => {
    const obj = { secret: { token: 'plain', note: 'ok' }, token: ['sk-inner-1', 'ok'] };
    const out = redactObject(obj);
    expect(out.secret.token).not.toBe('plain');
    expect(out.secret.note).toBe('ok');
    expect((out.token as string[])[0]).not.toBe('sk-inner-1');
    expect((out.token as string[])[0]).toBe(redactString('sk-inner-1'));
    expect((out.token as string[])[1]).toBe('ok');
  });

  it('普通字段中的字符串值仍走前缀规则（前缀规则独立生效）', () => {
    const out = redactObject({ body: 'key is sk-abc123 here', normal: 'ok' });
    expect(out.body).toBe('key is sk-abc123 here');
    expect(out.normal).toBe('ok');
  });

  it('不修改输入对象（纯函数，R14）', () => {
    const obj = { apiKey: 'sk-original', nested: { token: 'plain' } };
    const snapshot = JSON.stringify(obj);
    redactObject(obj);
    expect(JSON.stringify(obj)).toBe(snapshot);
  });

  it('数组与嵌套数组递归遍历', () => {
    const arr = [{ apiKey: 'a' }, [{ password: 'b' }], 'sk-in-list'];
    const out = redactObject(arr);
    expect((out as { apiKey: string }[])[0]?.apiKey).not.toBe('a');
    expect(((out as unknown[][])[1] as { password: string }[])[0]?.password).not.toBe('b');
  });

  it('非字符串叶值（数字/布尔/null）原样保留', () => {
    const obj = { token: 123, n: null, b: false, apiKey: true, nested: { secret: 456 } };
    const out = redactObject(obj);
    expect(out).toEqual(obj);
  });
});

describe('redact — 边界与容错', () => {
  it('占位符再次输入不会被二次脱敏（稳定，不嵌套）', () => {
    const once = redactString('sk-abc123');
    expect(redactString(once)).toBe(once);
  });

  it('超长凭据整串替换（不截断规则集，一次性命中）', () => {
    const long = `sk-${'x'.repeat(5000)}`;
    const out = redactString(long);
    expect(out).toMatch(/^asu\.redacted\.[0-9a-f]{16}$/);
  });

  it('循环引用不炸（安全跳过已访问对象）', () => {
    const obj: Record<string, unknown> = { apiKey: 'sk-abc' };
    obj.self = obj;
    expect(() => redactObject(obj)).not.toThrow();
    expect((redactObject(obj) as Record<string, unknown>).apiKey).not.toBe('sk-abc');
  });

  it('Map/Set 原样保留（V1 规则只认普通对象/数组/字符串）', () => {
    const obj = { m: new Map([['token', 'plain']]), s: new Set(['sk-abc']) };
    const out = redactObject(obj) as typeof obj;
    expect(out.m).toBe(obj.m);
    expect(out.s).toBe(obj.s);
  });
});
