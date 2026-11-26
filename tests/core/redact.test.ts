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

describe('redactString — 前缀凭据：整串形态（规则 ①）与正文 token 形态（规则 ③f）', () => {
  it('正文里引用前缀字样但没有凭据体时保留原文（保守，不误杀）', () => {
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

describe('redactString — 自由文本口令（规则 ③，2026-11-26 真实案例）', () => {
  const SECRET = 'eds@1234sangfornetwork';
  const PLACEHOLDER = `${ASU_REDACTED_PREFIX}.${hashPlaceholder(SECRET)}`;

  it('关键词赋值：标签保留、口令换成占位符（对话正文原样其余部分）', () => {
    const out = redactString(`ssh root@10.1.1.1\n密码：${SECRET}`);
    expect(out).toBe(`ssh root@10.1.1.1\n密码：${PLACEHOLDER}`);
    expect(out).not.toContain(SECRET);
  });

  it.each([
    [`password: ${SECRET}`, `password: ${PLACEHOLDER}`],
    [`口令是 ${SECRET}，记得改`, `口令是 ${PLACEHOLDER}，记得改`],
    [`"pwd": "${SECRET}"`, `"pwd": "${PLACEHOLDER}"`],
    [`密码=${SECRET}`, `密码=${PLACEHOLDER}`],
  ])('关键词/标点变体都能认（%s）', (input, expected) => {
    expect(redactString(input)).toBe(expected);
  });

  it('sshpass -p / 命令行参数 / 连接串 userinfo 都脱口令', () => {
    expect(redactString(`sshpass -p '${SECRET}' ssh root@10.1.1.1`)).toBe(
      `sshpass -p '${PLACEHOLDER}' ssh root@10.1.1.1`,
    );
    expect(redactString('deploy --token=abcdef123456 --password="hello1234"')).toBe(
      `deploy --token=${ASU_REDACTED_PREFIX}.${hashPlaceholder('abcdef123456')} ` +
        `--password="${ASU_REDACTED_PREFIX}.${hashPlaceholder('hello1234')}"`,
    );
    expect(redactString('mysql://root:MyPass123@db.internal:3306/app')).toBe(
      `mysql://root:${ASU_REDACTED_PREFIX}.${hashPlaceholder('MyPass123')}@db.internal:3306/app`,
    );
  });

  it('裸密码形态（字母@数字、@ 后无点）即使没有关键词也脱口令', () => {
    const out = redactString(`把 ${SECRET} 这串贴过来`);
    expect(out).toBe(`把 ${PLACEHOLDER} 这串贴过来`);
  });

  it('同一口令同一占位符（可对账；与已验证的 hash 算法一致）', () => {
    const a = redactString(`密码：${SECRET}`);
    const b = redactString(`password is not matched but 密码：${SECRET}`);
    expect(a).toContain(PLACEHOLDER);
    expect(b).toContain(PLACEHOLDER);
  });

  it('幂等：再脱一次不变', () => {
    const once = redactString(`密码：${SECRET}`);
    expect(redactString(once)).toBe(once);
  });

  it.each([
    ['密码是错的'], // 无 ASCII 字母，不是凭据形态
    ['password: required'], // 值不像凭据
    ['user@example.com'], // 邮箱：@ 后有点
    ['root@10.1.1.1'], // 用户名@主机：@ 后有点
    ['邮箱 a@123.com 保留'], // 邮箱前缀形似口令，但后面跟点，不误杀
    ['请把 token 放进配置文件'], // 无锚点、无值
  ])('不像凭据的正文原样保留（%s）', (input) => {
    expect(redactString(input)).toBe(input);
  });

  it('占位符不含任何原文片段（脱敏的是口令本身）', () => {
    const out = redactString(`密码：${SECRET}`);
    expect(out).not.toContain('eds@');
    expect(out).not.toContain('sangfornetwork');
    expect(out).toContain(ASU_REDACTED_PREFIX);
  });

  it('已知前缀的凭据粘在正文里也脱口令（sk-/ghp_/Bearer）', () => {
    const sk = 'sk-liveabcdefghijklmnop1234';
    expect(redactString(`the key is ${sk} ok`)).toBe(
      `the key is ${ASU_REDACTED_PREFIX}.${hashPlaceholder(sk)} ok`,
    );
    const gh = `ghp_${'a'.repeat(36)}`;
    const ghOut = redactString(`token ${gh}`);
    expect(ghOut).not.toContain(gh);
    expect(ghOut).toContain(ASU_REDACTED_PREFIX);
    const bearer = 'Bearer eyJhbGciOiJIUzI1NiJ9.abcdefg';
    const bearerOut = redactString(`Authorization: ${bearer}`);
    expect(bearerOut.startsWith(`Authorization: Bearer ${ASU_REDACTED_PREFIX}.`)).toBe(true);
    expect(bearerOut).not.toContain('eyJhbGci');
  });

  it('模板插值与文档占位不当字面口令（配置正文原样保留）', () => {
    const dsn =
      'postgres://${DB_USER:-vs_pg_admin}:${DB_PASSWORD:?未设置：请先在 .env 中填写数据库口令}@postgres:5432/db';
    expect(redactString(dsn)).toBe(dsn);
    const envLine =
      '      DB_PASSWORD: ${DB_PASSWORD:?未设置：请先在 .env 中填写数据库口令（键名见 .env.example）}';
    expect(redactString(envLine)).toBe(envLine);
    expect(redactString('deploy --token <jwt> --password <password>')).toBe(
      'deploy --token <jwt> --password <password>',
    );
    expect(redactString("sshpass -p '<password>' ssh root@host")).toBe(
      "sshpass -p '<password>' ssh root@host",
    );
  });

  it('带引号的纯字母口令也脱敏（锚点+引号已足够定性）', () => {
    expect(redactString('DB_PASSWORD: "sangfornetwork"')).toBe(
      `DB_PASSWORD: "${ASU_REDACTED_PREFIX}.${hashPlaceholder('sangfornetwork')}"`,
    );
    // 纯中文值没有 ASCII 字母，仍按正文保留
    expect(redactString('密码："请输入正确密码"')).toBe('密码："请输入正确密码"');
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
