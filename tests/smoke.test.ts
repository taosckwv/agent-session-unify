import { describe, expect, it } from 'vitest';

import { VERSION } from '../src/index.js';

describe('脚手架', () => {
  it('导出版本号', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('解析器尚未实现时也应能导入', async () => {
    await expect(import('../src/index.js')).resolves.toBeTruthy();
  });
});