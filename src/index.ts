/**
 * 入口占位。A 线解析器与 B 线重建尚未实现，见 docs/RESEARCH.md。
 */
export const VERSION = '0.1.0';

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  console.log(`agent-session-unify ${VERSION} — 解析器尚未实现`);
}