# 14 · P0-SEC-01-FIX1 交付报告

> 状态：**DEVELOPMENT_DELIVERED / PENDING_INDEPENDENT_AUDIT**
> 本报告是开发方自述，不构成验收结论。最终判定由 Agent 2 依据冻结契约作出。

## 0. 契约归档（GOV-01）

| 项 | 值 |
|---|---|
| 契约文件 | `docs/contracts/p0-sec-01-ac-v1.0.md`（逐字保存） |
| SHA-256 | `fc2c9f0de0552bd5531022cf4c66fb3c51beb3aaba3631e58e4924a8a8f0d560` |
| 字节 / 行 | 20978 / 1071 |
| 条目计数 | AC 22 · E2E 10 · EV 15 |
| Manifest | `docs/contracts/p0-sec-01-ac-v1.0.manifest.json`（与原文分离） |

上一轮的 `docs/12-p0-sec-01-ac.md`（11 项）是我起草的不完整版本，保留但不再作为依据。

## 1. 基线与提交

| 项 | 值 |
|---|---|
| 开发基线 | `4333e82` |
| 上一轮版本 | `42bf5dc`（本分支的父提交） |
| 本分支 | `fix/p0-sec-01-fix1` |
| 目标 Commit | 见提交后的 `git rev-parse HEAD` |

## 2. DEF 修复映射

| 缺陷 | 状态 | 说明 |
|---|---|---|
| DEF-01 统一裁决 | **已实现** | `security.mjs:computeVerdict`；`service.mjs:finalizeAttempt` 统一写 Task/Execution；执行器成功但校验失败 → `failed` |
| DEF-02 取消与状态竞态 | **部分** | 增加 `running/verifying/committing` 状态与提交前检查点；**未实现** SIGTERM→SIGKILL 升级 |
| DEF-03 文件系统隔离 | **受阻** | 已写 `isolation.mjs`（Docker 适配 + 实际探测）；**Docker 未安装**，写模式 fail closed |
| DEF-04 可信审批来源 | **部分** | 改为交互式 TTY + 显式 `APPROVE` 确认；删除 `operator init --force`；密钥文件不再作为身份 |
| DEF-05 新旧审批冲突 | **已实现** | 执行器只认 `approvals` 表；`approved_at` 不再授权高危执行；普通工作流审批保留 |
| DEF-06 入口契约一致 | **已实现** | CLI 不再传 `approved/verify/allowedTools`；MCP 白名单字段；同源校验函数 |
| DEF-07 隔离工作树与提交来源 | **未实现** | 仍直接使用 cwd；无 worktree、无初始干净校验 |
| DEF-08 授权贯穿全链 | **部分** | 提交前重新查审批与取消状态；启动前只查一次 |
| DEF-09 证据持久化 | **已实现** | 拒绝也写 `executions`（status=rejected + phase/blocked），并写 events |

## 3. 测试

```bash
~/.openclaw/tools/node/bin/node --test orchestrator/test/*.test.mjs
```

```text
tests 44 / pass 44 / fail 0
```

- `smoke.test.mjs` 7：既有能力回归
- `parse.test.mjs` 4：JSON 解析
- `security.test.mjs` 17：AC-01/02/03/04/05/07/08/10 负向
- `fix1.test.mjs` 13：裁决、隔离 fail-closed、拒绝证据、TTY 审批、字段白名单

## 4. AC 自评（开发方视角，非验收结论）

| AC | 自评 | 依据 |
|---|---|---|
| AC-01 固定版本 | 满足 | 分支自 `42bf5dc`，未动 main |
| AC-02 MCP 不得提供 Shell | 满足 | 字段白名单 + 单元测试 |
| AC-03 命令注入 | 满足 | `execFile(program, argv, shell:false)` + 拒绝 shell 程序 |
| AC-04 可信校验配置 | 满足 | 登记制 + 未知 id 拒绝 |
| AC-05 真实人工审批 | **部分** | TTY 确认可用，但未做 AC-05-E 的真实通过验证（需终端） |
| AC-06 审批内容绑定 | 满足 | 摘要含 cwd/mode/profile/commit/paths |
| AC-07 过期与重放 | 满足 | 过期/已用/跨任务摘要不匹配 |
| AC-08 入口共用门禁 | 满足 | CLI/MCP/Workflow 共用 `resolveExecutorPlan` |
| AC-09 项目目录限制 | 满足 | realpath + 前缀 |
| AC-10 穿越与符号链接 | 满足 | 测试覆盖 |
| AC-11 执行器真实权限 | **WAITING** | 无 Docker，无真实隔离证据 |
| AC-12 合法写入正向 | **WAITING** | 同上；写模式当前 fail closed |
| AC-13 测试失败阻断提交 | **部分** | 逻辑已实现并有单元测试，**无真实 Claude Code 证据** |
| AC-14 缺少校验不提交 | 满足 | 单元测试 |
| AC-15 提交范围 | **部分** | 只 add 声明路径；**未实现工作树干净校验** |
| AC-16 成功提交证据 | **WAITING** | 需真实写链路 |
| AC-17 取消不产生副作用 | **部分** | 检查点已加；无真实竞态证据 |
| AC-18 取消失败不虚报 | 部分 | `cancel_requested`；未做 SIGKILL 升级 |
| AC-19 并发保护 | 满足 | 原子状态转换 |
| AC-20 暂停/失败/重启 | 部分 | 状态门禁存在；未做重启场景实测 |
| AC-21 证据完整性 | 满足 | 拒绝记录 + 执行记录 |
| AC-22 无回归 | 满足 | 44 项测试 + MCP 实测 |

## 5. E2E 状态

| E2E | 状态 |
|---|---|
| E2E-01 未授权 Shell 拒绝 | 有单元证据 |
| E2E-02 伪造审批拒绝 | 有单元证据 |
| E2E-03 真实审批合法执行 | **WAITING**（无 Docker） |
| E2E-04 测试失败阻断提交 | **WAITING**（无真实写链路） |
| E2E-05 无关文件不入提交 | 部分（路径白名单单测） |
| E2E-06 跨项目/路径逃逸 | 有单元证据 |
| E2E-07 取消竞态 | **WAITING** |
| E2E-08 Workflow 绕过 | 有单元证据 |
| E2E-09 审批绑定与重放 | 有单元证据 |
| E2E-10 非编程工作流回归 | 未在本轮执行（上一轮有真实记录） |

## 6. 阻断项

**Docker 未安装**（`/Applications/Docker.app` 不存在，`docker` 命令缺失）。
隔离层只能做探测与 fail closed，无法提供 AC-11 / AC-12 / AC-16 所需的真实证据。
按契约要求，写模式保持关闭，不宣称「已安全可用」。

**DEF-07 未实现**：提交仍发生在任务 cwd，没有独立工作树，也没有初始干净校验。

## 7. 已知限制

1. TTY 确认不是操作系统级身份认证；同一用户的其它进程理论上可以伪造 TTY 环境，但 Agent 没有 shell、MCP 无 TTY。
2. 无 SIGKILL 升级，忽略 SIGTERM 的进程只能标记 `cancel_requested`。
3. 隔离镜像（`JARVIS_EXECUTOR_IMAGE`）尚无构建脚本。

## 8. 回滚

```bash
git checkout fix/p0-sec-01        # 回到上一轮版本
git branch -D fix/p0-sec-01-fix1  # 丢弃本分支（未推送时）
```

数据库为增量迁移（新增 `verify_profiles` / `approvals` 表与任务列），旧代码可继续运行。
