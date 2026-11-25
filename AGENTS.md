# AGENTS.md

给在本仓库工作的 agent 的约定。人类贡献者同样适用。

## 项目约定

- 两条线：A 线解析原始会话，B 线重建每一步请求。A 线为准，B 线用于核对与补齐。
- DSH 的日志里没有完整 messages，必须回放重建；Claude Code 与 Codex 视版本而定。
- 版本判定按记录级，不按文件级，也不要用本机安装的程序版本反推历史文件。
- 认不出来的事件、字段、版本：原样保留并标记，禁止丢弃，禁止用 0 或空值填充缺失值。

## 数据纪律

- 仓库里**不允许**出现真实会话文件、抓包文件、任何真实凭据。
- 样本一律脱敏后再入库，或放本地 `data/`（已在 .gitignore）。
- 输出里凭据替换成占位符；路径、代码、对话正文保留。

## 参考仓库（repos/）

要借鉴的上游项目浅克隆在 `repos/<owner>/<repo>/`。**只读资料，不属于本仓库**：

- **不修改**：不编辑、不格式化、不打补丁、不切分支，也不在里面安装依赖或跑构建（都会改动它的文件）。
- **不引用**：本仓库的代码、依赖、构建、测试、lint 都不许 import / require / 指向 `repos/` 下的文件；`tsconfig.json`、`vitest.config.ts` 只覆盖 `src/`、`tests/`，保持这样。
- **怎么借鉴**：读懂上游的做法，按本仓库的约定重新写；在提交信息或代码注释里写清出处（`owner/repo` + 文件路径），不要整段复制。
- 要拿上游程序做对照实验，先问用户，同意了再动。
- `repos/` 已在 `.gitignore`，不入库，也不是 git 子模块。

上游快照（2026-11-25 浅克隆 `--depth 1`，记 HEAD 便于追溯）：

| 仓库 | HEAD |
|---|---|
| ZH-TX3/trajectory-viewer | 5161f31 |
| alibaba/loongsuite-pilot | 3d9f44c |
| doit2020s/ai-session-viewer-grok-dsh | 0a0392b |
| jwilson411/dsh-otel | 7a0d922 |
| linyp/dsh-plugin-langfuse | 5fc5f6b |
| loongsuite/dsh-plugin | f44ccfc |
| PerryLink/dsh-observe | 17a31f2 |
| Yuntwo/dsh-langfuse-plugin | a30098d |

## 代码约定

- 优先复用已知实现的思路（见 docs/RESEARCH.md 第 6 节与 `repos/`），按本仓库的约定重写，缺的部分自己补；不直接引用或整体复制上游代码。
- 解析器必须对坏行、撕裂尾帧、未知事件容错：跳过并计数，不抛异常中断整份文件。
- 相同输入解析两次必须得到相同结果（确定性输出，时间戳取事件自带时间）。

## 提交

- 提交信息用中文或英文皆可，首行不超过 72 字符，说明「做了什么」。
- 不提交 `data/`、`repos/`、任何 `*.jsonl` / `*.zst` 会话文件、`.env`。